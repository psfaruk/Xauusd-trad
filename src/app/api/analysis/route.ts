import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluate } from "@/lib/market/engine";
import { SIGNAL_EXPIRY_BARS } from "@/lib/market/engine";
import { seedSignals } from "@/lib/market/seed";
import { atr } from "@/lib/market/indicators";
import { buildDrawings, magnetsToDrawings, pathToDrawing, projectSetup } from "@/lib/market/drawings";
import { buildRoadmap } from "@/lib/market/roadmap";
import { detectSupplyDemand } from "@/lib/market/smc";
import type { AnalysisResponse, Candle, SignalPayload } from "@/lib/market/types";
import { svcHeaders, getBrokerOffsetSec, spreadFor } from "@/lib/svc";

const MT5_URL = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";
const CACHE_TTL = 8_000;
/** v16.4 (audit §10): the strategy build identity carried in every
 *  response so consumers/caches can compare across deploys. */
const STRATEGY_VERSION = "v16.4";
/** v16.4 (audit §10): a candle older than 3× its timeframe (plus a
 *  market-closed weekend allowance) means the FEED is stale — surfaced
 *  via dataFreshness.fresh=false instead of passing silently. */
const FRESHNESS_TF_MULT = 3;

const cache = new Map<string, { at: number; data: AnalysisResponse }>();
/** in-flight backtest seeds (symbol|tf) — never seed the same market twice */
const seeding = new Set<string>();

const ENGINE_TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];

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

// ── v14 SPREAD FALLBACK — now the SHARED helper in lib/svc.ts (v16.3), so
//    the analysis route and the backtest route can never disagree about the
//    spread regime again. The original local copy lives on in git history. ──

/** Track open signals against the newest closed bars of their timeframe. */
async function trackOpenSignals(symbol: string): Promise<void> {
  const open = await db.signalRecord.findMany({
    where: { symbol, status: { in: ["active", "pending"] } },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  if (!open.length) return;
  const byTf = new Map<string, typeof open>();
  for (const s of open) {
    if (!byTf.has(s.timeframe)) byTf.set(s.timeframe, []);
    byTf.get(s.timeframe)!.push(s);
  }
  for (const [tf, sigs] of byTf) {
    const tfSec: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
    // fetch ENOUGH bars to cover the oldest open signal — the old fixed
    // limit (6) silently missed fills/resolutions whenever the app had
    // been closed for more than a few bars
    const oldest = Math.min(...sigs.map((s) => s.barTime));
    const need = Math.min(90, Math.ceil((Date.now() / 1000 - oldest) / (tfSec[tf] ?? 900)) + 4);
    const bars = await fetchCandles(symbol, tf, Math.max(10, need));
    const closed = bars.filter((b) => !b.f);
    if (!closed.length) continue;
    // ATR for pending-invalidation (a limit the market ran away from)
    const atrVals = atr(closed, 14).filter((v) => v != null) as number[];
    const aNow = atrVals.length ? atrVals[atrVals.length - 1] : 0;
    const lastClosed = closed[closed.length - 1];
    for (const s of sigs) {
      const since = closed.filter((b) => b.t > s.barTime);
      if (!since.length) continue;
      let status = s.status;
      let resultR: number | null = null;
      const risk = Math.abs(s.entry - s.sl) || 1e-9;

      // v12.1 LOOKAHEAD FIX: bars the position was actually LIVE for.
      // For a pending limit that is strictly FROM the fill bar onward — a
      // bar that touched TP/SL before the entry ever filled must not count
      // (the old code scanned every bar since signal creation and turned
      // pre-fill wicks into phantom wins/losses; seed.ts was already
      // correct — this makes the live tracker match it).
      let liveBars = since;

      // pending limit → filled when price traded through the entry level,
      // or CANCELLED when the market ran away without filling (stale zone)
      if (status === "pending") {
        const fillBar =
          since.find((b) => (s.direction === "BUY" ? b.l <= s.entry : b.h >= s.entry)) ?? null;
        if (fillBar) {
          status = "active";
          liveBars = since.filter((b) => b.t >= fillBar.t);
        } else if (aNow > 0) {
          const runaway = s.direction === "BUY"
            ? lastClosed.c - s.entry
            : s.entry - lastClosed.c;
          if (runaway > 1.5 * aNow) {
            status = "cancelled";
            resultR = null;
          }
        }
      }

      if (status === "active") {
        for (const b of liveBars) {
          // pessimistic both-touch (reference rule): a bar spanning SL and TP is a loss
          const bothTouch = s.direction === "BUY"
            ? (b.h >= s.tp && b.l <= s.sl)
            : (b.h >= s.sl && b.l <= s.tp);
          if (bothTouch) { status = "lost"; resultR = -1; break; }
          if (s.direction === "BUY") {
            if (b.h >= s.tp) { status = "won"; resultR = (s.tp - s.entry) / risk; break; }
            if (b.l <= s.sl) { status = "lost"; resultR = -1; break; }
          } else {
            if (b.l <= s.tp) { status = "won"; resultR = (s.entry - s.tp) / risk; break; }
            if (b.h >= s.sl) { status = "lost"; resultR = -1; break; }
          }
        }
      }

      if (status === s.status) {
        const lastT = closed[closed.length - 1].t;
        if (lastT - s.barTime > SIGNAL_EXPIRY_BARS * (tfSec[tf] ?? 900)) {
          status = "expired";
          resultR = null;
        }
      }
      if (status !== s.status) {
        await db.signalRecord.update({
          where: { id: s.id },
          data: { status, resultR, closedAt: status === "active" || status === "pending" ? null : new Date() },
        });
      }
    }
  }
}

/**
 * Backtest seeding — on first sight of a market+tf, walk the REAL history
 * with the same detectors and persist outcomes so the panel/stats/chart
 * start populated (reference: seedHistoricalSignals).
 */
async function ensureSeeded(symbol: string, tf: string, bars: Candle[], digits: number, spread: number, brokerOffsetSec = 0): Promise<void> {
  const key = `${symbol}|${tf}`;
  if (seeding.has(key)) return;
  try {
    const count = await db.signalRecord.count({ where: { symbol, timeframe: tf } });
    if (count >= 5) return;
    seeding.add(key);
    const { signals } = seedSignals({ symbol, tf, digits, spread, bars, brokerOffsetSec });
    for (const s of signals) {
      await db.signalRecord
        .create({
          data: {
            symbol: s.symbol,
            timeframe: s.timeframe,
            direction: s.direction,
            trigger: s.trigger,
            entryType: s.entryType,
            entry: s.entry,
            sl: s.sl,
            tp: s.tp,
            rr: s.rr,
            confidence: s.confidence,
            status: s.status,
            resultR: s.resultR ?? null,
            trace: JSON.stringify({ checks: s.checks, factors: s.factors, entryNote: s.entryNote, targetNote: s.targetNote }),
            barTime: s.barTime,
          },
        })
        .catch(() => {}); // unique constraint → dedupe
    }
  } catch {
    // never fail the request because of seeding
  } finally {
    seeding.delete(key);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "XAUUSDm").trim().slice(0, 24);
  const tf = url.searchParams.get("tf") ?? "M15";

  // v16.4 (audit §10): validate the request contract — an unsupported
  // timeframe is a CLIENT error (400), not a data outage (503). The old
  // code fell through to the 503 "no candle data" branch and mislabeled a
  // bad request as a service failure.
  if (!ENGINE_TFS.includes(tf)) {
    return NextResponse.json(
      { error: `unsupported timeframe "${tf}" (supported: ${ENGINE_TFS.join(", ")})`, code: "UNSUPPORTED_TIMEFRAME" },
      { status: 400 },
    );
  }
  if (!/^[A-Za-z0-9_/+.-]{1,24}$/.test(symbol)) {
    return NextResponse.json(
      { error: "invalid symbol", code: "INVALID_SYMBOL" },
      { status: 400 },
    );
  }

  const limits: Record<string, number> = {
    M1: 900, M5: 700, M15: 600, M30: 400, H1: 400, H4: 300,
  };
  const bars: Record<string, Candle[]> = {};
  await Promise.all(
    ENGINE_TFS.map(async (t) => {
      bars[t] = await fetchCandles(symbol, t, limits[t] ?? 500);
    }),
  );
  if (!bars[tf]?.length) {
    // v16.4 (audit §2.5/§10): a structured DATA_UNAVAILABLE — the UI can now
    // tell "MT5 service offline / market closed / symbol unknown" apart from
    // "engine looked, found no setup" (status NO_SETUP below).
    return NextResponse.json(
      { error: "no candle data from MT5 service", code: "DATA_UNAVAILABLE", symbol, timeframe: tf },
      { status: 503 },
    );
  }

  // v14: cache keyed on the LAST CLOSED bar time — a new bar close forces a
  // fresh evaluate even inside the 8s TTL (the audit's "stale zones after
  // candle close"). Same-bar polls still dedupe through TTL.
  const lastClosedT = (bars[tf].filter((b) => !b.f).slice(-1)[0] ?? bars[tf][bars[tf].length - 1]).t;
  const cacheKey = `${symbol}|${tf}|${lastClosedT}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "no-store" } });
  }
  // prune: keep the map bounded (one key per bar per market)
  if (cache.size > 40) cache.clear();

  const digitsInfo = await fetch(`${MT5_URL}/api/symbols`, {
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
    headers: svcHeaders(),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const digits =
    digitsInfo?.list?.find((s: any) => s.name === symbol)?.digits ?? 2;
  const spread = await spreadFor(symbol); // v16.3: shared fallback helper
  // v14: broker clock offset → PDH/PDL day cut at server-local midnight (NY 17:00)
  const brokerOffsetSec = await getBrokerOffsetSec();

  const lastSig = await db.signalRecord.findFirst({
    where: { symbol, timeframe: tf },
    orderBy: { barTime: "desc" },
  });

  // backtest seed (fire-and-forget; first sight of this market+tf)
  void ensureSeeded(symbol, tf, bars[tf], digits, spread, brokerOffsetSec);

  const result = evaluate({
    symbol,
    timeframe: tf,
    digits,
    spread,
    bars,
    brokerOffsetSec,
    lastSignalBarTime: lastSig?.barTime ?? null,
    lastSignalTrigger: lastSig?.trigger ?? null,
  });

  if (result.signal) {
    const s = result.signal;
    try {
      const created = await db.signalRecord.create({
        data: {
          symbol: s.symbol,
          timeframe: s.timeframe,
          direction: s.direction,
          trigger: s.trigger,
          entryType: s.entryType,
          entry: s.entry,
          sl: s.sl,
          tp: s.tp,
          rr: s.rr,
          confidence: s.confidence,
          status: s.status,
          trace: JSON.stringify({ checks: s.checks, factors: s.factors, entryNote: s.entryNote, targetNote: s.targetNote }),
          barTime: s.barTime,
        },
      });
      s.id = created.id;
      s.createdAt = created.createdAt.toISOString();
    } catch {
      // v14: unique conflict (symbol|tf|barTime|direction) — the audit's
      // "silent drop": the signal showed in the UI this poll and vanished
      // the next. Merge with the EXISTING row so the payload stays stable.
      const existing = await db.signalRecord
        .findFirst({ where: { symbol: s.symbol, timeframe: s.timeframe, barTime: s.barTime, direction: s.direction } })
        .catch(() => null);
      if (existing) {
        s.id = existing.id;
        s.createdAt = existing.createdAt.toISOString();
        if (existing.status !== "active" && existing.status !== "pending") s.status = existing.status as any;
      }
    }
  }

  await trackOpenSignals(symbol);

  const history = await db.signalRecord.findMany({
    where: { symbol, timeframe: tf },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const signals: SignalPayload[] = history.map((h) => {
    let trace: Record<string, unknown> = {};
    try {
      trace = JSON.parse(h.trace || "{}") as Record<string, unknown>;
    } catch {
      trace = {}; // malformed legacy row → empty trace, never a 500
    }
    return {
      id: h.id,
      symbol: h.symbol,
      timeframe: h.timeframe,
      direction: h.direction as "BUY" | "SELL",
      trigger: h.trigger as any,
      entryType: h.entryType as any,
      entry: h.entry,
      sl: h.sl,
      tp: h.tp,
      rr: h.rr,
      confidence: h.confidence,
      status: h.status as any,
      resultR: h.resultR,
      barTime: h.barTime,
      factors: (trace.factors as string[]) ?? [],
      checks: (trace.checks as SignalPayload["checks"]) ?? [],
      entryNote: trace.entryNote as string | undefined,
      targetNote: trace.targetNote as string | undefined,
      createdAt: h.createdAt.toISOString(),
    };
  });

  const roadmap = buildRoadmap(bars[tf].filter((b) => !b.f), tf, {
    structure: result.context.structure,
    pools: result.context.pools,
    zones: result.context.zones,
    biasDir: result.biasDir,
    biasScore: result.biasScore,
  });

  const htfZones = bars.H1?.length
    ? detectSupplyDemand(bars.H1.filter((b) => !b.f).slice(-240))
    : [];

  const activeSignal = signals.find((s) => s.status === "active" || s.status === "pending") ?? null;
  const closedBars = bars[tf].filter((b) => !b.f);
  const liveSignal = activeSignal ?? result.signal;
  // no live signal → the planned NEXT entry (entry/SL/TP projection) so the
  // chart always answers: কোন প্রাইসে এন্ট্রি / SL / TARGET
  const projection = !liveSignal
    ? projectSetup(closedBars, {
        structure: result.context.structure,
        pools: result.context.pools,
        zones: result.context.zones,
        biasDir: result.biasDir,
        biasScore: result.biasScore,
      })
    : null;
  const drawings = [
    ...buildDrawings(
      closedBars,
      tf,
      {
        structure: result.context.structure,
        pools: result.context.pools,
        zones: result.context.zones,
        signal: liveSignal,
        projection,
      },
      htfZones,
    ),
    ...magnetsToDrawings(roadmap.magnets),
  ];
  const pathD = pathToDrawing(roadmap.path, bars[tf][bars[tf].length - 1].c);
  if (pathD) drawings.push(pathD);

  const price = bars[tf][bars[tf].length - 1].c;
  // v16.4 (audit §4/§10): data identity + freshness on every payload
  const lastCandleTime = lastClosedT;
  const tfSecMap: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
  const ageSec = Math.max(0, Math.round(Date.now() / 1000 - lastCandleTime) - (tfSecMap[tf] ?? 900));
  const dataFreshness = {
    lastCandleTime,
    ageSec,
    fresh: ageSec <= FRESHNESS_TF_MULT * (tfSecMap[tf] ?? 900),
  };
  const payload: AnalysisResponse = {
    symbol,
    timeframe: tf,
    price,
    digits,
    status: liveSignal ? "OK" : "NO_SETUP",
    signal: liveSignal,
    nextSetup: projection,
    nearMiss: result.nearMiss,
    drawings,
    roadmap,
    snapshot: result.snapshot,
    lastCandleTime,
    dataFreshness,
    strategyVersion: STRATEGY_VERSION,
    generatedAt: Date.now(),
  };
  (payload as any).signals = signals;

  cache.set(cacheKey, { at: Date.now(), data: payload });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
