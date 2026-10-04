/**
 * Signal engine — short-time trading edition (v2).
 *
 * The v1 baseline backtest (real MT5 history) measured:
 *   XAUUSDm M1 29% win · −24.7R · zone trigger fired 90% of signals
 *   XAUUSDm M5 38% win · −9.6R
 * Root causes found & fixed here (every line audited):
 *
 *  P1  zone retest always tried the BULL side first (hardcoded bias)
 *        → now bias-side first, counter-bias needs quality ≥ 0.62
 *  P2  zoneQuality's "size" term was x/(x+ε) ≈ 1 (meaningless)
 *        → replaced by ATR-relative tightness
 *  P3  pullback trend compared EMA to a raw close (unit mismatch)
 *        → EMA vs EMA slope (e21 vs e21[-5]) with slope floor
 *  P4  SFP wick threshold used ATR INCLUDING the trigger bar (the big
 *      wick inflated ATR, suppressing the very signals it measured)
 *        → aPrev = ATR of the bar BEFORE the trigger
 *  P5  zone entries were "edge touches": engagement = shallow touch of
 *      the proximal edge, close > zone mid — noise on M1
 *        → penetration ≥ 25% of zone height + close back OUT of the zone
 *          (mild in-zone rejection allowed at higher quality) + far-edge
 *          pierce rejection + fresh-zone requirement + height cap 1.25 ATR
 *  P6  geometry risk up to 2.2 ATR with 1.0R floor → far targets on M1
 *        → risk cap 1.8 ATR, min risk max(0.28·ATR, 4×spread),
 *          TP ladder floored 1.0R capped 2.0R (M1/M5) / 2.5R (M15+),
 *          fallback 1.4R, SL pad 0.25 ATR
 *  P7  MTF alignment auto-passed for zone triggers (inflated confidence)
 *        → zone triggers earn alignment like everything else
 *  P8  cooldown 4 bars for every trigger → 164 signals / 900 M1 bars
 *        → trigger-aware cooldown: sfp 4 · zone 6 · pullback 6
 *  P9  liquidity state came from the LAST bar only — pools swept 5 bars
 *      ago looked untouched (wrong TP targets + false confluence)
 *        → pools carry sweptT/runT timelines (smc.ts) and the engine
 *          filters as-of the trigger bar; liquidity_sweep factor now
 *          requires sweptT within the last 3 bars
 * P10  no volume/momentum confirmation anywhere
 *        → volume_surge + displacement confidence factors
 *
 * HARD gates (unchanged philosophy — the ONLY blockers):
 *   trigger · trigger-aware cooldown · ATR floor · spread sanity · geometry
 * Everything else modulates confidence: 0.45 + 0.5 × passRatio.
 */

import type { Candle, CheckItem, IndicatorSnapshot, SignalPayload } from "./types";
import {
  adx, atr, efficiencyRatio, ema, macd, rsi, stochastic, bollinger, volZ, sessionOf, last,
} from "./indicators";
import {
  detectStructure, detectOrderBlocks, detectFvg, detectLiquidity, detectSupplyDemand,
  premiumDiscount, type LiquidityPool, type StructureRead, type Zone,
} from "./smc";

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

/** trigger-aware cooldown, in bars of the signal timeframe */
export const COOLDOWN_BARS: Record<string, number> = { sfp: 4, zone: 6, pullback: 6 };
export const COOLDOWN_BARS_DEFAULT = 5;
/** hard sanity ceiling: spread in basis-points of price */
const MAX_SPREAD_BPS = 3.0;
/** ATR must exceed this fraction of price (dead-feed guard) */
const MIN_ATR_PCT = 0.0004;
/** signal + tracking expiry (bars) — SHARED by live tracking & backtest seed */
export const SIGNAL_EXPIRY_BARS = 30;

export interface EngineInput {
  symbol: string;
  timeframe: string;
  digits: number;
  spread: number; // in price units
  bars: Record<string, Candle[]>; // tf → bars (forming allowed; filtered here)
  lastSignalBarTime: number | null;
  lastSignalTrigger?: string | null;
  /** v14: broker server clock − UTC (30-min quantized). Threads into
   *  detectLiquidity so PDH/PDL cut at server-local midnight (= NY 17:00)
   *  instead of UTC midnight. 0 = unknown (open market / no offset yet). */
  brokerOffsetSec?: number;
}

export interface TriggerResult {
  kind: "sfp" | "zone" | "pullback";
  dir: "BUY" | "SELL";
  quality: number;
  note: string;
  sweepExtreme?: number;
  zone?: Zone & { quality: number };
}

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

// ═══════════════════════ triggers (direction-bearing) ═══════════════════════

/**
 * SFP: prior-20-bar extreme taken by wick, close back inside.
 * Wick threshold uses aPrev (ATR BEFORE the trigger bar) — the trigger's own
 * big wick must not raise the bar it is measured against (P4).
 */
export function detectSfp(bars: Candle[], aPrev: number, volConfirm = 0): TriggerResult | null {
  if (bars.length < 22 || aPrev <= 0) return null;
  const b = bars[bars.length - 1];
  const win = bars.slice(-21, -1);
  const hi = Math.max(...win.map((x) => x.h));
  const lo = Math.min(...win.map((x) => x.l));
  const range = b.h - b.l;
  if (range <= 0) return null;
  // bearish SFP: sweep of the prior high → SELL
  if (b.h > hi && b.c < hi) {
    const upperWick = b.h - Math.max(b.o, b.c);
    const wickRatio = upperWick / range;
    if (upperWick >= 0.35 * aPrev && wickRatio >= 0.35) {
      const thr = (0.35 * aPrev) / range;
      let q = Math.max(0.15, Math.min(1, (wickRatio - thr) / thr + 0.25));
      // rejection close position: strong SFPs close well off the high
      const closePos = (b.h - b.c) / range;
      q = Math.min(1, q * 0.82 + 0.18 * Math.min(1, closePos / 0.6));
      if (volConfirm >= 1.5) q = Math.min(1, q + 0.08);
      return {
        kind: "sfp",
        dir: "SELL",
        quality: q,
        note: `buy-side sweep of ${hi.toFixed(2)} rejected`,
        sweepExtreme: b.h,
      };
    }
  }
  // bullish SFP: sweep of the prior low → BUY
  if (b.l < lo && b.c > lo) {
    const lowerWick = Math.min(b.o, b.c) - b.l;
    const wickRatio = lowerWick / range;
    if (lowerWick >= 0.35 * aPrev && wickRatio >= 0.35) {
      const thr = (0.35 * aPrev) / range;
      let q = Math.max(0.15, Math.min(1, (wickRatio - thr) / thr + 0.25));
      const closePos = (b.c - b.l) / range;
      q = Math.min(1, q * 0.82 + 0.18 * Math.min(1, closePos / 0.6));
      if (volConfirm >= 1.5) q = Math.min(1, q + 0.08);
      return {
        kind: "sfp",
        dir: "BUY",
        quality: q,
        note: `sell-side sweep of ${lo.toFixed(2)} rejected`,
        sweepExtreme: b.l,
      };
    }
  }
  return null;
}

const BULL_ZONES = ["demand", "ob_bull", "fvg_bull"];
const BEAR_ZONES = ["supply", "ob_bear", "fvg_bear"];

/**
 * Zone retest — REAL rejections only (P5 + v16.8 audit hardening):
 *  · zone exists & fresh as-of the trigger bar (mitT null or == trigger t)
 *  · height ≤ 1.25 ATR (wide zones are noise magnets)
 *  · last 3 bars PENETRATED ≥ 40% of the zone height (was 25% — an edge
 *    kiss is not a test; v16.8)
 *  · LIQUIDITY SWEEP first: the test's wick took out the prior 20-bar
 *    low (bull) / high (bear) — a real ICT retest grabs stops before it
 *    turns; a touch without a sweep is just noise visiting the zone
 *  · MSS confirmation to fire: close back OUT of the zone (structure
 *    shift through the proximal edge), or an in-zone close only with a
 *    displacement body ≥ 0.6 ATR behind it
 *  · far edge not pierced (a close through the zone is a break, not a test)
 * Bias-side zones try first (P1); counter-bias zones need quality ≥ 0.62.
 */
export function detectZoneRetest(
  bars: Candle[], a: number, price: number, zones: Zone[],
  biasDir: "BUY" | "SELL" | "NEUTRAL" = "NEUTRAL",
): TriggerResult | null {
  if (!zones.length || a <= 0) return null;
  if (bars.length < 26) return null;
  const b = bars[bars.length - 1];
  const nowT = b.t;
  const win = bars.slice(-3);
  const prior = bars.slice(-23, -3); // the 20 bars before the test window
  const priorLo = prior.length ? Math.min(...prior.map((x) => x.l)) : Infinity;
  const priorHi = prior.length ? Math.max(...prior.map((x) => x.h)) : -Infinity;

  const trySide = (bull: boolean): TriggerResult | null => {
    const sides = bull ? BULL_ZONES : BEAR_ZONES;
    // v16.8: the sweep gate — the test window must take out the prior
    // 20-bar extreme on the zone's side (stops grabbed → real rejection)
    const swept = bull
      ? Math.min(...win.map((w) => w.l)) < priorLo
      : Math.max(...win.map((w) => w.h)) > priorHi;
    if (!swept) return null;
    const candidates = zones
      .filter((z) => sides.includes(z.side))
      // exists + not broken as-of now
      .filter((z) => z.t <= nowT && (z.brokenT == null || z.brokenT > nowT))
      // fresh as-of now (mitT == nowT means THIS bar is the first touch — ok)
      .filter((z) => z.mitT == null || z.mitT >= nowT)
      // sane height
      .filter((z) => z.hi - z.lo <= 1.25 * a)
      // near price
      .filter((z) => z.lo <= price + 1.2 * a && z.hi >= price - 1.2 * a);
    // closest zone first — the market is testing IT, not a distant memory
    const dist = (z: Zone) => (bull ? price - z.hi : z.lo - price);
    for (const z of [...candidates].sort((x, y) => Math.abs(dist(x)) - Math.abs(dist(y)))) {
      const zh = z.hi - z.lo;
      if (zh <= 0) continue;
      // penetration: last 3 bars entered the zone by ≥ 40% of its height
      const depth = bull
        ? z.hi - Math.min(...win.map((w) => w.l))
        : Math.max(...win.map((w) => w.h)) - z.lo;
      if (depth < 0.4 * zh) continue;
      const range = b.h - b.l;
      if (range <= 0) continue;
      const bodyPos = (b.c - b.l) / range;
      const lowerWick = Math.min(b.o, b.c) - b.l;
      const upperWick = b.h - Math.max(b.o, b.c);
      const mid = (z.hi + z.lo) / 2;
      const strongReject = bull ? b.c > z.hi : b.c < z.lo;
      const mildReject = bull ? b.c > mid : b.c < mid;
      // v16.8 MSS: an in-zone close only counts with displacement behind it
      const displaced = Math.abs(b.c - b.o) >= 0.6 * a;
      if (!strongReject && !(mildReject && displaced)) continue;
      // far-edge pierce = zone failed, not a retest
      const pierced = bull ? b.l < z.lo - 0.05 * a : b.h > z.hi + 0.05 * a;
      if (pierced) continue;
      const wickOk = bull ? lowerWick / range >= 0.28 : upperWick / range >= 0.28;
      const bodyOk = bull ? bodyPos >= 0.7 : bodyPos <= 0.3;
      if (!wickOk && !bodyOk) continue;
      // quality: freshness 42% · rejection wick 28% · penetration 15% · tightness 15%
      const freshness = z.mitT == null ? 1 : z.mitT >= nowT ? 0.9 : 0.4;
      const wickQ = Math.min(1, (bull ? lowerWick : upperWick) / range / 0.55);
      const penQ = Math.min(1, depth / zh / 0.7);
      const tightQ = 1 - 0.5 * Math.min(1, zh / (1.25 * a));
      let quality = 0.42 * freshness + 0.28 * wickQ + 0.15 * penQ + 0.15 * tightQ;
      if (strongReject) quality += 0.06; // full close back out of the zone
      if (displaced && !strongReject) quality += 0.04; // displacement MSS
      quality = Math.max(0.1, Math.min(1, quality));
      const withBias = biasDir === (bull ? "BUY" : "SELL");
      const minQ = withBias ? 0.5 : 0.62;
      if (quality < minQ) continue;
      return {
        kind: "zone",
        dir: bull ? "BUY" : "SELL",
        quality,
        note: `${z.side} sweep-retest ${z.lo.toFixed(2)}–${z.hi.toFixed(2)} ${strongReject ? "rejected (MSS)" : "holding + displacement"}`,
        zone: { ...z, quality },
      };
    }
    return null;
  };
  // bias side first (P1), then the other side
  const first = biasDir === "SELL" ? trySide(false) : trySide(true);
  return first ?? (biasDir === "SELL" ? trySide(true) : trySide(false));
}

/** Pullback: EMA21 SLOPE (e21 vs e21 five bars ago — P3) + touch + rejection. */
export function detectPullback(
  bars: Candle[], e21: number, e21Prev: number, a: number,
): TriggerResult | null {
  if (bars.length < 25 || a <= 0) return null;
  const b = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const slope = e21 - e21Prev;
  if (Math.abs(slope) < 0.08 * a) return null; // dead EMA — no trend to pull back to
  const rising = slope > 0;
  const falling = slope < 0;
  const range = b.h - b.l;
  if (range <= 0) return null;
  const bodyPos = (b.c - b.l) / range;
  const lowerWick = Math.min(b.o, b.c) - b.l;
  const upperWick = b.h - Math.max(b.o, b.c);
  if (rising && b.l <= e21 && b.c > prev.c && lowerWick / range >= 0.4 && bodyPos >= 0.5) {
    const q = 0.6 * (lowerWick / range) + 0.4 * bodyPos;
    return { kind: "pullback", dir: "BUY", quality: Math.min(1, q), note: `EMA21 pullback held (${e21.toFixed(2)})` };
  }
  if (falling && b.h >= e21 && b.c < prev.c && upperWick / range >= 0.4 && bodyPos <= 0.5) {
    const q = 0.6 * (upperWick / range) + 0.4 * (1 - bodyPos);
    return { kind: "pullback", dir: "SELL", quality: Math.min(1, q), note: `EMA21 pullback rejected (${e21.toFixed(2)})` };
  }
  return null;
}

// ═══════════════════════ geometry (setup-true SL/TP) ═══════════════════════

/** v16.8 (user audit): 0.25 → 0.5 ATR — market makers sweep 3–10 pips
 *  PAST zone lows before reversing; a 0.25-ATR pad planted the stop
 *  exactly in their sweep path. 0.5 ATR + half the live spread clears the
 *  wick-and-spread noise on XAUUSD instead of donating to it. */
const SL_PAD_ATR = 0.5;
const LIQ_PROTECT_ATR = 0.12;
const TP_MIN_RR = 0.8;
const TP_FLOOR_RR = 1.0;
const MAX_RISK_ATR = 1.8;
/** v16.8: a stop closer than half an ATR is wick-food by construction —
 *  the old 0.28 floor let "risk too small vs spread" be the only guard. */
const MIN_RISK_ATR = 0.5;
/** v16.7 — the PRICE-ANCHORED ENTRY CONTRACT (user spec):
 *  "প্রাইস যেই কারেন্ট প্রাইসে আছে, সেই প্রাইস লেভেল থেকে কনফার্মেশন
 *  অনুযায়ী এন্ট্রি বসাতে হবে" — an entry the trader can actually take from
 *  where the market IS. A limit may sit at most this far (in ATR) from the
 *  current price; beyond it the trigger bar IS the confirmation and the
 *  entry is the current price (market). Distant zone-edge wishes like
 *  "4210 গেলে buy নাও" while price sits at 4170 are gone — permanently. */
export const MAX_ENTRY_DIST_ATR = 0.75;

export interface Geometry {
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  targetNote: string;
  /** v16.7: |entry − price| / ATR at trigger time — the price-anchored
   *  contract's proof metric (backtest asserts max ≤ MAX_ENTRY_DIST_ATR). */
  entryDistAtr: number;
}

/** pools/zones usable as-of `asOfT` (no lookahead — P9) */
const poolUntouchedAsOf = (p: LiquidityPool, t: number) =>
  p.t <= t && (p.sweptT == null || p.sweptT > t) && (p.runT == null || p.runT > t);
const poolNotRunAsOf = (p: LiquidityPool, t: number) =>
  p.t <= t && (p.runT == null || p.runT > t);
const zoneAliveAsOf = (z: Zone, t: number) =>
  z.t <= t && (z.brokenT == null || z.brokenT > t);

export function setupGeometry(
  trig: TriggerResult,
  bars: Candle[],
  a: number,
  pools: LiquidityPool[],
  zones: Zone[],
  tf = "M15",
  /** v16.8: live spread (price units) — the SL pads clear it by design */
  spread = 0,
): Geometry | null {
  const bull = trig.dir === "BUY";
  const asOfT = bars[bars.length - 1].t;
  const price = bars[bars.length - 1].c;
  const scalp = tf === "M1" || tf === "M5";
  const pad = SL_PAD_ATR * a + 0.5 * spread; // structure pad + spread allowance
  let entry: number;
  let sl: number;

  if (trig.zone) {
    const z = trig.zone!;
    const inside = price >= z.lo && price <= z.hi;
    // v16.7 PRICE-ANCHOR: pick the entry candidate CLOSEST to the live
    // price (EQ inside the zone, proximal edge outside) — then clamp: if
    // even the closest candidate is farther than MAX_ENTRY_DIST_ATR, the
    // trigger bar's rejection close IS the confirmation and entry = price.
    const edge = bull ? z.hi : z.lo;
    const mid = (z.lo + z.hi) / 2;
    const cand = inside ? mid : edge; // EQ inside · proximal edge outside
    entry = Math.abs(cand - price) <= MAX_ENTRY_DIST_ATR * a ? cand : price;
    sl = bull ? z.lo - pad : z.hi + pad;
  } else if (trig.kind === "sfp" && trig.sweepExtreme != null) {
    entry = price;
    sl = bull ? trig.sweepExtreme - pad : trig.sweepExtreme + pad;
  } else {
    const win = bars.slice(-3);
    const microLo = Math.min(...win.map((b) => b.l));
    const microHi = Math.max(...win.map((b) => b.h));
    entry = price;
    sl = bull ? microLo - pad : microHi + pad;
  }

  // liquidity protection: extend past the deepest same-side pool within 1.6 ATR
  // that is still LIVE as-of now (a pool already RUN is broken structure — P9)
  for (const p of pools) {
    const sameSide = bull ? p.side === "SSL" : p.side === "BSL";
    if (!sameSide || !poolNotRunAsOf(p, asOfT)) continue;
    const near = Math.abs(p.price - entry) <= 1.6 * a;
    if (near) {
      sl = bull ? Math.min(sl, p.price - LIQ_PROTECT_ATR * a) : Math.max(sl, p.price + LIQ_PROTECT_ATR * a);
    }
  }

  const risk = Math.abs(entry - sl);
  if (risk <= 0 || risk > MAX_RISK_ATR * a) return null;

  // TP ladder: nearest opposing structure beyond 0.8R that is ALIVE as-of now
  const targets: { price: number; note: string }[] = [];
  for (const p of pools) {
    const opposing = bull ? p.side === "BSL" : p.side === "SSL";
    if (opposing && poolUntouchedAsOf(p, asOfT)) {
      targets.push({ price: p.price, note: `${p.side} ${p.state}` });
    }
  }
  for (const z of zones) {
    const opposing = bull
      ? ["supply", "ob_bear", "fvg_bear"].includes(z.side)
      : ["demand", "ob_bull", "fvg_bull"].includes(z.side);
    if (opposing && zoneAliveAsOf(z, asOfT)) {
      targets.push({ price: bull ? z.lo : z.hi, note: `${z.side} zone edge` });
    }
  }
  const valid = targets
    .filter((t) => (bull ? t.price > entry + TP_MIN_RR * risk : t.price < entry - TP_MIN_RR * risk))
    .sort((x, y) => (bull ? x.price - y.price : y.price - x.price));
  const capR = scalp ? 2.0 : 2.5;
  let tp: number;
  let targetNote: string;
  if (valid.length) {
    tp = bull ? valid[0].price - 0.15 * a : valid[0].price + 0.15 * a;
    targetNote = valid[0].note;
  } else {
    tp = bull ? entry + 1.4 * risk : entry - 1.4 * risk;
    targetNote = "fallback 1.4R";
  }
  const rrRaw = Math.abs(tp - entry) / risk;
  if (rrRaw < TP_FLOOR_RR) tp = bull ? entry + TP_FLOOR_RR * risk : entry - TP_FLOOR_RR * risk;
  if (rrRaw > capR) tp = bull ? entry + capR * risk : entry - capR * risk;
  const rr = Math.abs(tp - entry) / risk;
  return { entry, sl, tp, rr, targetNote, entryDistAtr: Math.abs(entry - price) / (a || 1) };
}

// ═══════════════════════ soft-check bundle ═══════════════════════

export interface SoftChecks {
  checks: CheckItem[];
  factors: string[];
  passRatio: number;
}

/** Informational checks + confluence factors → confidence modulation. */
export function softChecks(
  trig: TriggerResult,
  ctx: {
    bars: Candle[];
    tf: string;
    a: number;
    r: number;
    biasDir: "BUY" | "SELL" | "NEUTRAL";
    structure: StructureRead;
    stH1: string;
    stH4: string;
    stM15: string;
    stM5: string;
    pools: LiquidityPool[];
    zones: Zone[];
    pd: ReturnType<typeof premiumDiscount>;
    spreadBps: number;
    mtfAligned: boolean;
    volZNow: number;
  },
): SoftChecks {
  const bull = trig.dir === "BUY";
  const b = ctx.bars[ctx.bars.length - 1];
  const price = b.c;
  const tfSec = TF_SEC[ctx.tf] ?? 900;
  const checks: CheckItem[] = [];
  const factors: string[] = [];

  const biasOk = ctx.biasDir === trig.dir;
  checks.push({ name: "Bias agree", ok: biasOk, value: `${ctx.biasDir} · ${trig.dir}` });
  if (biasOk) factors.push("bias_aligned");

  checks.push({ name: "MTF aligned", ok: ctx.mtfAligned, value: ctx.mtfAligned ? "yes" : "no" });
  if (ctx.mtfAligned) factors.push("mtf_aligned");

  const rsiWin = bull ? ctx.r >= 30 && ctx.r <= 68 : ctx.r >= 32 && ctx.r <= 70;
  checks.push({ name: "RSI window", ok: rsiWin, value: ctx.r.toFixed(1) });
  if (rsiWin) factors.push("rsi_aligned");

  const sess = sessionOf(b.t);
  const sessOk = sess === "london" || sess === "newyork" || sess === "overlap"; // v16.8: the London–NY overlap is PRIME tape
  checks.push({ name: "Prime session", ok: sessOk, value: sess });
  if (sessOk) factors.push("prime_session");

  checks.push({ name: "Spread", ok: ctx.spreadBps <= 1.5, value: `${ctx.spreadBps.toFixed(2)} bps` });

  // confluence factors
  if (ctx.structure.trend === (bull ? "bullish" : "bearish")) factors.push("structure_tf");
  const htfMajority = [ctx.stH4, ctx.stH1, ctx.stM15, ctx.structure.trend].filter((t) => t === (bull ? "bullish" : "bearish")).length >= 2;
  if (htfMajority) factors.push("htf_structure");
  const obRetest = ctx.zones.some((z) =>
    (bull ? z.side === "ob_bull" || z.side === "demand" : z.side === "ob_bear" || z.side === "supply") &&
    zoneAliveAsOf(z, b.t) &&
    price >= z.lo - 0.2 * ctx.a && price <= z.hi + 0.2 * ctx.a,
  );
  if (obRetest) factors.push("ob_retest");
  // liquidity sweep: an opposing pool actually SWEPT in the last 3 bars (P9)
  const liqSweep = ctx.pools.some((p) =>
    (bull ? p.side === "SSL" : p.side === "BSL") &&
    p.sweptT != null && b.t - p.sweptT <= 3 * tfSec,
  );
  if (liqSweep) factors.push("liquidity_sweep");
  const inZone = ctx.zones.some((z) =>
    (bull ? BULL_ZONES : BEAR_ZONES).includes(z.side) &&
    zoneAliveAsOf(z, b.t) &&
    price >= z.lo && price <= z.hi,
  );
  if (inZone) factors.push("zone");
  if (ctx.volZNow >= 2.2) factors.push("whale_pulse");
  else if (ctx.volZNow >= 1.5) factors.push("volume_surge"); // P10
  if (ctx.pd.state === (bull ? "discount" : "premium")) factors.push("premium_discount");
  if (trig.kind === "sfp") factors.push("sfp_rejection");
  if (trig.kind === "zone") {
    factors.push("zone_rejection");
    if (trig.zone && trig.zone.mitT == null) factors.push("fresh_zone");
  }
  if (trig.kind === "pullback") factors.push("trend_pullback");
  // displacement: trigger bar body ≥ 0.55 ATR (momentum behind the rejection)
  if (Math.abs(b.c - b.o) >= 0.55 * ctx.a) factors.push("displacement");

  const passed = checks.filter((c) => c.ok).length;
  return { checks, factors, passRatio: passed / checks.length };
}

// ═══════════════════════ live evaluation ═══════════════════════

export function evaluate(input: EngineInput): {
  signal: SignalPayload | null;
  nearMiss: string[];
  checks: CheckItem[];
  biasScore: number;
  biasDir: "BUY" | "SELL" | "NEUTRAL";
  triggers: { sfp: boolean; zone: boolean; pullback: boolean };
  snapshot: IndicatorSnapshot;
  context: {
    structure: StructureRead;
    pools: LiquidityPool[];
    zones: Zone[];
    pd: ReturnType<typeof premiumDiscount>;
    lastBar: Candle | null;
  };
} {
  const tf = input.timeframe;
  const bars = (input.bars[tf] ?? []).filter((b) => !b.f);
  // v16.3: NO MORE SILENT M1 FALLBACK — the old `bars.length > 30 ? bars : m1`
  // evaluated triggers on M1 bars when the active tf was short on history,
  // but still emitted SignalPayload.timeframe=<active tf> with M1 barTimes:
  // cooldowns divided M1 stamps by the active tf's seconds, and mislabeled
  // rows persisted to the DB. The honest answer for a short series is the
  // "not enough history" nearMiss below.
  const base = bars;
  const nearMiss: string[] = [];
  const checks: CheckItem[] = [];

  if (base.length < 60) {
    return {
      signal: null,
      nearMiss: ["not enough history"],
      checks,
      biasScore: 0,
      biasDir: "NEUTRAL",
      triggers: { sfp: false, zone: false, pullback: false },
      snapshot: emptySnapshot(),
      context: {
        structure: { trend: "neutral", events: [], labels: [] },
        pools: [], zones: [], pd: premiumDiscount(base.length ? base : [{ t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 }], 60, 0),
        lastBar: base.length ? base[base.length - 1] : null,
      },
    };
  }

  const lastBar = base[base.length - 1];
  const price = lastBar.c;
  const closes = base.map((b) => b.c);
  const atrArr = atr(base, 14);
  const a = (last(atrArr) as number) || 0;
  const aPrev = (atrArr[atrArr.length - 2] as number) || a; // P4
  const rsiArr = rsi(base, 14);
  const r = (last(rsiArr) as number) ?? 50;
  const ema21Arr = ema(closes, 21);
  const e21 = (last(ema21Arr) as number) ?? price;
  const e21Prev = (ema21Arr[ema21Arr.length - 6] as number) ?? e21; // P3
  const e50 = (last(ema(closes, 50)) as number) ?? price;
  const e9 = (last(ema(closes, 9)) as number) ?? price;
  const vz = volZ(base);

  // ── multi-source direction bias (confidence input, never a gate) ──
  const h1 = (input.bars.H1 ?? []).filter((b) => !b.f);
  const h4 = (input.bars.H4 ?? []).filter((b) => !b.f);
  const m15 = (input.bars.M15 ?? []).filter((b) => !b.f);
  const m5 = (input.bars.M5 ?? []).filter((b) => !b.f);
  const h1Close = h1.length ? h1[h1.length - 1].c : price;
  const h1E50 = h1.length > 60 ? (last(ema(h1.map((b) => b.c), 50)) as number) : null;
  const h1E20 = h1.length > 40 ? (last(ema(h1.map((b) => b.c), 20)) as number) : null;
  const stH1 = h1.length > 40 ? detectStructure(h1.slice(-120)).trend : "neutral";
  const stH4 = h4.length > 40 ? detectStructure(h4.slice(-120)).trend : "neutral";
  const stM15 = m15.length > 40 ? detectStructure(m15.slice(-120)).trend : "neutral";
  const structure = detectStructure(base.slice(-150));
  const stM5 = m5.length > 40 ? detectStructure(m5.slice(-120)).trend : "neutral";

  let biasScore = 0;
  if (h1E50 != null) biasScore += 0.3 * Math.sign(h1Close - h1E50);
  biasScore += 0.2 * trendSign(stH4);
  biasScore += 0.2 * trendSign(stH1);
  biasScore += 0.2 * trendSign(stM15);
  if (h1E20 != null && h1E50 != null) biasScore += 0.1 * Math.sign(h1E20 - h1E50);
  const biasDir: "BUY" | "SELL" | "NEUTRAL" =
    Math.abs(biasScore) >= 0.3 ? (biasScore > 0 ? "BUY" : "SELL") : "NEUTRAL";

  // ── SMC reads ──
  // v14: brokerOffsetSec → PDH/PDL day cut at server-local midnight (NY 17:00)
  const pools = detectLiquidity(base, 0.15, 3, input.brokerOffsetSec ?? 0);
  const zones = [...detectSupplyDemand(base.slice(-240)), ...detectOrderBlocks(base.slice(-240)), ...detectFvg(base.slice(-240))];
  const pd = premiumDiscount(base, 60, price);

  // ── triggers (quality arbitration; direction from the trigger) ──
  const trigSfp = detectSfp(base, aPrev, vz);
  const trigZone = detectZoneRetest(base, a, price, zones, biasDir);
  const trigPullback = detectPullback(base, e21, e21Prev, a);
  const candidates = [trigSfp, trigZone, trigPullback].filter(Boolean) as TriggerResult[];
  // with-bias triggers win ties (bias as a tiebreak, not a gate)
  candidates.sort((x, y) => (y.quality + (biasDir === y.dir ? 0.1 : 0)) - (x.quality + (biasDir === x.dir ? 0.1 : 0)));
  const best = candidates[0] ?? null;

  const spreadBps = price > 0 ? (input.spread / price) * 10_000 : 0;

  checks.push({ name: "Trigger", ok: !!best, value: best ? `${best.kind} ${best.dir} q=${best.quality.toFixed(2)}` : "none" });
  if (!best) nearMiss.push("no trigger (sweep / zone-retest / pullback)");

  // ── v16.8 HARD COUNTER-TREND FILTER (user audit) ──
  // The old code only shaved −0.05 confidence off a signal fighting the
  // H1/H4 multi-source bias — those were the "এন্ট্রি নিলেই SL" trades: an
  // M5 bullish wick inside a hard H4 downtrend is liquidity, not a reversal.
  // Now: NO signal against a non-neutral bias, period. NEUTRAL bias (range
  // regime) keeps both directions live.
  if (best && biasDir !== "NEUTRAL" && biasDir !== best.dir) {
    nearMiss.push(`counter-trend blocked (bias ${biasDir} vs ${best.dir})`);
  }

  // ── HARD GATES ──
  if (a < MIN_ATR_PCT * price) {
    nearMiss.push(`ATR ${a.toFixed(2)} below sanity floor`);
  }
  if (spreadBps > MAX_SPREAD_BPS) {
    nearMiss.push(`spread ${spreadBps.toFixed(1)} bps — feed sanity`);
  }
  if (input.lastSignalBarTime != null) {
    const tfSec = TF_SEC[tf] ?? 900;
    const barsSince = (lastBar.t - input.lastSignalBarTime) / tfSec;
    const cd = best
      ? (COOLDOWN_BARS[best.kind] ?? COOLDOWN_BARS_DEFAULT)
      : (COOLDOWN_BARS[input.lastSignalTrigger ?? ""] ?? COOLDOWN_BARS_DEFAULT);
    if (barsSince < cd) nearMiss.push(`cooldown (${cd} bars)`);
  }

  let signal: SignalPayload | null = null;

  if (best && nearMiss.length === 0) {
    const bull = best.dir === "BUY";

    // MTF alignment (soft) — zone triggers earn it like everything else (P7)
    let mtfScore = 0;
    for (const series of [m5, m15]) {
      if (series.length > 60) {
        const em = last(ema(series.map((b) => b.c), 50)) as number;
        const cl = series[series.length - 1].c;
        if (bull ? cl > em : cl < em) mtfScore += 0.5;
      }
    }
    const mtfAligned = mtfScore >= 0.5;

    const soft = softChecks(best, {
      bars: base, tf, a, r, biasDir, structure,
      stH1, stH4, stM15, stM5, pools, zones, pd,
      spreadBps, mtfAligned, volZNow: vz,
    });

    // ── geometry ──
    const geo = setupGeometry(best, base, a, pools, zones, tf, input.spread);
    if (!geo) {
      nearMiss.push("geometry rejected (risk too wide vs ATR)");
    } else {
      const risk = Math.abs(geo.entry - geo.sl) || 1e-9;
      if (risk < Math.max(MIN_RISK_ATR * a, 4 * input.spread)) {
        nearMiss.push("risk too small vs spread");
      } else {
        const spreadVsRisk = risk > 0 ? input.spread / risk : 1;
        if (spreadVsRisk > 0.35) {
          nearMiss.push("spread > 35% of risk");
        } else {
          // ── confidence: reference formula (0.45 + 0.5 × passRatio) ──
          let confidence = 0.45 + 0.5 * soft.passRatio;
          if (soft.factors.length >= 5) confidence += 0.05;
          if (best.quality >= 0.7) confidence += 0.03;
          // (v16.8: the old −0.05 counter-trend penalty is gone — the hard
          // filter above already blocks those signals outright)
          confidence = Math.max(0.4, Math.min(0.95, confidence));

          const entryType: "market" | "limit" =
            Math.abs(geo.entry - price) > Math.max(0.35 * a, 2 * input.spread, 1) ? "limit" : "market";

          signal = {
            symbol: input.symbol,
            timeframe: tf,
            direction: best.dir,
            trigger: best.kind,
            entryType,
            entry: round(geo.entry, input.digits),
            sl: round(geo.sl, input.digits),
            tp: round(geo.tp, input.digits),
            rr: round(geo.rr, 2),
            confidence: round(confidence, 3),
            status: entryType === "limit" ? "pending" : "active",
            barTime: lastBar.t,
            targetNote: geo.targetNote,
            entryNote: best.note,
            factors: soft.factors,
            checks: [...checks, ...soft.checks],
          };
        }
      }
    }
  }

  const snapshot = buildSnapshot(base, input, a, r, e9, e21, e50, structure, stH4, stH1, stM15, stM5);
  return {
    signal,
    nearMiss: [...new Set(nearMiss)],
    checks,
    biasScore,
    biasDir,
    triggers: { sfp: !!trigSfp, zone: !!trigZone, pullback: !!trigPullback },
    snapshot,
    context: { structure, pools, zones, pd, lastBar },
  };
}

// ═══════════════════════ snapshot ═══════════════════════

function buildSnapshot(
  base: Candle[],
  input: EngineInput,
  a: number,
  r: number,
  e9: number,
  e21: number,
  e50: number,
  structure: StructureRead,
  stH4: string,
  stH1: string,
  stM15: string,
  stM5: string,
): IndicatorSnapshot {
  const m = macd(base);
  const st = stochastic(base);
  const bb = bollinger(base);
  const er = efficiencyRatio(base, 20);
  const adxV = adx(base, 14);
  const volRatio = a / (medianAtr(base) || a);
  const regime =
    volRatio <= 0.75 ? "quiet" : volRatio <= 1.25 ? "normal" : volRatio <= 1.75 ? "elevated" : "extreme";
  const trendType = er >= 0.3 || adxV >= 28 ? "trend" : er <= 0.18 ? "range" : "mixed";
  const win = base.slice(-6);
  let buyVol = 0, totalVol = 0;
  for (const b of win) {
    const range = b.h - b.l;
    if (range <= 0) continue;
    const delta = ((b.c - b.l) / range) * 2 - 1;
    buyVol += ((delta + 1) / 2) * b.v;
    totalVol += b.v;
  }
  const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
  const vz = volZ(base);
  const lastBar = base[base.length - 1];
  const whaleBody = Math.abs(lastBar.c - lastBar.o);
  const whaleRange = lastBar.h - lastBar.l || 1e-9;
  const whale = vz >= 2.2
    ? {
        bias: whaleBody >= 0.6 * whaleRange && lastBar.c > lastBar.o ? "bullish"
          : whaleBody >= 0.6 * whaleRange ? "bearish"
          : "absorption",
        note: `volume z=${vz.toFixed(1)} institutional bar`,
      }
    : null;

  return {
    rsi: r,
    atr: a,
    adx: adxV,
    er,
    macdHist: (last(m.hist) as number) ?? 0,
    stochK: (last(st.k) as number) ?? 50,
    stochD: (last(st.d) as number) ?? 50,
    bbUpper: (last(bb.upper) as number) ?? 0,
    bbLower: (last(bb.lower) as number) ?? 0,
    bbPctB: (last(bb.pctB) as number) ?? 0.5,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    volZ: vz,
    regime: `${regime} · ${trendType}`,
    regimeNote: `vol×${volRatio.toFixed(2)} · ER ${er.toFixed(2)} · ADX ${adxV.toFixed(0)}`,
    trendM5: stM5,
    trendM15: stM15,
    trendH1: stH1,
    trendH4: stH4,
    battle: {
      buyPct,
      sellPct: 100 - buyPct,
      state: buyPct >= 72 ? "buy-dominant" : 100 - buyPct >= 72 ? "sell-dominant" : "tug-of-war",
    },
    whale,
  };
}

function medianAtr(bars: Candle[]): number {
  const arr = atr(bars, 14).filter((v) => v != null) as number[];
  if (!arr.length) return 0;
  const tail = arr.slice(-300);
  tail.sort((x, y) => x - y);
  return tail[Math.floor(tail.length / 2)];
}

function emptySnapshot(): IndicatorSnapshot {
  return {
    rsi: 50, atr: 0, adx: 0, er: 0, macdHist: 0, stochK: 50, stochD: 50,
    bbUpper: 0, bbLower: 0, bbPctB: 0.5, ema9: 0, ema21: 0, ema50: 0, volZ: 0,
    regime: "—", regimeNote: "", trendM5: "—", trendM15: "—", trendH1: "—", trendH4: "—",
    battle: { buyPct: 50, sellPct: 50, state: "—" },
    whale: null,
  };
}

function trendSign(t: string): number {
  return t === "bullish" ? 1 : t === "bearish" ? -1 : 0;
}

function round(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

export { FIB_RATIOS };
