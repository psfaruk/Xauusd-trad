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

export function detectStructure(bars: Candle[], left = 2, right = 2, maxEvents = 6): StructureRead {
  const sw = swings(bars, left, right);
  // label swings HH/LH/HL/LL vs previous same-kind
  const labels: StructureRead["labels"] = [];
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  for (const s of sw) {
    if (s.kind === "high") {
      if (lastHigh) {
        labels.push({
          index: s.index, t: s.t, price: s.price,
          tag: s.price > lastHigh.price ? "HH" : "LH",
          side: "high",
        });
      }
      lastHigh = s;
    } else {
      if (lastLow) {
        labels.push({
          index: s.index, t: s.t, price: s.price,
          tag: s.price > lastLow.price ? "HL" : "LL",
          side: "low",
        });
      }
      lastLow = s;
    }
  }
  // trend = vote of latest labels
  const recent = labels.slice(-4);
  const bull = recent.filter((l) => l.tag === "HH" || l.tag === "HL").length;
  const bear = recent.filter((l) => l.tag === "LH" || l.tag === "LL").length;
  const trend = bull > bear ? "bullish" : bear > bull ? "bearish" : "neutral";

  // events: walk bars; a close beyond the last swing high/low is a break
  const events: StructureEvent[] = [];
  let pendHigh: Swing | null = null;
  let pendLow: Swing | null = null;
  let swIdx = 0;
  let prevDir: "up" | "down" | null = null;
  for (let i = 0; i < bars.length; i++) {
    while (swIdx < sw.length && sw[swIdx].index + right <= i) {
      const s = sw[swIdx];
      if (s.kind === "high") pendHigh = s;
      else pendLow = s;
      swIdx++;
    }
    const b = bars[i];
    if (pendHigh && b.c > pendHigh.price) {
      const dir: "up" | "down" = "up";
      events.push({
        t: b.t, price: pendHigh.price, dir, index: i, fromT: pendHigh.t,
        label: prevDir === dir ? "BOS" : prevDir === null ? "BOS" : "CHoCH",
      });
      prevDir = dir;
      pendHigh = null;
    } else if (pendLow && b.c < pendLow.price) {
      const dir: "up" | "down" = "down";
      events.push({
        t: b.t, price: pendLow.price, dir, index: i, fromT: pendLow.t,
        label: prevDir === dir ? "BOS" : prevDir === null ? "BOS" : "CHoCH",
      });
      prevDir = dir;
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

/** Bullish OB: last down-close candle before an impulse (body ≥ impulse_atr × ATR) up-close. */
export function detectOrderBlocks(bars: Candle[], impulseAtr = 1.2): Zone[] {
  const a = atr(bars);
  const out: Zone[] = [];
  for (let k = 0; k + 1 < bars.length; k++) {
    const atrK = a[k];
    if (atrK == null) continue;
    const body1 = Math.abs(bars[k + 1].c - bars[k + 1].o);
    if (body1 < impulseAtr * atrK) continue;
    const downK = bars[k].c < bars[k].o;
    const upNext = bars[k + 1].c > bars[k + 1].o;
    if (downK && upNext) {
      out.push({ side: "ob_bull", lo: Math.min(bars[k].o, bars[k].c), hi: Math.max(bars[k].o, bars[k].c), t: bars[k].t });
    } else if (!downK && !upNext) {
      out.push({ side: "ob_bear", lo: Math.min(bars[k].o, bars[k].c), hi: Math.max(bars[k].o, bars[k].c), t: bars[k].t });
    }
  }
  // mitigation: first later bar overlapping the zone
  for (const z of out) {
    for (let i = bars.findIndex((b) => b.t === z.t) + 1; i < bars.length; i++) {
      if (bars[i].l <= z.hi && bars[i].h >= z.lo) { z.mitT = bars[i].t; break; }
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
          fillPct = Math.min(1, (hi - bars[i].l) / Math.max(1e-9, gap));
          if (fillPct >= 0.5) break;
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
          fillPct = Math.min(1, (bars[i].h - lo) / Math.max(1e-9, gap));
          if (fillPct >= 0.5) break;
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
 */
export function detectLiquidity(bars: Candle[], tolAtr = 0.15, maxPerSide = 3): LiquidityPool[] {
  const a = lastAtr(bars);
  const sw = swings(bars, 2, 2);
  const pools: LiquidityPool[] = [];
  const tol = a * tolAtr;

  // equal highs → BSL above; available once the 2nd equal high confirms
  const highs = sw.filter((s) => s.kind === "high").slice(-8);
  for (let i = 0; i + 1 < highs.length; i++) {
    if (Math.abs(highs[i].price - highs[i + 1].price) <= tol) {
      const second = highs[i + 1];
      const availIdx = Math.min(bars.length - 1, second.index + 2); // fractal confirms right=2 bars later
      pools.push({
        side: "BSL", price: (highs[i].price + second.price) / 2,
        t: bars[availIdx].t, hits: 2, state: "untouched",
      });
      i++;
    }
  }
  const lows = sw.filter((s) => s.kind === "low").slice(-8);
  for (let i = 0; i + 1 < lows.length; i++) {
    if (Math.abs(lows[i].price - lows[i + 1].price) <= tol) {
      const second = lows[i + 1];
      const availIdx = Math.min(bars.length - 1, second.index + 2);
      pools.push({
        side: "SSL", price: (lows[i].price + second.price) / 2,
        t: bars[availIdx].t, hits: 2, state: "untouched",
      });
      i++;
    }
  }
  // prior-day high/low — known only once the day closes (available next day)
  const dayBars = groupByDay(bars);
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

function lastAtr(bars: Candle[]): number {
  const a = atr(bars);
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
  return 1;
}

function groupByDay(bars: Candle[]): { t: number; hi: number; lo: number }[] {
  const map = new Map<string, { t: number; hi: number; lo: number }>();
  for (const b of bars) {
    const d = new Date(b.t * 1000).toISOString().slice(0, 10);
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
  const hi = Math.max(...win.map((b) => b.h));
  const lo = Math.min(...win.map((b) => b.l));
  const eq = (hi + lo) / 2;
  const range = hi - lo;
  const band = 0.05 * range;
  const state = price > eq + band ? "premium" : price < eq - band ? "discount" : "balanced";
  // leg direction: which extreme is more recent
  const hiIdx = win.findIndex((b) => b.h === hi);
  const loIdx = win.findIndex((b) => b.l === lo);
  const legDir = hiIdx > loIdx ? "up" : "down";
  // OTE of the current leg
  const ote: [number, number] = legDir === "up"
    ? [hi - 0.62 * range, hi - 0.79 * range]
    : [lo + 0.62 * range, lo + 0.79 * range];
  return { hi, lo, eq, state, legDir, ote, price };
}
