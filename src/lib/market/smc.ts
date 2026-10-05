/**
 * Smart-Money-Concepts analysis — exact port of the reference engine:
 * market structure (BOS/CHoCH), order blocks, fair value gaps, liquidity
 * pools & sweeps, supply/demand zones, premium/discount + OTE.
 */

import type { Candle } from "./types";
import { atr, swings, type Swing } from "./indicators";

// ───────────────────────── structure: BOS / CHoCH ─────────────────────────

export interface StructureEvent {
  t: number;
  price: number;
  dir: "up" | "down";
  label: "BOS" | "CHoCH";
  index: number;
  /** the swing origin the break came from (for the break-line drawing) */
  fromT?: number;
}

export interface StructureRead {
  trend: "bullish" | "bearish" | "neutral";
  events: StructureEvent[];
  labels: { index: number; t: number; price: number; tag: "HH" | "HL" | "LH" | "LL"; side: "high" | "low" }[];
}

/**
 * v16.9 (audit §5.2) — MAJOR structure swings: 3-left/3-right fractals.
 * History: 2/2 (v16.7) turned every micro-wick into a "swing"; v16.8 went
 * to 5/5, but a swing confirming 5 bars late means 11+ bars of lag — on
 * M5 that is ~an hour, and every real CHoCH reversal arrived AFTER the
 * move was gone (the audit's "লেগি স্ট্রাকচার" finding). 3/3 keeps the
 * major-structure filter (noise still needs 3 clean bars each side) while
 * cutting confirmation lag to 3 bars.
 */
export function detectStructure(bars: Candle[], left = 3, right = 3, maxEvents = 6): StructureRead {
  const sw = swings(bars, left, right);
  // label swings HH/LH/HL/LL vs previous same-kind — in swing order, each
  // label remembered WITH its swing index so the event walk can vote the
  // structure trend AS-OF any bar (no lookahead: a label joins the story
  // only once its swing is confirmed, right bars later).
  const labels: StructureRead["labels"] = [];
  const labelSwingIdx: number[] = [];
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  for (let si = 0; si < sw.length; si++) {
    const s = sw[si];
    if (s.kind === "high") {
      if (lastHigh) {
        labels.push({
          index: s.index, t: s.t, price: s.price,
          tag: s.price > lastHigh.price ? "HH" : "LH",
          side: "high",
        });
        labelSwingIdx.push(si);
      }
      lastHigh = s;
    } else {
      if (lastLow) {
        labels.push({
          index: s.index, t: s.t, price: s.price,
          tag: s.price > lastLow.price ? "HL" : "LL",
          side: "low",
        });
        labelSwingIdx.push(si);
      }
      lastLow = s;
    }
  }
  // v16.8 trend vote: the LAST 6 labels, newest heaviest (weighted recent
  // emphasis) — the old 4-label plain count called a 10-label bull run
  // "neutral" the moment a pullback printed 2 bear tags.
  const vote = (upto: number): "bullish" | "bearish" | "neutral" => {
    const recent = labels.slice(Math.max(0, upto - 6), upto);
    let bull = 0;
    let bear = 0;
    for (let i = 0; i < recent.length; i++) {
      const w = recent.length - i; // newest = heaviest
      if (recent[i].tag === "HH" || recent[i].tag === "HL") bull += w;
      else bear += w;
    }
    return bull > bear ? "bullish" : bear > bull ? "bearish" : "neutral";
  };
  const trend = vote(labels.length);

  // events: walk bars; a close beyond the last CONFIRMED swing is a break.
  // v16.8 BOS vs CHoCH — referenced against the STRUCTURE TREND (the label
  // vote), not the previous break's direction: a break WITH the trend is
  // BOS (continuation); a break AGAINST it is CHoCH (first crack / MSS).
  // The old prevBreakDir logic relabeled range chop as CHoCH on every flip.
  const events: StructureEvent[] = [];
  let pendHigh: Swing | null = null;
  let pendLow: Swing | null = null;
  let swIdx = 0;
  let confirmed = 0; // labels whose swing has confirmed as-of bar i
  for (let i = 0; i < bars.length; i++) {
    while (swIdx < sw.length && sw[swIdx].index + right <= i) {
      const s = sw[swIdx];
      if (s.kind === "high") pendHigh = s;
      else pendLow = s;
      swIdx++;
    }
    while (confirmed < labels.length && labelSwingIdx[confirmed] < swIdx) confirmed++;
    const b = bars[i];
    if (pendHigh && b.c > pendHigh.price) {
      const dir: "up" | "down" = "up";
      events.push({
        t: b.t, price: pendHigh.price, dir, index: i, fromT: pendHigh.t,
        label: vote(confirmed) === "bearish" ? "CHoCH" : "BOS",
      });
      pendHigh = null;
    } else if (pendLow && b.c < pendLow.price) {
      const dir: "up" | "down" = "down";
      events.push({
        t: b.t, price: pendLow.price, dir, index: i, fromT: pendLow.t,
        label: vote(confirmed) === "bullish" ? "CHoCH" : "BOS",
      });
      pendLow = null;
    }
  }
  return { trend, events: events.slice(-maxEvents), labels };
}

// ───────────────────────── order blocks ─────────────────────────

export interface Zone {
  side: "ob_bull" | "ob_bear" | "supply" | "demand" | "fvg_bull" | "fvg_bear";
  lo: number;
  hi: number;
  t: number; // origin bar time
  mitT?: number; // mitigation time — first later bar overlapping the zone
  filled?: boolean;
  fillPct?: number;
  gapAtr?: number;
  /** first close beyond the far edge (zone broken) — as-of filterable */
  brokenT?: number;
}

/**
 * v16.8 (user audit) — ICT-true order blocks:
 *  · zone = the FULL candle range (wick to wick) — mitigation can come from
 *    any part of the candle; a body-only zone is half an OB
 *  · the OB candle must SWEEP liquidity (take out the prior confirmed
 *    swing low for a bull OB / swing high for a bear OB)
 *  · the impulse must BREAK structure (a close beyond the last confirmed
 *    swing high/low within the next bars) — every ordinary retracement
 *    candle used to get an OB tag; those false zones are gone
 */
export function detectOrderBlocks(bars: Candle[], impulseAtr = 1.2): Zone[] {
  const a = atr(bars);
  // minor (2/2) swings for sweep validation — liquidity rests at minor pivots
  const sw = swings(bars, 2, 2);
  const highs = sw.filter((s) => s.kind === "high");
  const lows = sw.filter((s) => s.kind === "low");
  /** last CONFIRMED swing-high price strictly before bar k (null = none) */
  const lastHighBefore = (k: number): number | null => {
    let v: number | null = null;
    for (const s of highs) {
      if (s.index + 2 > k) break;
      v = s.price;
    }
    return v;
  };
  const lastLowBefore = (k: number): number | null => {
    let v: number | null = null;
    for (const s of lows) {
      if (s.index + 2 > k) break;
      v = s.price;
    }
    return v;
  };
  const out: Zone[] = [];
  for (let k = 0; k + 1 < bars.length; k++) {
    const atrK = a[k];
    if (atrK == null) continue;
    const body1 = Math.abs(bars[k + 1].c - bars[k + 1].o);
    if (body1 < impulseAtr * atrK) continue;
    const downK = bars[k].c < bars[k].o;
    const upNext = bars[k + 1].c > bars[k + 1].o;
    if (downK && upNext) {
      // bull OB: sweep of the prior swing low + impulse closes above the
      // last confirmed swing high (BOS) within 6 bars
      const priorLow = lastLowBefore(k);
      const swept = priorLow != null && bars[k].l < priorLow;
      const priorHigh = lastHighBefore(k);
      let bos = false;
      for (let j = k + 1; j <= Math.min(k + 6, bars.length - 1); j++) {
        if (priorHigh != null && bars[j].c > priorHigh) { bos = true; break; }
      }
      if (swept && bos) {
        out.push({ side: "ob_bull", lo: bars[k].l, hi: bars[k].h, t: bars[k].t });
      }
    } else if (!downK && !upNext) {
      // bear OB: sweep of the prior swing high + impulse closes below the
      // last confirmed swing low (BOS) within 6 bars
      const priorHigh = lastHighBefore(k);
      const swept = priorHigh != null && bars[k].h > priorHigh;
      const priorLow = lastLowBefore(k);
      let bos = false;
      for (let j = k + 1; j <= Math.min(k + 6, bars.length - 1); j++) {
        if (priorLow != null && bars[j].c < priorLow) { bos = true; break; }
      }
      if (swept && bos) {
        out.push({ side: "ob_bear", lo: bars[k].l, hi: bars[k].h, t: bars[k].t });
      }
    }
  }
  // timeline per zone: mitigation (first overlap) + broken (first close
  // beyond the far edge) — as-of filterable like supply/demand
  for (const z of out) {
    const startIdx = bars.findIndex((b) => b.t === z.t);
    if (startIdx < 0) continue;
    for (let i = startIdx + 1; i < bars.length; i++) {
      const b = bars[i];
      if (z.mitT == null && b.l <= z.hi && b.h >= z.lo) z.mitT = b.t;
      if (z.side === "ob_bull" && b.c < z.lo) { z.brokenT = b.t; break; }
      if (z.side === "ob_bear" && b.c > z.hi) { z.brokenT = b.t; break; }
    }
  }
  return out;
}

/** FVG: bullish when h[k-1] < l[k+1] (gap band), bearish mirrored. */
export function detectFvg(bars: Candle[]): (Zone & { gap: number; disp: number })[] {
  const a = atr(bars);
  const out: (Zone & { gap: number; disp: number })[] = [];
  for (let k = 1; k + 1 < bars.length; k++) {
    const atrK = a[k] ?? 0;
    if (bars[k - 1].h < bars[k + 1].l) {
      const lo = bars[k - 1].h;
      const hi = bars[k + 1].l;
      const gap = hi - lo;
      const disp = Math.abs(bars[k + 1].c - bars[k - 1].o);
      let fillPct = 0;
      let mitT: number | undefined;
      for (let i = k + 2; i < bars.length; i++) {
        if (bars[i].l <= hi) {
          if (mitT == null) mitT = bars[i].t;
          // v16.8: track the fill ALL THE WAY to 100% — the old `>= 0.5
          // break` froze the gap at half-filled forever, so fully-mitigated
          // FVGs kept signaling like fresh ones.
          fillPct = Math.min(1, (hi - bars[i].l) / Math.max(1e-9, gap));
          if (fillPct >= 1) break;
        }
      }
      out.push({ side: "fvg_bull", lo, hi, t: bars[k].t, mitT, gap, gapAtr: atrK ? gap / atrK : 0, disp: atrK ? disp / atrK : 0, fillPct, filled: fillPct >= 1 });
    } else if (bars[k + 1].h < bars[k - 1].l) {
      const lo = bars[k + 1].h;
      const hi = bars[k - 1].l;
      const gap = hi - lo;
      const disp = Math.abs(bars[k + 1].c - bars[k - 1].o);
      let fillPct = 0;
      let mitT: number | undefined;
      for (let i = k + 2; i < bars.length; i++) {
        if (bars[i].h >= lo) {
          if (mitT == null) mitT = bars[i].t;
          // v16.8: same full-fill tracking on the bearish side
          fillPct = Math.min(1, (bars[i].h - lo) / Math.max(1e-9, gap));
          if (fillPct >= 1) break;
        }
      }
      out.push({ side: "fvg_bear", lo, hi, t: bars[k].t, mitT, gap, gapAtr: atrK ? gap / atrK : 0, disp: atrK ? disp / atrK : 0, fillPct, filled: fillPct >= 1 });
    }
  }
  return out;
}

// ───────────────────────── liquidity ─────────────────────────

export interface LiquidityPool {
  side: "BSL" | "SSL";
  price: number;
  t: number; // availability time — pool is tradable FROM here (no lookahead)
  hits: number;
  state: "untouched" | "swept" | "run";
  /** first wick-beyond-and-close-back time (stops grabbed) */
  sweptT?: number;
  /** first close-beyond time (level consumed / broken) */
  runT?: number;
}

/**
 * Equal highs/lows (within 0.15 ATR) + prior-day high/low → pools.
 * Each pool carries its own TIMELINE (sweptT / runT) computed by walking the
 * real bars forward from availability — so historical sweeps are visible
 * (the old last-bar-only check missed every sweep that wasn't on the very
 * last bar) and the walk-forward backtest can filter pools as-of any bar.
 *
 * v12.1 LOOKAHEAD FIX: the equal-high tolerance is the ATR as of the pool's
 * CONFIRMATION bar (atrAll[availIdx]), not `lastAtr(bars)` — the whole-series
 * last value is "today's" volatility applied to last week's pools.
 */
export function detectLiquidity(bars: Candle[], tolAtr = 0.15, maxPerSide = 3, brokerOffsetSec = 0): LiquidityPool[] {
  const atrAll = atr(bars);
  const sw = swings(bars, 2, 2);
  const pools: LiquidityPool[] = [];

  /** ATR as of bar index idx (falls back to the last valid value). */
  const atrAt = (idx: number): number => {
    const v = atrAll[Math.max(0, Math.min(bars.length - 1, idx))];
    if (v != null) return v as number;
    for (let i = atrAll.length - 1; i >= 0; i--) if (atrAll[i] != null) return atrAll[i] as number;
    return 1;
  };

  // equal highs → BSL above; available once the 2nd equal high confirms
  const highs = sw.filter((s) => s.kind === "high").slice(-8);
  for (let i = 0; i + 1 < highs.length; i++) {
    const second = highs[i + 1];
    const availIdx = Math.min(bars.length - 1, second.index + 2); // fractal confirms right=2 bars later
    const tol = atrAt(availIdx) * tolAtr;
    if (Math.abs(highs[i].price - second.price) <= tol) {
      pools.push({
        side: "BSL", price: (highs[i].price + second.price) / 2,
        t: bars[availIdx].t, hits: 2, state: "untouched",
      });
      i++;
    }
  }
  const lows = sw.filter((s) => s.kind === "low").slice(-8);
  for (let i = 0; i + 1 < lows.length; i++) {
    const second = lows[i + 1];
    const availIdx = Math.min(bars.length - 1, second.index + 2);
    const tol = atrAt(availIdx) * tolAtr;
    if (Math.abs(lows[i].price - second.price) <= tol) {
      pools.push({
        side: "SSL", price: (lows[i].price + second.price) / 2,
        t: bars[availIdx].t, hits: 2, state: "untouched",
      });
      i++;
    }
  }
  // prior-day high/low — known only once the day closes (available next day)
  // v14: groupByDay cuts at SERVER-LOCAL midnight (= NY 17:00 for Exness,
  // whose clock follows US DST) — bars are true UTC now, so the day key is
  // (t + brokerOffsetSec)'s calendar day. The old cut at UTC midnight put
  // the boundary 2–3h into the NY session (wrong PDH/PDL lines).
  const dayBars = groupByDay(bars, brokerOffsetSec);
  if (dayBars.length >= 2) {
    const prev = dayBars[dayBars.length - 2];
    const nextDay = dayBars[dayBars.length - 1];
    pools.push({ side: "BSL", price: prev.hi, t: nextDay.t, hits: 1, state: "untouched" });
    pools.push({ side: "SSL", price: prev.lo, t: nextDay.t, hits: 1, state: "untouched" });
  }

  // timeline: walk the real bars forward from availability
  for (const p of pools) {
    let start = bars.findIndex((b) => b.t >= p.t);
    if (start < 0) continue;
    for (let i = start; i < bars.length; i++) {
      const b = bars[i];
      if (p.side === "BSL") {
        if (b.c > p.price) { p.runT = b.t; break; }
        if (b.h > p.price && b.c < p.price && p.sweptT == null) p.sweptT = b.t;
      } else {
        if (b.c < p.price) { p.runT = b.t; break; }
        if (b.l < p.price && b.c > p.price && p.sweptT == null) p.sweptT = b.t;
      }
    }
    p.state = p.runT != null ? "run" : p.sweptT != null ? "swept" : "untouched";
  }

  const rank = (p: LiquidityPool) => (p.state === "untouched" ? 0 : 1) * 1e9 + p.t;
  const bsl = pools.filter((p) => p.side === "BSL").sort((x, y) => rank(x) - rank(y)).slice(0, maxPerSide);
  const ssl = pools.filter((p) => p.side === "SSL").sort((x, y) => rank(x) - rank(y)).slice(0, maxPerSide);
  return [...bsl, ...ssl];
}

// (v12.1: the old lastAtr() full-series helper is gone — equal-high pools
// now use the ATR as of their own confirmation bar, see atrAt above.)

function groupByDay(bars: Candle[], brokerOffsetSec = 0): { t: number; hi: number; lo: number }[] {
  const map = new Map<string, { t: number; hi: number; lo: number }>();
  for (const b of bars) {
    // v14: server-local calendar day (forex day) — NOT the UTC calendar day
    const d = new Date((b.t + brokerOffsetSec) * 1000).toISOString().slice(0, 10);
    const cur = map.get(d);
    if (!cur) map.set(d, { t: b.t, hi: b.h, lo: b.l });
    else {
      cur.hi = Math.max(cur.hi, b.h);
      cur.lo = Math.min(cur.lo, b.l);
    }
  }
  return [...map.values()];
}

// ───────────────────────── supply / demand ─────────────────────────

/** Base candle whose NEXT candle body ≥ 1.5 ATR with opposite close → zone = base wick range. */
export function detectSupplyDemand(bars: Candle[]): Zone[] {
  const a = atr(bars);
  const out: Zone[] = [];
  for (let k = 0; k + 1 < bars.length; k++) {
    const atrK = a[k];
    if (atrK == null) continue;
    const body1 = Math.abs(bars[k + 1].c - bars[k + 1].o);
    if (body1 < 1.5 * atrK) continue;
    const baseDown = bars[k].c <= bars[k].o;
    const nextUp = bars[k + 1].c > bars[k + 1].o;
    if (baseDown && nextUp) {
      out.push({ side: "demand", lo: bars[k].l, hi: bars[k].h, t: bars[k].t });
    } else if (!baseDown && !nextUp) {
      out.push({ side: "supply", lo: bars[k].l, hi: bars[k].h, t: bars[k].t });
    }
  }
  // timeline per zone: mitigation (first overlap) + broken (first close beyond
  // the far edge). NOT dropped here — consumers filter as-of their own bar so
  // the walk-forward backtest sees the same universe the live engine saw.
  for (const z of out) {
    const startIdx = bars.findIndex((b) => b.t === z.t);
    if (startIdx < 0) continue;
    for (let i = startIdx + 1; i < bars.length; i++) {
      const b = bars[i];
      if (z.mitT == null && b.l <= z.hi && b.h >= z.lo) z.mitT = b.t;
      if (z.side === "demand" && b.c < z.lo) { z.brokenT = b.t; break; }
      if (z.side === "supply" && b.c > z.hi) { z.brokenT = b.t; break; }
    }
  }
  return out;
}

// ───────────────────────── premium / discount + OTE ─────────────────────────

export interface PremiumDiscount {
  hi: number;
  lo: number;
  eq: number;
  state: "premium" | "discount" | "balanced";
  legDir: "up" | "down";
  ote: [number, number];
  price: number;
}

export function premiumDiscount(bars: Candle[], lookback = 60, price: number): PremiumDiscount {
  const win = bars.slice(-lookback);
  // v16.8 (user audit): the dealing range is the LAST MAJOR LEG (5/5
  // swings) — ICT premium/discount + OTE are LEG measurements. The old
  // 60-bar window extremes put the OTE pocket in the wrong half whenever
  // two different legs shared the window (fib anchored on a range, not a leg).
  const sw = swings(bars, 5, 5);
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  for (const s of sw) {
    if (s.kind === "high") lastHigh = s;
    else lastLow = s;
  }
  let hi: number;
  let lo: number;
  let legDir: "up" | "down";
  if (lastHigh && lastLow && lastHigh.index !== lastLow.index) {
    hi = lastHigh.price;
    lo = lastLow.price;
    legDir = lastHigh.index > lastLow.index ? "up" : "down";
  } else {
    // no confirmed major swings in the window — honest fallback to extremes
    hi = Math.max(...win.map((b) => b.h));
    lo = Math.min(...win.map((b) => b.l));
    const hiIdx = win.findIndex((b) => b.h === hi);
    const loIdx = win.findIndex((b) => b.l === lo);
    legDir = hiIdx > loIdx ? "up" : "down";
  }
  const eq = (hi + lo) / 2;
  const legH = Math.max(hi - lo, 1e-9);
  const band = 0.05 * legH;
  const state = price > eq + band ? "premium" : price < eq - band ? "discount" : "balanced";
  // v16.8 OTE of the CURRENT leg — retracement into the tradeable side:
  //   up leg  → pullback 61.8–78.6% DOWN from the high = the discount longs
  //   down leg → pullback 61.8–78.6% UP from the low = the premium shorts
  // (the old formula measured the window range and mirrored the zone).
  const ote: [number, number] = legDir === "up"
    ? [hi - 0.786 * legH, hi - 0.618 * legH]
    : [lo + 0.618 * legH, lo + 0.786 * legH];
  return { hi, lo, eq, state, legDir, ote, price };
}
