import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MT5_URL, svcHeaders, spreadFor } from "@/lib/svc";
import { buildBoardContext } from "@/lib/market/board";
import { chatComplete, getAiSettings } from "@/lib/ai/llm";
import { sdkVisionComplete, gateHealth } from "@/lib/ai/gate";
import { modelById } from "@/lib/ai/registry";
import { getNewsRadar } from "@/lib/ai/tower";
import type { Candle } from "@/lib/market/types";

/**
 * /api/ai/chat — the AI CHAT BOX backend (v24.0 · VISION + FULL APP STATE).
 *
 *   GET    ?thread                → message history (oldest → newest, last 60)
 *   POST   { thread, message, model?, image?, appState? } → one assistant reply
 *   DELETE ?thread                → clear the thread
 *
 * v24 — the AI can now SEE:
 *   · the client attaches a live SCREENSHOT of the chart (candles + drawings
 *     composited) and a full APP-STATE snapshot (tab, symbol, tf, layers,
 *     board decision, engine health) with every message;
 *   · the screenshot is analyzed by the VLM first (priority queue, 429-safe),
 *     and the description + app state + live market JSON all ground the
 *     reply — so "চার্টটা দেখতে পারো?" gets "হ্যাঁ — এখন যা দেখছি: …" with
 *     the actual visible structure;
 *   · chat calls run with TOP priority through the gate — they jump ahead of
 *     AI Board meetings, so the user's chat is effectively unlimited: worst
 *     case it waits a few seconds in a visible queue.
 */

export const runtime = "nodejs";
export const maxDuration = 90;

const HISTORY_LIMIT = 60;
const CONTEXT_MESSAGES = 14;
const MAX_IMAGE_BYTES = 1_400_000; // ~1.4MB data-URL guard

function cleanThread(v: string | undefined | null): string {
  return (v ?? "XAUUSDm").trim().slice(0, 24) || "XAUUSDm";
}

async function fetchCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000), headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.bars ?? []) as Candle[];
  } catch {
    return [];
  }
}

async function fetchDigits(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${MT5_URL}/api/symbols`, {
      cache: "no-store", signal: AbortSignal.timeout(4_000), headers: svcHeaders(),
    });
    if (!res.ok) return 2;
    const j = await res.json();
    return j?.list?.find((s: { name: string }) => s.name === symbol)?.digits ?? 2;
  } catch {
    return 2;
  }
}

// ── GET: history ──

export async function GET(req: Request) {
  const url = new URL(req.url);
  const thread = cleanThread(url.searchParams.get("thread"));
  const rows = await db.chatMessage.findMany({
    where: { threadId: thread },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  }).catch(() => []);
  const messages = rows
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      model: m.model,
      createdAt: m.createdAt.toISOString(),
    }));
  return NextResponse.json({ thread, messages }, { headers: { "Cache-Control": "no-store" } });
}

// ── DELETE: clear ──

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const thread = cleanThread(url.searchParams.get("thread"));
  await db.chatMessage.deleteMany({ where: { threadId: thread } }).catch(() => {});
  return NextResponse.json({ ok: true });
}

/** what the VLM looks for when it reads the chart screenshot */
function visionPrompt(symbol: string, tf: string): string {
  return (
    `You are the EYES of AURUM AI, attached to a live MetaTrader 5 terminal. ` +
    `This is a real screenshot of the ${symbol} ${tf} candlestick chart the user is looking at RIGHT NOW ` +
    `(green/red candles = up/down, gold dashed lines = EMA, colored zones/rectangles = supply/demand or order blocks, ` +
    `lines and markers = the user's drawings and AI signal markers, the right scale shows prices). ` +
    `Read it like a senior chart analyst and report ONLY what you actually see, concretely: ` +
    `(1) overall trend direction and maturity, (2) the most recent 5-10 candles' behavior (momentum, wicks, consolidation), ` +
    `(3) any visible structure: swing highs/lows, ranges, channels, patterns (double top/bottom, head & shoulders, flags), ` +
    `(4) visible zones/levels and where price sits relative to them, (5) indicator reads (EMA position/crossovers), ` +
    `(6) anything unusual (gaps, spikes, long wicks, marking clusters). ` +
    `Quote approximate visible price levels from the right-hand scale when relevant. ` +
    `Be factual — do NOT invent things that are not on the chart. Tight bullet list, max 160 words.`
  );
}

// ── POST: one grounded, SEEING reply ──

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const thread = cleanThread(body?.thread);
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const settings = await getAiSettings();
  const modelId = typeof body?.model === "string" && modelById(body.model) ? body.model : settings.chatModel;

  // v24 — optional chart screenshot + app-state snapshot from the client
  const image = typeof body?.image === "string" && body.image.startsWith("data:image/") ? body.image : null;
  const appStateRaw = body?.appState && typeof body?.appState === "object" ? body.appState : null;

  // ── live market context (the same read the board gets) ──
  const [bars, digits, spread, newsRadar, latestBoard] = await Promise.all([
    fetchCandles(thread, "M15", 300),
    fetchDigits(thread),
    spreadFor(thread),
    getNewsRadar(thread).catch(() => null),
    db.boardSession.findFirst({
      where: { symbol: thread },
      orderBy: { createdAt: "desc" },
    }).catch(() => null),
  ]);

  let marketBlock = "Market data unavailable right now.";
  try {
    const closed = bars.filter((b) => !b.f);
    if (closed.length >= 60) {
      const ctx = buildBoardContext(thread, "M15", { M15: closed }, spread, digits, {
        balance: null, engineSignal: null, recentBoard: [],
        newsHeadlines: newsRadar?.headlines ?? [],
      });
      const boardLine = latestBoard
        ? `Latest AI Board decision (${latestBoard.timeframe}, ${new Date(latestBoard.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC): ${latestBoard.action}` +
          (latestBoard.action !== "HOLD" && latestBoard.entry != null
            ? ` entry ${latestBoard.entry} / SL ${latestBoard.sl} / TP ${latestBoard.tp} / RR ${latestBoard.rr ?? "-"} / consensus ${latestBoard.consensus}%`
            : "")
        : "No board decision yet.";
      marketBlock =
        `LIVE MARKET SNAPSHOT (closed bars only):\n${JSON.stringify(ctx.json)}\n\n` +
        `AI BOARD: ${boardLine}\n` +
        `NEWS RADAR: ${newsRadar?.headlines?.length ? newsRadar.headlines.join(" | ") : "no live headlines"}`;
    }
  } catch {
    /* keep the unavailable block */
  }

  // ── VISION: let the AI actually SEE the chart (priority call, 429-safe) ──
  let visionBlock = "";
  let sawChart = false;
  if (image && image.length <= MAX_IMAGE_BYTES) {
    const v = await sdkVisionComplete({
      imageDataUrl: image,
      prompt: visionPrompt(thread, typeof appStateRaw?.timeframe === "string" ? appStateRaw.timeframe : "M15"),
      timeoutMs: 40_000,
    });
    if (v.ok && v.content.trim()) {
      sawChart = true;
      visionBlock =
        `\n\nWHAT YOU SEE ON THE USER'S CHART RIGHT NOW (your own vision read of the live screenshot):\n${v.content.trim()}\n` +
        `→ When the user asks whether you can see the chart, the answer is YES — describe what is above as your own observation.`;
    }
    // vision failing NEVER blocks the chat — text context still grounds it
  }

  // ── APP STATE: what the whole app is doing right now ──
  let appStateBlock = "";
  if (appStateRaw) {
    const slim = {
      activeTab: appStateRaw.activeTab ?? null,
      chartView: appStateRaw.chartView ?? null,
      symbol: appStateRaw.symbol ?? thread,
      timeframe: appStateRaw.timeframe ?? "M15",
      layersOn: Array.isArray(appStateRaw.layersOn) ? appStateRaw.layersOn : [],
      drawingsCount: typeof appStateRaw.drawingsCount === "number" ? appStateRaw.drawingsCount : 0,
      autoBoard: typeof appStateRaw.autoBoard === "boolean" ? appStateRaw.autoBoard : null,
      boardStats: appStateRaw.boardStats ?? null,
      openSignals: typeof appStateRaw.openSignals === "number" ? appStateRaw.openSignals : null,
      engine: (() => {
        const h = gateHealth();
        return {
          status: h.coolingDown ? "cooling" : "live",
          queueWaiting: h.queuedBehind,
          servedChat: h.stats.servedChat,
          servedVision: h.stats.servedVision,
          servedBoard: h.stats.servedBoard,
        };
      })(),
    };
    appStateBlock =
      `\n\nTHE APP'S OWN STATE RIGHT NOW (the terminal the user is looking at):\n${JSON.stringify(slim)}\n` +
      `→ Use this to answer questions about the app itself ("অ্যাপে কোথায় সমস্যা?", "board কি চলছে?") — you know the active tab, layers, board stats and engine health.`;
  }

  const system =
    "You are AURUM AI — the assistant of the AURUM Terminal, a live XAUUSD/forex trading terminal on MetaTrader 5. " +
    "You are talking to the terminal's owner. " +
    (sawChart
      ? "You CAN see the user's live chart — a screenshot was just captured and your vision read of it is included below. "
      : "No chart screenshot is attached this time (say so plainly if asked whether you can see the chart). ") +
    "You also receive a LIVE market snapshot and the app's own state — USE THEM: quote exact prices, zones, patterns and board decisions instead of generic advice. " +
    "Rules: (1) Reply in the SAME language the user writes in — if they write বাংলা, reply in বাংলা with trading terms in English. " +
    "(2) Be concrete and brief: levels, distances in ATR, RR — no fluff. " +
    "(3) You are an analyst, not a guarantee: when suggesting entries, always include the invalidation (SL) and a one-line risk note. " +
    "(4) When describing the chart, blend what you SEE with the live data — visible structure + exact numbers. " +
    "(5) Markdown allowed (bold, lists), keep it tight for a chat box.\n\n" +
    marketBlock + visionBlock + appStateBlock;

  // ── history (last N turns) + the new message ──
  const historyRows = await db.chatMessage.findMany({
    where: { threadId: thread },
    orderBy: { createdAt: "desc" },
    take: CONTEXT_MESSAGES,
  }).catch(() => []);
  const history = historyRows
    .slice()
    .reverse()
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

  const userRow = await db.chatMessage.create({
    data: { threadId: thread, role: "user", content: message, model: modelId },
  }).catch(() => null);

  const reply = await chatComplete({
    modelId,
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: message },
    ],
    // v24 — generous budget + TOP priority: the gate serializes, spaces and
    // 429-retries inside this budget, and chat jumps ahead of board meetings.
    timeoutMs: 70_000,
    temperature: 0.5,
    maxTokens: 1100,
    kind: "chat",
  });

  if (!reply.ok) {
    const friendly =
      reply.code === "RATE_LIMITED"
        ? "ইঞ্জিন একটু ব্যস্ত — মেসেজটি সারিতে আছে, ২০-৩০ সেকেন্ড পর আবার পাঠালেই উত্তর পাবেন।"
        : reply.code === "TIMEOUT"
          ? "মডেলটি উত্তর দিতে বেশি সময় নিচ্ছে — একটু পর আবার চেষ্টা করুন।"
          : reply.error;
    return NextResponse.json(
      { error: friendly ?? reply.error ?? "the model did not answer", code: reply.code ?? "PROVIDER_ERROR", modelLabel: reply.modelLabel, rawError: reply.error },
      { status: reply.code === "RATE_LIMITED" ? 429 : 502 },
    );
  }

  const assistantRow = await db.chatMessage.create({
    data: { threadId: thread, role: "assistant", content: reply.content, model: modelId },
  }).catch(() => null);

  return NextResponse.json({
    reply: reply.content,
    model: modelId,
    modelLabel: reply.modelLabel,
    engine: reply.engine ?? "glm-engine",
    engineLabel: reply.engineLabel ?? reply.modelLabel,
    /** v24 — did the AI actually SEE the chart this turn? */
    vision: sawChart,
    userMessage: userRow
      ? { id: userRow.id, role: "user", content: userRow.content, model: modelId, createdAt: userRow.createdAt.toISOString() }
      : null,
    assistantMessage: assistantRow
      ? { id: assistantRow.id, role: "assistant", content: assistantRow.content, model: modelId, createdAt: assistantRow.createdAt.toISOString() }
      : null,
  });
}
