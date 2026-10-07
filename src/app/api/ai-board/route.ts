import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { svcHeaders, spreadFor, MT5_URL } from "@/lib/svc";
import {
  buildBoardContext, runBoardMeeting, resolveOutcome, type OpenLike,
} from "@/lib/market/board";
import type { BoardResponse, BoardSessionPayload, Candle } from "@/lib/market/types";

/**
 * /api/ai-board — the 6-AGENT AI BOARD (v21.0).
 *
 *   POST { symbol, tf }  → run ONE board meeting (5 analysts in parallel +
 *                          the CTO consensus) and persist it.
 *   GET  ?symbol&tf      → latest decision + history + the board's W/L stats.
 *
 * Rate contract: one REAL meeting per closed bar per market (re-running the
 * same bar returns the recorded session), a 45s cooldown between meetings,
 * and a single-flight guard so two tabs can never double-book the LLM.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const BOARD_TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];
const COOLDOWN_MS = 45_000;
const HISTORY_TAKE = 20;

// ── single-flight + cooldown state (in-process) ──
const inflight = new Map<string, Promise<BoardSessionPayload | null>>();
let lastMeetingAt = 0;

async function fetchCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.bars ?? []) as Candle[];
  } catch {
    return [];
  }
}

async function fetchBalance(): Promise<number | null> {
  try {
    const res = await fetch(`${MT5_URL}/api/trader`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: svcHeaders(),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const b = Number(j?.balance);
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch {
    return null;
  }
}

async function fetchDigits(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${MT5_URL}/api/symbols`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: svcHeaders(),
    });
    if (!res.ok) return 2;
    const j = await res.json();
    return j?.list?.find((s: { name: string }) => s.name === symbol)?.digits ?? 2;
  } catch {
    return 2;
  }
}

// ── row → payload ──

interface BoardRow {
  id: string; symbol: string; timeframe: string; action: string;
  entry: number | null; sl: number | null; tp: number | null; tp2: number | null;
  rr: number | null; lot: number | null; consensus: number;
  agents: string; drawings: string; context: string;
  barTime: number; status: string; resultPct: number | null;
  degraded: boolean; createdAt: Date;
}

function rowToPayload(row: BoardRow): BoardSessionPayload {
  let agents: BoardSessionPayload["agents"] = [];
  let drawings: BoardSessionPayload["decision"]["drawings"] = {};
  let context: BoardSessionPayload["context"] = null;
  try { agents = JSON.parse(row.agents); } catch {}
  try { drawings = JSON.parse(row.drawings); } catch {}
  try { context = JSON.parse(row.context); } catch {}
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    barTime: row.barTime,
    createdAt: row.createdAt.toISOString(),
    agents,
    decision: {
      action: (row.action as "BUY" | "SELL" | "HOLD"),
      entry: row.entry, sl: row.sl, tp: row.tp, tp2: row.tp2, rr: row.rr,
      lot: row.lot, consensus: row.consensus,
      reasoning: agents.find((a) => a.id === "cto")?.note ?? "",
      drawings,
    },
    context,
    status: (row.status as "open" | "won" | "lost" | "expired"),
    resultPct: row.resultPct,
    degraded: row.degraded,
  };
}

/** resolve open sessions against the bars that followed (their own tf). */
async function trackOutcomes(symbol: string, tf: string): Promise<void> {
  const open = await db.boardSession.findMany({
    where: { symbol, timeframe: tf, status: "open" },
    orderBy: { createdAt: "desc" },
    take: 16,
  }).catch(() => []);
  if (!open.length) return;

  const tfSec: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
  const bars = await fetchCandles(symbol, tf, 200);
  const closed = bars.filter((b) => !b.f);

  for (const s of open) {
    const since = closed.filter((b) => b.t > s.barTime);
    const r = resolveOutcome(s as OpenLike, since, tfSec[tf] ?? 900);
    if (r.status !== s.status) {
      await db.boardSession.update({
        where: { id: s.id },
        data: {
          status: r.status,
          resultPct: r.resultPct,
          closedAt: r.status === "open" ? null : new Date(),
        },
      }).catch(() => {});
    }
  }
}

async function boardResponse(symbol: string, tf: string): Promise<BoardResponse> {
  await trackOutcomes(symbol, tf);
  const rows = await db.boardSession.findMany({
    where: { symbol, timeframe: tf },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TAKE,
  }).catch(() => []);
  const payloads = rows.map(rowToPayload);
  const traded = payloads.filter((p) => p.decision.action !== "HOLD");
  const won = traded.filter((p) => p.status === "won").length;
  const lost = traded.filter((p) => p.status === "lost").length;
  const open = traded.filter((p) => p.status === "open").length;
  return {
    latest: payloads[0] ?? null,
    history: payloads,
    stats: {
      total: traded.length,
      won, lost, open,
      winPct: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
    },
  };
}

// ── POST: run the meeting ──

export async function POST(req: Request) {
  let symbol = "XAUUSDm";
  let tf = "M15";
  try {
    const body = (await req.json().catch(() => ({}))) as { symbol?: string; tf?: string };
    symbol = (body.symbol ?? symbol).trim().slice(0, 24);
    tf = body.tf ?? tf;
  } catch { /* defaults */ }

  if (!BOARD_TFS.includes(tf)) {
    return NextResponse.json({ error: `unsupported timeframe "${tf}"`, code: "UNSUPPORTED_TIMEFRAME" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_/+.-]{1,24}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol", code: "INVALID_SYMBOL" }, { status: 400 });
  }

  // single-flight: the same market's meeting runs ONCE
  const key = `${symbol}|${tf}`;
  const running = inflight.get(key);
  if (running) {
    const done = await running;
    if (done) return NextResponse.json(await boardResponse(symbol, tf));
  }

  // cooldown: never more than one real meeting per 45s (any market)
  if (Date.now() - lastMeetingAt < COOLDOWN_MS) {
    const resp = await boardResponse(symbol, tf);
    if (resp.latest) {
      return NextResponse.json({ ...resp, throttled: true });
    }
  }

  const meeting = (async (): Promise<BoardSessionPayload | null> => {
    try {
      // ── data fan-out: active tf + H1/H4 for MTF context ──
      const mtf = tf === "H1" ? ["H1", "H4"] : tf === "H4" ? ["H4"] : [tf, "H1", "H4"];
      const barsByTf: Record<string, Candle[]> = {};
      await Promise.all(
        mtf.map(async (t) => {
          barsByTf[t] = await fetchCandles(symbol, t, t === tf ? 400 : 260);
        }),
      );
      const closed = (barsByTf[tf] ?? []).filter((b) => !b.f);
      if (closed.length < 60) {
        return null; // no data — the caller serves 503 below
      }
      const lastClosed = closed[closed.length - 1];

      // same-bar meeting already recorded → return it (idempotent per bar)
      const existing = await db.boardSession.findFirst({
        where: { symbol, timeframe: tf, barTime: lastClosed.t },
        orderBy: { createdAt: "desc" },
      }).catch(() => null);
      if (existing) return rowToPayload(existing);

      const [digits, spread, balance] = await Promise.all([
        fetchDigits(symbol),
        spreadFor(symbol),
        fetchBalance(),
      ]);

      // the engine's live signal (context, not authority)
      const lastSig = await db.signalRecord.findFirst({
        where: { symbol, timeframe: tf, status: { in: ["active", "pending"] } },
        orderBy: { barTime: "desc" },
      }).catch(() => null);

      // recent board outcomes (the board remembers its own record)
      const recentRows = await db.boardSession.findMany({
        where: { symbol, timeframe: tf, action: { not: "HOLD" } , status: { in: ["won", "lost"] } },
        orderBy: { createdAt: "desc" },
        take: 3,
      }).catch(() => []);
      const recentBoard = recentRows.map(
        (r) => `${r.status} ${r.resultPct != null ? `${r.resultPct >= 0 ? "+" : ""}${r.resultPct.toFixed(2)}%` : ""}`.trim(),
      );

      const ctx = buildBoardContext(symbol, tf, barsByTf, spread, digits, {
        balance,
        engineSignal: lastSig
          ? { direction: lastSig.direction, trigger: lastSig.trigger, entry: lastSig.entry, sl: lastSig.sl, tp: lastSig.tp }
          : null,
        recentBoard,
      });

      const result = await runBoardMeeting(ctx, symbol, balance);
      lastMeetingAt = Date.now();

      const row = await db.boardSession.create({
        data: {
          symbol, timeframe: tf,
          action: result.decision.action,
          entry: result.decision.entry,
          sl: result.decision.sl,
          tp: result.decision.tp,
          tp2: result.decision.tp2,
          rr: result.decision.rr,
          lot: result.decision.lot,
          consensus: result.decision.consensus,
          agents: JSON.stringify(result.agents),
          drawings: JSON.stringify(result.decision.drawings),
          context: JSON.stringify(result.context.summary),
          barTime: lastClosed.t,
          degraded: result.degraded,
        },
      }).catch(() => null);
      return row ? rowToPayload(row) : null;
    } catch (e) {
      console.error("[ai-board] meeting failed:", e);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, meeting);
  const result = await meeting;

  if (!result) {
    return NextResponse.json(
      { error: "board could not read the market (no candle data)", code: "DATA_UNAVAILABLE" },
      { status: 503, headers: { "Retry-After": "10" } },
    );
  }
  return NextResponse.json(await boardResponse(symbol, tf));
}

// ── GET: latest + history + stats ──

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "XAUUSDm").trim().slice(0, 24);
  const tf = url.searchParams.get("tf") ?? "M15";
  if (!BOARD_TFS.includes(tf)) {
    return NextResponse.json({ error: `unsupported timeframe "${tf}"`, code: "UNSUPPORTED_TIMEFRAME" }, { status: 400 });
  }
  const resp = await boardResponse(symbol, tf);
  return NextResponse.json(resp, { headers: { "Cache-Control": "no-store" } });
}
