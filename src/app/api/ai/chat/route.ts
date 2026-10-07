import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MT5_URL, svcHeaders, spreadFor } from "@/lib/svc";
import { buildBoardContext } from "@/lib/market/board";
import { chatComplete, getAiSettings } from "@/lib/ai/llm";
import { modelById } from "@/lib/ai/registry";
import { getNewsRadar } from "@/lib/ai/tower";
import type { Candle } from "@/lib/market/types";

/**
 * /api/ai/chat — the AI CHAT BOX backend (v22.0).
 *
 *   GET    ?thread                → message history (oldest → newest, last 60)
 *   POST   { thread, message, model? } → one assistant reply
 *   DELETE ?thread                → clear the thread
 *
 * The chat is market-aware: every reply is grounded in the LIVE snapshot the
 * AI Board itself reads (price, ATR, trend, zones, patterns), the board's
 * latest decision and the news radar's headlines — so "এখন entry নেবো?" gets
 * a real answer with real levels, not a generic one.
 *
 * The model is the user's pick from the selector (GLM built-in / DeepSeek /
 * Qwen / Kimi) routed through the multi-provider gateway.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const HISTORY_LIMIT = 60;
const CONTEXT_MESSAGES = 14;

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

// ── POST: one grounded reply ──

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const thread = cleanThread(body?.thread);
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const settings = await getAiSettings();
  const modelId = typeof body?.model === "string" && modelById(body.model) ? body.model : settings.chatModel;

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

  const system =
    "You are AURUM AI — the assistant of the AURUM Terminal, a live XAUUSD/forex trading terminal on MetaTrader 5. " +
    "You are talking to the terminal's owner. You have the LIVE market context below — USE IT: quote exact prices, zones, patterns and board decisions from it instead of generic advice. " +
    "Rules: (1) Reply in the SAME language the user writes in — if they write বাংলা, reply in বাংলা with trading terms in English. " +
    "(2) Be concrete and brief: levels, distances in ATR, RR — no fluff. " +
    "(3) You are an analyst, not a guarantee: when suggesting entries, always include the invalidation (SL) and a one-line risk note. " +
    "(4) Markdown allowed (bold, lists), keep it tight for a chat box.\n\n" + marketBlock;

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
    // v23 — generous budget: the gate serializes + retries 429s inside it,
    // so a rate-limited moment becomes a slightly longer "thinking…" instead
    // of an instant "API problem".
    timeoutMs: 42_000,
    temperature: 0.5,
    maxTokens: 1100,
  });

  if (!reply.ok) {
    const friendly =
      reply.code === "RATE_LIMITED"
        ? "ইঞ্জিন একটু ব্যস্ত (rate limit) — ২০-৩০ সেকেন্ড পর আবার পাঠান, ততক্ষণে ঠিক হয়ে যাবে।"
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
    userMessage: userRow
      ? { id: userRow.id, role: "user", content: userRow.content, model: modelId, createdAt: userRow.createdAt.toISOString() }
      : null,
    assistantMessage: assistantRow
      ? { id: assistantRow.id, role: "assistant", content: assistantRow.content, model: modelId, createdAt: assistantRow.createdAt.toISOString() }
      : null,
  });
}
