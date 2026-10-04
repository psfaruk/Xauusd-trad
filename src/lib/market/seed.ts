/**
 * Walk-forward backtest seeding — fires the SAME trigger detectors over the
 * REAL closed history and resolves outcomes against later REAL bars
 * (pessimistic both-touch = lost). v2 fidelity fixes:
 *
 *  · step 1 (was 2 — odd bars were invisible to the backtest but fire live)
 *  · zones/pools filtered AS-OF each bar (fresh · alive · not-run), so the
 *    walk-forward sees the same universe the live engine saw — no lookahead
 *  · trigger-aware cooldown + the shared 30-bar expiry (matches live tracking)
 *  · per-bar bias (EMA50 of the window) drives the zone side preference
 *    exactly like the live engine
 */

import type { Candle, SignalPayload } from "./types";
import { atr, ema, sessionOf, volZ } from "./indicators";
import { detectOrderBlocks, detectFvg, detectLiquidity, detectSupplyDemand, detectStructure, type LiquidityPool, type Zone } from "./smc";
import {
  COOLDOWN_BARS, COOLDOWN_BARS_DEFAULT, SIGNAL_EXPIRY_BARS,
  detectPullback, detectSfp, detectZoneRetest, setupGeometry, type TriggerResult,
} from "./engine";

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

export interface SeedInput {
  symbol: string;
  tf: string;
  digits: number;
  spread: number;
  bars: Candle[]; // closed bars of `tf`, oldest→newest
  /** v14: broker server clock − UTC — PDH/PDL day cut at server-local
   *  midnight (= NY 17:00). 0 = unknown. */
  brokerOffsetSec?: number;
}

export interface SeedResult {
  signals: SignalPayload[];
  scanned: number;
}

/** zones alive & fresh as-of bar time t (mirrors the live engine's filters) */
function zonesAsOf(all: Zone[], t: number, windowStartT: number): Zone[] {
  return all.filter((z) =>
    z.t <= t &&
    z.t >= windowStartT &&
    (z.brokenT == null || z.brokenT > t) &&
    (z.mitT == null || z.mitT >= t),
  );
}

/** pools live as-of t (untouched = valid TP target; not-run = valid SL shield) */
function poolsAsOf(all: LiquidityPool[], t: number, windowStartT: number): LiquidityPool[] {
  return all.filter((p) =>
    p.t <= t &&
    p.t >= windowStartT - 86400 * 3 && // pools can outlive the zone window a bit
    (p.runT == null || p.runT > t),
  );
}

/**
 * Walk the closed history; at each bar evaluate the trigger suite on the
 * window ending there, build the setup, then resolve it against the bars
 * that actually followed.
 */
export function seedSignals(input: SeedInput): SeedResult {
  const { symbol, tf, digits, spread } = input;
  const bars = input.bars.filter((b) => !b.f);
  const n = bars.length;
  const tfSec = TF_SEC[tf] ?? 900;
  if (n < 120) return { signals: [], scanned: 0 };

  // zone/pool universe computed ONCE on the full series; windows only see
  // entities that existed (and were alive) at their time — as-of filtered
  const allZones: Zone[] = [
    ...detectSupplyDemand(bars),
    ...detectOrderBlocks(bars),
    ...detectFvg(bars),
  ];
  const allPools = detectLiquidity(bars, 0.15, 3, input.brokerOffsetSec ?? 0);

  const closesAll = bars.map((b) => b.c);
  const atrAll = atr(bars, 14);
  const ema21All = ema(closesAll, 21);

  const out: SignalPayload[] = [];
  let lastEntryT = -Infinity;
  let lastTrigKind = "";

  for (let i = 90; i < n - 1; i++) {
    const bar = bars[i];
    const barsSince = (bar.t - lastEntryT) / tfSec;
    if (lastEntryT !== -Infinity && barsSince < COOLDOWN_BARS_DEFAULT) continue;

    const winStart = Math.max(0, i - 239);
    const win = bars.slice(winStart, i + 1);
    if (win.length < 60) continue;

    const a = (atrAll[i] as number) || 0;
    const aPrev = (atrAll[i - 1] as number) || a; // SFP threshold ATR (P4)
    const e21 = ema21All[i] as number;
    const e21Prev = (ema21All[i - 5] as number) ?? e21; // pullback slope (P3)
    const price = bar.c;
    if (a <= 0 || !e21) continue;

    // as-of universe
    const zones = zonesAsOf(allZones, bar.t, win[0].t);
    const pools = poolsAsOf(allPools, bar.t, win[0].t);

    // per-bar bias (cheap EMA50 vote — drives zone side order like live)
    const e50 = ema(win.map((b) => b.c), 50);
    let bias: number | null = null;
    for (let k = e50.length - 1; k >= 0; k--) {
      if (e50[k] != null) { bias = e50[k] as number; break; }
    }
    const biasDir: "BUY" | "SELL" | "NEUTRAL" = bias == null ? "NEUTRAL" : price > bias ? "BUY" : "SELL";

    // trigger suite (direction-bearing)
    const vz = volZ(win);
    let trig: TriggerResult | null = detectSfp(win, aPrev, vz);
    if (!trig) trig = detectZoneRetest(win, a, price, zones, biasDir);
    if (!trig) trig = detectPullback(win, e21, e21Prev, a);
    if (!trig) continue;

    // trigger-aware cooldown (matches live)
    if (lastEntryT !== -Infinity && barsSince < (COOLDOWN_BARS[trig.kind] ?? COOLDOWN_BARS_DEFAULT)) continue;

    // v16.8 HARD COUNTER-TREND FILTER (parity with the live engine): no
    // signal against a non-neutral bias — the −0.05-confidence era is over
    if (biasDir !== "NEUTRAL" && biasDir !== trig.dir) continue;

    const geo = setupGeometry(trig, win, a, pools, zones, tf, spread);
    if (!geo) continue;

    const risk = Math.abs(geo.entry - geo.sl) || 1e-9;
    if (risk < Math.max(0.5 * a, 4 * spread)) continue;
    if (spread > 0.35 * risk) continue;

    const sess = sessionOf(bar.t);
    const stTrend = detectStructure(win).trend;
    const passRatio =
      (trig.quality >= 0.5 ? 1 : 0) +
      (sess === "london" || sess === "newyork" || sess === "overlap" ? 1 : 0) +
      (spread > 0 && spread / price < 0.00015 ? 1 : 0) +
      (stTrend === (trig.dir === "BUY" ? "bullish" : "bearish") ? 1 : 0);
    let confidence = 0.45 + 0.5 * (passRatio / 4);
    confidence = Math.max(0.4, Math.min(0.9, confidence));

    const entryType: "market" | "limit" =
      Math.abs(geo.entry - price) > Math.max(0.35 * a, 2 * spread, 1) ? "limit" : "market";

    out.push({
      symbol,
      timeframe: tf,
      direction: trig.dir,
      trigger: trig.kind,
      entryType,
      entry: rnd(geo.entry, digits),
      sl: rnd(geo.sl, digits),
      tp: rnd(geo.tp, digits),
      rr: rnd(geo.rr, 2),
      confidence: rnd(confidence, 3),
      status: entryType === "limit" ? "pending" : "active",
      barTime: bar.t,
      targetNote: geo.targetNote,
      entryNote: trig.note,
      factors: [`${trig.kind}_backtest`, `q_${rnd(trig.quality, 2)}`],
      checks: [
        { name: "Trigger", ok: true, value: `${trig.kind} ${trig.dir}` },
        { name: "Backtest", ok: true, value: `real history @ ${tf}` },
      ],
    });
    lastEntryT = bar.t;
    lastTrigKind = trig.kind;
  }

  resolveSeeded(out, bars, tfSec);
  return { signals: out, scanned: n };
}

/**
 * Resolve seeded signals against the REAL bars that followed
 * (pessimistic: a bar spanning SL and TP counts as a loss). The newest
 * unresolved signal stays LIVE so the chart opens with a setup (D-074).
 */
function resolveSeeded(seeds: SignalPayload[], bars: Candle[], tfSec: number) {
  const n = bars.length;
  for (const s of seeds) {
    const startIdx = bars.findIndex((b) => b.t === s.barTime);
    if (startIdx === -1) continue;
    const end = Math.min(n - 1, startIdx + SIGNAL_EXPIRY_BARS);
    let outcome: "won" | "lost" | "expired" | null = null;
    let resultR = 0;
    // pending limit → filled when price traded through the entry level
    let activeFrom = startIdx + 1;
    if (s.entryType === "limit") {
      let filled = false;
      for (let j = startIdx + 1; j <= end; j++) {
        const b = bars[j];
        if (s.direction === "BUY" ? b.l <= s.entry : b.h >= s.entry) {
          filled = true;
          activeFrom = j;
          break;
        }
      }
      if (!filled) {
        // never filled inside the window → cancelled (missed / zone ran away)
        s.status = "cancelled";
        s.resultR = null;
        continue;
      }
    }
    for (let j = activeFrom; j <= end; j++) {
      const b = bars[j];
      const bothTouch = s.direction === "BUY"
        ? (b.h >= s.tp && b.l <= s.sl)
        : (b.h >= s.sl && b.l <= s.tp);
      if (bothTouch) { outcome = "lost"; resultR = -1; break; }
      if (s.direction === "BUY") {
        if (b.h >= s.tp) { outcome = "won"; resultR = s.rr; break; }
        if (b.l <= s.sl) { outcome = "lost"; resultR = -1; break; }
      } else {
        if (b.l <= s.tp) { outcome = "won"; resultR = s.rr; break; }
        if (b.h >= s.sl) { outcome = "lost"; resultR = -1; break; }
      }
    }
    if (!outcome) {
      outcome = "expired";
      const b = bars[Math.min(n - 1, end)];
      const risk = Math.abs(s.entry - s.sl) || 1e-9;
      resultR = rnd((s.direction === "BUY" ? b.c - s.entry : s.entry - b.c) / risk, 2);
    }
    s.status = outcome;
    s.resultR = resultR;
  }
  // newest signal stays LIVE (event-only lifecycle — D-075)
  const lastBarT = bars[n - 1].t;
  const liveCandidate = [...seeds]
    .reverse()
    .find((s) => lastBarT - s.barTime <= 2 * tfSec && (s.status === "won" || s.status === "lost" || s.status === "expired" || s.status === "cancelled"));
  if (liveCandidate && liveCandidate.status !== "cancelled") {
    // only resurrect if it never actually resolved within its window
    const startIdx = bars.findIndex((b) => b.t === liveCandidate.barTime);
    const resolvedIn = bars
      .slice(startIdx + 1, Math.min(n, startIdx + SIGNAL_EXPIRY_BARS + 1))
      .some((b) =>
        liveCandidate.direction === "BUY"
          ? (b.h >= liveCandidate.tp || b.l <= liveCandidate.sl)
          : (b.l <= liveCandidate.tp || b.h >= liveCandidate.sl),
      );
    if (!resolvedIn) {
      liveCandidate.status = liveCandidate.entryType === "limit" ? "pending" : "active";
      liveCandidate.resultR = null;
    }
  }
}

function rnd(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
