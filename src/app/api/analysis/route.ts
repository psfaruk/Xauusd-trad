import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { evaluate } from "@/lib/market/engine";
import { expiryBarsFor } from "@/lib/market/engine";
import { seedSignals } from "@/lib/market/seed";
import { atr } from "@/lib/market/indicators";
import { buildDrawings, magnetsToDrawings, projectSetup, localBias, buildPhaseDrawings, buildMtfStructureDrawings, buildForecastDrawing } from "@/lib/market/drawings";
import { buildRoadmap } from "@/lib/market/roadmap";
import { detectStructure, detectSupplyDemand, detectOrderBlocks, detectFvg, detectLiquidity } from "@/lib/market/smc";
import { detectConsolidations, detectAmdPhases, detectInstitutionalActivity } from "@/lib/market/phases";
import { detectPatterns } from "@/lib/market/patterns";
import type { AnalysisResponse, Candle, SignalPayload, TfSetup } from "@/lib/market/types";
import { svcHeaders, getBrokerOffsetSec, spreadFor, MT5_URL } from "@/lib/svc";

const CACHE_TTL = 8_000;
/** v16.4 (audit §10): the strategy build identity carried in every
 *  response so consumers/caches can compare across deploys. */
const STRATEGY_VERSION = "v16.9";
/** v16.4 (audit §10): a candle older than 3× its timeframe (plus a
 *  market-closed weekend allowance) means the FEED is stale — surfaced
 *  via dataFreshness.fresh=false instead of passing silently. */
const FRESHNESS_TF_MULT = 3;

const cache = new Map<string, { at: number; data: AnalysisResponse }>();
/** in-flight backtest seeds (symbol|tf) — never seed the same market twice */
const seeding = new Set<string>();

/** v16.9 (audit §2.1): CIRCUIT BREAKER — 3 consecutive transport failures
 *  trip the breaker for 30s. While open, the route stops calling the MT5
 *  service entirely and serves the LAST GOOD analysis (≤ 5 min old,
 *  flagged degraded:true) with Retry-After, so a dead service degrades to
 *  a stale-but-honest snapshot instead of an endless 502 storm. */
const CB_FAIL_THRESHOLD = 3;
const CB_OPEN_MS = 30_000;
const LAST_GOOD_MAX_AGE = 5 * 60_000;
const cbFails = new Map<string, number>();
const cbOpenSince = new Map<string, number>();
const lastGood = new Map<string, { at: number; data: AnalysisResponse }>();

function serveLastGood(mktKey: string, symbol: string, tf: string): NextResponse {
  const good = lastGood.get(mktKey);
  if (good && Date.now() - good.at <= LAST_GOOD_MAX_AGE) {
    return NextResponse.json(
      { ...good.data, degraded: true } as AnalysisResponse,
      { headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
    );
  }
  return NextResponse.json(
    { error: "MT5 service unreachable (circuit open)", code: "MT5_FETCH_FAILED", symbol, timeframe: tf },
    { status: 502, headers: { "Retry-After": "5" } },
  );
}

const ENGINE_TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];

/** v16.4.1 (audit §10): a tf "fed" the engine when it returned at least
 *  this many bars — fewer means the MTF bias ran without that timeframe. */
const MIN_TF_BARS = 40;

/** v16.4.1 (audit §2.5/§10): fetch outcomes are now distinguishable —
 *  `ok:false` is a TRANSPORT failure (service down / timeout / garbage),
 *  `ok:true` + empty bars is "the service answered but has no history"
 *  (unknown symbol / MT5 not connected / brand-new market). The old
 *  version collapsed both into [] and mislabeled a dead service as a
 *  quiet market.
 *  v16.9 (audit §2.1): a non-200 that still returns the service's
 *  structured {error} JSON (e.g. "MT5 not connected") means the SERVICE
 *  is alive — that is ok:true + empty bars (→ 503 DATA_UNAVAILABLE), NOT
 *  a transport failure (→ 502 MT5_FETCH_FAILED + circuit breaker). Only
 *  unreachable/timeout/unparsable responses count as transport. */
async function fetchCandles(symbol: string, tf: string, limit: number): Promise<{ bars: Candle[]; ok: boolean }> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: svcHeaders() },
    );
    if (!res.ok) {
      // service-answered structured error → it is ALIVE, just data-less
      try {
        const err = await res.json();
        if (err && typeof err.error === "string") return { bars: [], ok: true };
      } catch {
        /* unparseable body → true transport failure, fall through */
      }
      return { bars: [], ok: false };
    }
    const data = await res.json();
    return { bars: (data.bars ?? []) as Candle[], ok: true };
  } catch {
    return { bars: [], ok: false };
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
    const closed = bars.bars.filter((b) => !b.f);
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
          // v16.9 (audit §5.9): LIVE tracking resolves on CLOSES — a wick
          // spike through SL that closes back is not a loss. The
          // pessimistic both-touch/wick rule stays in the walk-forward
          // seeder (seed.ts), where conservative outcomes belong; the live
          // tracker's job is honest signal-quality stats.
          if (s.direction === "BUY") {
            if (b.c >= s.tp) { status = "won"; resultR = (s.tp - s.entry) / risk; break; }
            if (b.c <= s.sl) { status = "lost"; resultR = -1; break; }
          } else {
            if (b.c <= s.tp) { status = "won"; resultR = (s.entry - s.tp) / risk; break; }
            if (b.c >= s.sl) { status = "lost"; resultR = -1; break; }
          }
        }
      }

      if (status === s.status) {
        const lastT = closed[closed.length - 1].t;
        if (lastT - s.barTime > expiryBarsFor(tf) * (tfSec[tf] ?? 900)) {
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
            trace: JSON.stringify({ checks: s.checks, factors: s.factors, entryNote: s.entryNote, targetNote: s.targetNote, tp2: s.tp2 }),
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

  // v16.9 (audit §2.1): circuit-breaker door — while open, never touch
  // the MT5 service; serve the last good analysis (degraded) or a 502
  // with Retry-After so the client backs off.
  const mktKey = `${symbol}|${tf}`;
  const openSince = cbOpenSince.get(mktKey);
  if (openSince != null) {
    if (Date.now() - openSince < CB_OPEN_MS) {
      return serveLastGood(mktKey, symbol, tf);
    }
    cbOpenSince.delete(mktKey); // cooldown elapsed → half-open: try the service again
  }

  const limits: Record<string, number> = {
    M1: 900, M5: 700, M15: 600, M30: 400, H1: 400, H4: 300,
  };
  const bars: Record<string, Candle[]> = {};
  /** v16.4.1 (audit §10): per-tf transport health — the fan-out result is
   *  now inspectable instead of every failure silently becoming []. */
  const feedOk: Record<string, boolean> = {};
  await Promise.all(
    ENGINE_TFS.map(async (t) => {
      const r = await fetchCandles(symbol, t, limits[t] ?? 500);
      bars[t] = r.bars;
      feedOk[t] = r.ok;
    }),
  );
  // v16.4.1 (audit §2.5): the REQUESTED tf failing to TRANSPORT (service
  // down / timeout) is a different outage from the service answering with
  // no history — split the codes so the UI can say which one it is.
  // v16.9 (audit §2.1): transport failure = 502 + Retry-After: 5 (a
  // gateway problem, not a service-unavailable), and 3 consecutive trips
  // open the circuit breaker above.
  if (!feedOk[tf]) {
    const fails = (cbFails.get(mktKey) ?? 0) + 1;
    cbFails.set(mktKey, fails);
    if (fails >= CB_FAIL_THRESHOLD) {
      cbOpenSince.set(mktKey, Date.now());
      cbFails.set(mktKey, 0);
      return serveLastGood(mktKey, symbol, tf);
    }
    return NextResponse.json(
      { error: "MT5 service did not answer the candle request", code: "MT5_FETCH_FAILED", symbol, timeframe: tf },
      { status: 502, headers: { "Retry-After": "5" } },
    );
  }
  cbFails.delete(mktKey); // the service answered — breaker resets
  if (!bars[tf]?.length) {
    // v16.4 (audit §2.5/§10): a structured DATA_UNAVAILABLE — the UI can now
    // tell "MT5 service offline / market closed / symbol unknown" apart from
    // "engine looked, found no setup" (status NO_SETUP below).
    return NextResponse.json(
      { error: "no candle data from MT5 service", code: "DATA_UNAVAILABLE", symbol, timeframe: tf },
      { status: 503, headers: { "Retry-After": "10" } },
    );
  }
  // v16.4.1 (audit §10): which timeframes fed this evaluation — a partial
  // feed (e.g. H4 down) degrades the MTF bias; the contract must say so.
  const sourceTimeframes = ENGINE_TFS.filter((t) => (bars[t]?.length ?? 0) >= MIN_TF_BARS);
  const missingTimeframes = ENGINE_TFS.filter((t) => !sourceTimeframes.includes(t));

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
          trace: JSON.stringify({ checks: s.checks, factors: s.factors, entryNote: s.entryNote, targetNote: s.targetNote, tp2: s.tp2 }),
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
      tp2: typeof trace.tp2 === "number" ? (trace.tp2 as number) : undefined,
      rr: h.rr,
      confidence: h.confidence,
      status: h.status as any,
      resultR: h.resultR,
      barTime: h.barTime,
      // v16.9 (audit §2.2): Array.isArray guards on legacy trace rows — a
      // malformed factors/checks value must never crash the panel's .map
      factors: Array.isArray(trace.factors) ? (trace.factors as string[]) : [],
      checks: Array.isArray(trace.checks) ? (trace.checks as SignalPayload["checks"]) : [],
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

  const activeSignal = signals.find((s) => s.status === "active" || s.status === "pending") ?? null;
  const closedBars = bars[tf].filter((b) => !b.f);
  const liveSignal = activeSignal ?? result.signal;
  const price = bars[tf][bars[tf].length - 1].c;

  // ── v16.5 market phases: consolidation ranges / AMD sequences /
  //    institutional footprints — on the ACTIVE tf's closed bars (walk-forward
  //    safe, no look-ahead; refreshes on every poll/bar close = real-time) ──
  const ranges = detectConsolidations(closedBars);
  const amd = detectAmdPhases(closedBars, ranges);
  const { marks, volSpikes } = detectInstitutionalActivity(closedBars);

  // ── HTF context (H1 + H4): zones, structure events and the freshest
  //    consolidation range per tf — every drawing source-labeled (§2.6) ──
  const h1Closed = bars.H1?.length ? bars.H1.filter((b) => !b.f).slice(-240) : [];
  const h4Closed = bars.H4?.length ? bars.H4.filter((b) => !b.f).slice(-240) : [];
  const htfZoneGroups = [
    { tf: "H1", zones: h1Closed.length ? detectSupplyDemand(h1Closed) : [] },
    { tf: "H4", zones: h4Closed.length ? detectSupplyDemand(h4Closed) : [] },
  ];
  const h1Read = h1Closed.length >= 30 ? detectStructure(bars.H1!.filter((b) => !b.f).slice(-300)) : null;
  const h4Read = h4Closed.length >= 30 ? detectStructure(bars.H4!.filter((b) => !b.f).slice(-300)) : null;
  const h1Ranges = h1Closed.length ? detectConsolidations(h1Closed) : [];
  const h4Ranges = h4Closed.length ? detectConsolidations(h4Closed) : [];

  // no live signal → the planned NEXT entry (entry/SL/TP projection) so the
  // chart always answers: কোন প্রাইসে এন্ট্রি / SL / TARGET
  const projection = !liveSignal
    ? projectSetup(closedBars, {
        structure: result.context.structure,
        pools: result.context.pools,
        zones: result.context.zones,
        biasDir: result.biasDir,
        biasScore: result.biasScore,
        spread,
      })
    : null;

  // ── v16.7 — PER-TIMEFRAME ENTRY SETUPS (user spec: "প্রত্যেক টাইম ফ্রেমের
  //    জন্য আলাদা আলাদা এন্ট্রি সেটাপ"): every TF answers with its OWN
  //    setup — a live signal if one is active on that TF (and still near
  //    price), else that TF's own price-anchored projection built from ITS
  //    structure/zones/pools and ITS local bias. The active TF reuses the
  //    hero projection/signal so the chart never shows two different
  //    setups for the same TF. ──
  const tfSecFull: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
  const openAll = await db.signalRecord
    .findMany({
      where: { symbol, status: { in: ["active", "pending"] } },
      orderBy: { barTime: "desc" },
    })
    .catch(() => []);
  const openByTf = new Map<string, (typeof openAll)[number]>();
  for (const s of openAll) if (!openByTf.has(s.timeframe)) openByTf.set(s.timeframe, s);

  const tfSetups: TfSetup[] = [];
  for (const t of ENGINE_TFS) {
    const closed = (bars[t] ?? []).filter((b) => !b.f);
    if (closed.length < 60) continue;
    const lastBarT = closed[closed.length - 1];
    const priceT = lastBarT.c;
    const atrT = ((arr: (number | null)[]) => {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
      return 0;
    })(atr(closed, 14)) || priceT * 0.001;

    // the ACTIVE tf reuses the hero answers (never a second opinion)
    if (t === tf) {
      if (liveSignal) {
        tfSetups.push({
          tf: t, kind: "signal", dir: liveSignal.direction, entry: liveSignal.entry,
          sl: liveSignal.sl, tp: liveSignal.tp, rr: liveSignal.rr,
          confidence: liveSignal.confidence, status: liveSignal.status,
          source: liveSignal.trigger.toUpperCase(), reason: liveSignal.entryNote ?? "",
          price: priceT, distAtr: Math.abs(liveSignal.entry - priceT) / atrT,
          entryType: liveSignal.entryType, atr: atrT, trigger: liveSignal.trigger,
        });
      } else if (projection) {
        tfSetups.push({
          tf: t, kind: "planned", dir: projection.dir, entry: projection.entry,
          sl: projection.sl, tp: projection.tp, rr: projection.rr,
          status: "planned", source: projection.source, reason: projection.reason,
          price: projection.price, distAtr: projection.distAtr,
          entryType: projection.entryType, atr: projection.atr,
        });
      }
      continue;
    }

    // live signal on THIS tf — but only while it is still near the market
    // (a 25-bar-old entry the market left behind is not a tradeable setup)
    const sig = openByTf.get(t);
    const fresh =
      sig != null &&
      Date.now() / 1000 - sig.barTime <= expiryBarsFor(t) * (tfSecFull[t] ?? 900) &&
      Math.abs(sig.entry - priceT) <= 1.2 * atrT;
    if (sig && fresh) {
      tfSetups.push({
        tf: t, kind: "signal", dir: sig.direction as "BUY" | "SELL", entry: sig.entry,
        sl: sig.sl, tp: sig.tp, rr: sig.rr, confidence: sig.confidence,
        status: sig.status, source: sig.trigger.toUpperCase(),
        reason: `live ${sig.trigger} signal`,
        price: priceT, distAtr: Math.abs(sig.entry - priceT) / atrT,
        entryType: sig.entryType as "market" | "limit", atr: atrT, trigger: sig.trigger,
      });
      continue;
    }

    // else — THIS tf's own price-anchored projection (its structure, its
    // zones, its pools, its local bias — no cross-tf contamination)
    const zonesT = [
      ...detectSupplyDemand(closed.slice(-240)),
      ...detectOrderBlocks(closed.slice(-240)),
      ...detectFvg(closed.slice(-240)),
    ];
    const poolsT = detectLiquidity(closed, 0.15, 3, brokerOffsetSec);
    const lb = localBias(closed);
    const pT = projectSetup(closed, {
      structure: detectStructure(closed.slice(-150)),
      pools: poolsT,
      zones: zonesT,
      biasDir: lb.biasDir,
      biasScore: lb.biasScore,
      spread,
    });
    if (pT) {
      tfSetups.push({
        tf: t, kind: "planned", dir: pT.dir, entry: pT.entry, sl: pT.sl,
        tp: pT.tp, rr: pT.rr, status: "planned", source: pT.source,
        reason: pT.reason, price: pT.price, distAtr: pT.distAtr,
        entryType: pT.entryType, atr: pT.atr,
      });
    }
  }
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
      htfZoneGroups,
      volSpikes,
    ),
    ...buildPhaseDrawings(
      tf,
      { ranges, amd, instit: marks },
      [
        { tf: "H1", range: h1Ranges[h1Ranges.length - 1] ?? null },
        { tf: "H4", range: h4Ranges[h4Ranges.length - 1] ?? null },
      ],
    ),
    ...buildMtfStructureDrawings({ h1: h1Read, h4: h4Read }),
    ...magnetsToDrawings(roadmap.magnets),
  ];
  // ── v16.6 — the classic chart-pattern layer (ref-repo D-072 recipe):
  //    triangles / wedges / flags / H&S / double-triple tops with the full
  //    measured-move trade plan (ENTRY/SL/TARGET + RR) — the chart's answer
  //    to "reversal হলে কত দূর যাবে / continue করলে কত দূর যাবে". Active TF
  //    always; H1 joins as source-labeled MTF context when it isn't the
  //    active tf (audit §2.6: every drawing says where it came from). ──
  for (const p of detectPatterns(closedBars)) {
    drawings.push({ ...p, source_tf: tf });
  }
  if (tf !== "H1" && h1Closed.length >= 60) {
    for (const p of detectPatterns(h1Closed).slice(0, 1)) {
      drawings.push({ ...p, source_tf: "H1" });
    }
  }
  // v16.5: the forward map — projected legs to the roadmap's real targets
  // (supersedes the old single-arrow path drawing)
  const forecast = buildForecastDrawing(roadmap, price, digits);
  if (forecast) drawings.push(forecast);
  // v16.7: every OTHER timeframe's price-anchored setup rides along as thin
  // TF-tagged rails (the active tf keeps its hero setup box — no duplicate)
  for (const s of tfSetups) {
    if (s.tf === tf) continue;
    drawings.push({
      kind: "tf_setup", tf: s.tf, dir: s.dir,
      entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr,
      status: s.kind, source: s.source, reason: s.reason,
      price: s.price, distAtr: s.distAtr, entryType: s.entryType,
    });
  }
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
    // v16.4.1 (audit §10): explicit request/signal/source identity — a
    // multi-tf consumer never has to guess which tf produced the signal.
    requestedTimeframe: tf,
    signalTimeframe: liveSignal ? liveSignal.timeframe : null,
    sourceTimeframes,
    missingTimeframes,
    price,
    digits,
    status: liveSignal ? "OK" : "NO_SETUP",
    signal: liveSignal,
    signals,
    nextSetup: projection,
    tfSetups,
    nearMiss: result.nearMiss,
    drawings,
    roadmap,
    snapshot: result.snapshot,
    lastCandleTime,
    dataFreshness,
    strategyVersion: STRATEGY_VERSION,
    generatedAt: Date.now(),
  };
  cache.set(cacheKey, { at: Date.now(), data: payload });
  // v16.9: remember the last GOOD payload for the circuit breaker
  lastGood.set(`${symbol}|${tf}`, { at: Date.now(), data: payload });
  if (lastGood.size > 40) lastGood.clear();
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
