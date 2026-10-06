/**
 * candlesticks.ts — v19.0: the complete candlestick-pattern STRATEGY engine.
 *
 * User spec: "কোনো টাইম ফ্রেমে কোনো ক্যান্ডেল, মার্কেটের কোনো পজিশনে হলে
 * এটার লজিক কি? মার্কেট আপ যাবে নাকি ডাউন?" — for ANY timeframe, ANY candle
 * count, ANY market position the engine must answer: what the shape means,
 * WHY (the logic), and which way price should go — then prove it on history.
 *
 * Architecture (three layers, all lookahead-free):
 *
 *   1. ANATOMY  — every bar measured once in ATR units: body, wicks, close
 *      position, marubozu/doji flags. Shape is meaningless without scale,
 *      so every threshold in the catalog is ATR-relative.
 *
 *   2. CONTEXT  — where in the MARKET the shape sits, as-of the pattern bar
 *      (a swing only exists once its 3 right-neighbors confirmed; a level
 *      only exists once its origin swing printed; RSI/EMA/volZ read the
 *      value AT the bar, never after):
 *        · trendInto  — the 8-bar approach leg direction (net move + EMA21
 *          slope agreement) — a hammer after a DROP is not a hammer after a RISE
 *        · atLevel    — proximity (≤0.35 ATR) to a LIVE swing S/R level
 *        · structure  — the HH/HL vs LH/LL vote as-of the bar
 *        · rsi / volZ / overextension — the classic confirmations
 *
 *   3. CATALOG  — 29 textbook patterns by candle count (the user asked for
 *      1 / 2 / 3 / 4 / 5 and more — the framework is N-generic):
 *        N=1  hammer · hanging man · inverted hammer · shooting star ·
 *              dragonfly · gravestone · marubozu (trend-aware) · belt hold
 *        N=2  engulfing · piercing · dark cloud · harami · harami cross ·
 *              tweezer top/bottom
 *        N=3  morning/evening star · three soldiers/crows · three inside
 *              up/down · three outside up/down
 *        N=4  three-bar pullback resume (the practical 1-2-3 continuation)
 *        N=5  rising/falling three methods
 *
 * Every detection is priced into a trade plan (entry at trigger close, SL
 * beyond the pattern extreme, TP at 1.8R capped by the nearest opposing
 * level) and resolved against the bars that FOLLOW: fresh → confirmed
 * (a close beyond the pattern extreme in the predicted direction) /
 * failed (a close beyond the stop) / expired — so the chart never shows a
 * pattern that history already disproved as if it were live.
 *
 * `backtestCandles()` then replays the exact same detector walk-forward
 * over the full history: fill at trigger close, stop/target resolution,
 * per-pattern-code and per-candle-count W/L + R stats — the numbers the
 * pattern panel's win-rate badges carry (nothing is claimed that the
 * symbol's own tape didn't produce).
 */

import type { Candle, CandleBacktest, CandlePattern, CandlePatternStat, CandleStatus } from "./types";
import { atr, ema, rsi, swings, type Swing } from "./indicators";

// the shared strategy types live in types.ts (single source of truth for
// engine + API + UI) — re-exported here for existing import sites
export type { CandlePattern, CandlePatternStat, CandleBacktest, CandleStatus };

// ─────────────────────────── anatomy ───────────────────────────

interface Anatomy {
  i: number;
  b: Candle;
  body: number;      // |c−o|
  range: number;     // h−l (≥ 1e-9)
  upWick: number;    // h − max(o,c)
  loWick: number;    // min(o,c) − l
  bull: boolean;     // c > o
  bear: boolean;     // c < o
  closePos: number;  // 0 = closed at low, 1 = closed at high
  /** body/range — 1 = marubozu, 0 = doji */
  bodyRatio: number;
}

function anatomyOf(i: number, b: Candle): Anatomy {
  const body = Math.abs(b.c - b.o);
  const range = Math.max(1e-9, b.h - b.l);
  return {
    i, b, body, range,
    upWick: b.h - Math.max(b.o, b.c),
    loWick: Math.min(b.o, b.c) - b.l,
    bull: b.c > b.o,
    bear: b.c < b.o,
    closePos: (b.c - b.l) / range,
    bodyRatio: body / range,
  };
}

// ─────────────────────────── context ───────────────────────────

interface BarContext {
  /** the 8-bar leg INTO the pattern (ends the bar before it starts) */
  trendInto: "up" | "down" | "flat";
  /** net move of the approach leg, in ATR */
  legAtr: number;
  /** live S/R level the pattern sits at (≤0.35 ATR), as-of the pattern bar */
  atLevel: { side: "support" | "resistance"; price: number; hits: number } | null;
  /** structure vote as-of the pattern bar */
  structure: "HH/HL" | "LH/LL" | "range";
  rsi: number | null;
  /** trigger-bar tick-volume z-score vs its prior 60 bars */
  volZ: number;
  /** close distance from EMA21, in ATR (positive = above) */
  emaDist: number;
  atr: number;
}

// ─────────────────────────── result types ───────────────────────────

// (shared result types CandlePattern / CandlePatternStat / CandleBacktest / CandleStatus live in types.ts)

/** the chart drawing (a lean subset — the panel carries the full read) */
export interface CandleDrawing {
  kind: "candle";
  code: string;
  name: string;
  side: "bull" | "bear";
  n: number;
  direction: "up" | "down";
  status: CandleStatus;
  outcome?: "won" | "lost" | "open";
  confidence: number;
  t0: number; t1: number;
  lo: number; hi: number;
  source_tf?: string;
}

// ─────────────────────────── precomputed series ───────────────────────────

interface Series {
  bars: Candle[];               // CLOSED bars only
  a: Anatomy[];                 // aligned with bars
  atr: (number | null)[];       // Wilder 14
  ema21: (number | null)[];
  rsi: (number | null)[];
  volZ: number[];               // per-bar z vs prior 60
  sw: Swing[];                  // 3/3 fractal swings over the whole window
  labels: { index: number; t: number; price: number; tag: "HH" | "HL" | "LH" | "LL"; side: "high" | "low" }[];
}

function buildSeries(closed: Candle[]): Series {
  const atrArr = atr(closed, 14);
  const emaArr = ema(closed.map((b) => b.c), 21);
  const rsiArr = rsi(closed, 14);
  // rolling volume z-score — mean/sd of the PRIOR 60 bars only (no lookahead)
  const volZ: number[] = closed.map((b, i) => {
    if (i < 60) return 0;
    let mean = 0;
    for (let j = i - 60; j < i; j++) mean += closed[j].v;
    mean /= 60;
    let sq = 0;
    for (let j = i - 60; j < i; j++) sq += (closed[j].v - mean) ** 2;
    const sd = Math.sqrt(sq / 60);
    return sd > 0 ? (b.v - mean) / sd : 0;
  });
  // 3/3 swings + HH/HL/LH/LL labels (same grammar as smc.ts — one structure
  // story on the chart; a label is USABLE at bar k only from swing.index+3)
  const sw = swings(closed, 3, 3);
  const labels: Series["labels"] = [];
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  for (const s of sw) {
    if (s.kind === "high") {
      if (lastHigh) {
        labels.push({ index: s.index, t: s.t, price: s.price, tag: s.price > lastHigh.price ? "HH" : "LH", side: "high" });
      }
      lastHigh = s;
    } else {
      if (lastLow) {
        labels.push({ index: s.index, t: s.t, price: s.price, tag: s.price > lastLow.price ? "HL" : "LL", side: "low" });
      }
      lastLow = s;
    }
  }
  return {
    bars: closed,
    a: closed.map((b, i) => anatomyOf(i, b)),
    atr: atrArr, ema21: emaArr, rsi: rsiArr, volZ,
    sw, labels,
  };
}

/** context as-of pattern span [i0..i1] — everything reads data BEFORE i0 */
function contextAt(s: Series, i0: number, i1: number): BarContext {
  const atrV = (s.atr[i0] ?? s.atr[Math.max(0, i0 - 1)] ?? 1) || 1;
  // approach leg: 8 bars ending the bar BEFORE the pattern starts
  const legFrom = Math.max(0, i0 - 9);
  const legTo = Math.max(0, i0 - 1);
  const net = s.bars[legTo].c - s.bars[legFrom].c;
  const ema0 = s.ema21[legFrom];
  const ema1 = s.ema21[legTo];
  const slope = ema0 != null && ema1 != null ? ema1 - ema0 : 0;
  const legAtr = net / atrV;
  let trendInto: "up" | "down" | "flat" = "flat";
  if (net <= -0.5 * atrV && slope <= 0) trendInto = "down";
  else if (net >= 0.5 * atrV && slope >= 0) trendInto = "up";

  // ── live S/R as-of the pattern bar ──
  // candidate levels = swings confirmed BEFORE the pattern (index ≤ i0 − 3),
  // still unbroken (no CLOSE beyond ±0.15 ATR between swing and pattern)
  let atLevel: BarContext["atLevel"] = null;
  {
    const highs = s.sw.filter((w) => w.kind === "high" && w.index <= i0 - 3).slice(-6);
    const lows = s.sw.filter((w) => w.kind === "low" && w.index <= i0 - 3).slice(-6);
    const check = (kind: "high" | "low", price: number, from: number): { side: "support" | "resistance"; hits: number } | null => {
      let hits = 1;
      for (let j = from + 1; j <= i0; j++) {
        const b = s.bars[j];
        const tol = 0.35 * atrV;
        const touched = kind === "high" ? b.h >= price - tol : b.l <= price + tol;
        if (touched) hits++;
        if (kind === "high" ? b.c > price + 0.15 * atrV : b.c < price - 0.15 * atrV) return null; // broken
      }
      return { side: kind === "high" ? "resistance" : "support", hits };
    };
    const cand: { side: "support" | "resistance"; price: number; hits: number; dist: number }[] = [];
    for (const w of highs) {
      const r = check("high", w.price, w.index);
      if (r) cand.push({ ...r, price: w.price, dist: Math.abs(s.bars[i1].h - w.price) });
    }
    for (const w of lows) {
      const r = check("low", w.price, w.index);
      if (r) cand.push({ ...r, price: w.price, dist: Math.abs(s.bars[i1].l - w.price) });
    }
    cand.sort((x, y) => x.dist - y.dist);
    const best = cand[0];
    if (best && best.dist <= 0.35 * atrV) atLevel = { side: best.side, price: best.price, hits: best.hits };
  }

  // structure vote as-of the pattern bar (labels usable from swing.index+3)
  const usable = s.labels.filter((l) => l.index + 3 <= i0).slice(-6);
  let bull = 0, bear = 0;
  for (let i = 0; i < usable.length; i++) {
    const w = usable.length - i;
    if (usable[i].tag === "HH" || usable[i].tag === "HL") bull += w;
    else bear += w;
  }
  const structure: BarContext["structure"] = bull > bear * 1.3 ? "HH/HL" : bear > bull * 1.3 ? "LH/LL" : "range";

  const emaHere = s.ema21[i1];
  return {
    trendInto, legAtr, atLevel, structure,
    rsi: s.rsi[i1] ?? null,
    volZ: s.volZ[i1] ?? 0,
    emaDist: emaHere != null ? (s.bars[i1].c - emaHere) / atrV : 0,
    atr: atrV,
  };
}

// ─────────────────────────── the catalog (match layer) ───────────────────────────
//
// Each match returns a RAW hit; scoring/plan/logic/status are shared passes.
// Priority at one bar: higher N first (more specific shape).

interface RawHit {
  code: string; nameEn: string; nameBn: string;
  n: number;
  side: "bull" | "bear";
  bias: "reversal" | "continuation" | "indecision";
  i0: number; i1: number;
  base: number;           // textbook reliability 0..100
  /** context GATE — pattern only fires in the right market position */
  gate: (ctx: BarContext) => boolean;
}

/** try all patterns ENDING at bar k, highest-N first */
function matchAt(s: Series, k: number): RawHit | null {
  const A = s.a;
  const b = A[k], p1 = A[k - 1], p2 = A[k - 2], p3 = A[k - 3], p4 = A[k - 4];
  const aV = (s.atr[k] ?? s.atr[k - 1] ?? 0) || 0;
  if (!b || !p1 || !p2 || !aV) return null;
  const ctx = contextAt(s, k, k); // 1-bar patterns: span is just [k,k]
  const ctx2 = contextAt(s, k - 1, k);
  const ctx3 = contextAt(s, k - 2, k);
  const ctx5 = contextAt(s, k - 4, k);

  // ─────────── N=5: RISING / FALLING THREE METHODS (continuation) ───────────
  if (p4 && p3 && p2) {
    // bar0 = A[k-4] (the big bar), bars 1..3 small counter bars, bar 4 resumes
    const big = A[k - 4];
    if (big.body >= 0.8 * aV) {
      const smalls = [A[k - 3], A[k - 2], A[k - 1]];
      const heldInside = smalls.every((x) => x.b.c >= big.b.l && x.b.c <= big.b.h && x.body <= 0.4 * aV);
      const smallsCounter = smalls.every((x) => big.bull ? x.bear : x.bull);
      if (heldInside && smallsCounter && big.bull && b.bull && b.b.c > big.b.c && ctx5.trendInto === "up") {
        return { code: "RISING3", nameEn: "Rising Three Methods", nameBn: "রাইজিং থ্রি মেথডস", n: 5, side: "bull", bias: "continuation", i0: k - 4, i1: k, base: 68, gate: (c) => c.trendInto === "up" };
      }
      if (heldInside && smallsCounter && big.bear && b.bear && b.b.c < big.b.c && ctx5.trendInto === "down") {
        return { code: "FALLING3", nameEn: "Falling Three Methods", nameBn: "ফলিং থ্রি মেথডস", n: 5, side: "bear", bias: "continuation", i0: k - 4, i1: k, base: 68, gate: (c) => c.trendInto === "down" };
      }
    }
  }

  // ─────────── N=4: THREE-BAR PULLBACK RESUME (1-2-3 continuation) ───────────
  if (p3 && p2) {
    const t = A[k - 4]; // the impulse bar that started the pattern
    if (t) {
      const tCtx = contextAt(s, k - 4, k);
      if (tCtx.trendInto === "up" && t.bull && t.body >= 0.8 * aV) {
        const pull = [A[k - 3], A[k - 2], A[k - 1]];
        const orderly = pull.every((x) => x.body <= 0.65 * aV) &&
          pull[0].b.c < pull[0].b.o && pull[1].b.c < pull[1].b.o && pull[2].b.c < pull[2].b.o &&
          pull[2].b.l >= t.b.l - 0.25 * aV; // pullback holds above the impulse low
        if (orderly && b.bull && b.b.c > pull[0].b.h) {
          return { code: "PULLBACK3", nameEn: "Three-Bar Pullback Resume", nameBn: "থ্রি-বার পুলব্যাক রিজিউম", n: 4, side: "bull", bias: "continuation", i0: k - 4, i1: k, base: 62, gate: (c) => c.trendInto === "up" };
        }
      }
      if (tCtx.trendInto === "down" && t.bear && t.body >= 0.8 * aV) {
        const pull = [A[k - 3], A[k - 2], A[k - 1]];
        const orderly = pull.every((x) => x.body <= 0.65 * aV) &&
          pull[0].b.c > pull[0].b.o && pull[1].b.c > pull[1].b.o && pull[2].b.c > pull[2].b.o &&
          pull[2].b.h <= t.b.h + 0.25 * aV;
        if (orderly && b.bear && b.b.c < pull[0].b.l) {
          return { code: "PULLBACK3-", nameEn: "Three-Bar Pullback Resume", nameBn: "থ্রি-বার পুলব্যাক রিজিউম", n: 4, side: "bear", bias: "continuation", i0: k - 4, i1: k, base: 62, gate: (c) => c.trendInto === "down" };
        }
      }
    }
  }

  // ─────────── N=3 ───────────
  {
    // MORNING / EVENING STAR: exhaustion → stall → reversal close
    if (p2.body >= 0.7 * aV && p1.body <= 0.35 * aV) {
      const intoP2 = (p2.b.c - p2.b.o) / aV;
      const mid2 = (p2.b.o + p2.b.c) / 2;
      if (p2.bear && intoP2 <= -0.6 && b.bull && b.b.c >= mid2 && ctx3.trendInto === "down") {
        return { code: "MORNING*", nameEn: "Morning Star", nameBn: "মর্নিং স্টার", n: 3, side: "bull", bias: "reversal", i0: k - 2, i1: k, base: 74, gate: (c) => c.trendInto === "down" };
      }
      if (p2.bull && intoP2 >= 0.6 && b.bear && b.b.c <= mid2 && ctx3.trendInto === "up") {
        return { code: "EVENING*", nameEn: "Evening Star", nameBn: "ইভনিং স্টার", n: 3, side: "bear", bias: "reversal", i0: k - 2, i1: k, base: 74, gate: (c) => c.trendInto === "up" };
      }
    }
    // THREE WHITE SOLDIERS / THREE BLACK CROWS
    if (p2.bull && p1.bull && b.bull &&
        p2.body >= 0.55 * aV && p1.body >= 0.55 * aV && b.body >= 0.55 * aV &&
        b.b.c > p1.b.c && p1.b.c > p2.b.c &&
        p1.b.o >= Math.min(p2.b.o, p2.b.c) && b.b.o >= Math.min(p1.b.o, p1.b.c) &&
        b.upWick <= 0.5 * b.body && p1.upWick <= 0.5 * p1.body) {
      return { code: "SOLDIERS", nameEn: "Three White Soldiers", nameBn: "থ্রি হোয়াইট সোলজার্স", n: 3, side: "bull", bias: "reversal", i0: k - 2, i1: k, base: 70, gate: () => true };
    }
    if (p2.bear && p1.bear && b.bear &&
        p2.body >= 0.55 * aV && p1.body >= 0.55 * aV && b.body >= 0.55 * aV &&
        b.b.c < p1.b.c && p1.b.c < p2.b.c &&
        p1.b.o <= Math.max(p2.b.o, p2.b.c) && b.b.o <= Math.max(p1.b.o, p1.b.c) &&
        b.loWick <= 0.5 * b.body && p1.loWick <= 0.5 * p1.body) {
      return { code: "CROWS", nameEn: "Three Black Crows", nameBn: "থ্রি ব্ল্যাক ক্রোজ", n: 3, side: "bear", bias: "reversal", i0: k - 2, i1: k, base: 70, gate: () => true };
    }
    // THREE INSIDE UP/DOWN: harami + confirming close beyond the big bar
    if (p2.body >= 0.8 * aV) {
      const haramiBull = p2.bear && p1.bull && p1.b.o >= Math.min(p2.b.o, p2.b.c) && p1.b.c <= Math.max(p2.b.o, p2.b.c) && p1.body <= 0.55 * p2.body;
      const haramiBear = p2.bull && p1.bear && p1.b.o <= Math.max(p2.b.o, p2.b.c) && p1.b.c >= Math.min(p2.b.o, p2.b.c) && p1.body <= 0.55 * p2.body;
      if (haramiBull && b.bull && b.b.c > p2.b.h && ctx3.trendInto === "down") {
        return { code: "INSIDE-UP", nameEn: "Three Inside Up", nameBn: "থ্রি ইনসাইড আপ", n: 3, side: "bull", bias: "reversal", i0: k - 2, i1: k, base: 68, gate: (c) => c.trendInto === "down" };
      }
      if (haramiBear && b.bear && b.b.c < p2.b.l && ctx3.trendInto === "up") {
        return { code: "INSIDE-DN", nameEn: "Three Inside Down", nameBn: "থ্রি ইনসাইড ডাউন", n: 3, side: "bear", bias: "reversal", i0: k - 2, i1: k, base: 68, gate: (c) => c.trendInto === "up" };
      }
      // THREE OUTSIDE UP/DOWN: engulfing + confirming close
      const engBull = p2.bear && p1.bull && p1.b.c >= Math.max(p2.b.o, p2.b.c) && p1.b.o <= Math.min(p2.b.o, p2.b.c) && p1.body >= 1.0 * p2.body;
      const engBear = p2.bull && p1.bear && p1.b.o >= Math.max(p2.b.o, p2.b.c) && p1.b.c <= Math.min(p2.b.o, p2.b.c) && p1.body >= 1.0 * p2.body;
      if (engBull && b.bull && b.b.c > p1.b.h && ctx3.trendInto === "down") {
        return { code: "OUTSIDE-UP", nameEn: "Three Outside Up", nameBn: "থ্রি আউটসাইড আপ", n: 3, side: "bull", bias: "reversal", i0: k - 2, i1: k, base: 72, gate: (c) => c.trendInto === "down" };
      }
      if (engBear && b.bear && b.b.c < p1.b.l && ctx3.trendInto === "up") {
        return { code: "OUTSIDE-DN", nameEn: "Three Outside Down", nameBn: "থ্রি আউটসাইড ডাউন", n: 3, side: "bear", bias: "reversal", i0: k - 2, i1: k, base: 72, gate: (c) => c.trendInto === "up" };
      }
    }
  }

  // ─────────── N=2 ───────────
  {
    // ENGULFING (body swallows the prior body, opposite colors, real size)
    if (b.body >= 0.6 * aV && p1.body >= 0.22 * aV) {
      const bullEng = p1.bear && b.bull &&
        b.b.c >= Math.max(p1.b.o, p1.b.c) && b.b.o <= Math.min(p1.b.o, p1.b.c) &&
        b.body >= 1.0 * p1.body;
      const bearEng = p1.bull && b.bear &&
        b.b.o >= Math.max(p1.b.o, p1.b.c) && b.b.c <= Math.min(p1.b.o, p1.b.c) &&
        b.body >= 1.0 * p1.body;
      if (bullEng && ctx2.trendInto === "down") {
        return { code: "ENGULF+", nameEn: "Bullish Engulfing", nameBn: "বুলিশ এনগালফিং", n: 2, side: "bull", bias: "reversal", i0: k - 1, i1: k, base: 72, gate: (c) => c.trendInto === "down" };
      }
      if (bearEng && ctx2.trendInto === "up") {
        return { code: "ENGULF-", nameEn: "Bearish Engulfing", nameBn: "বেয়ারিশ এনগালফিং", n: 2, side: "bear", bias: "reversal", i0: k - 1, i1: k, base: 72, gate: (c) => c.trendInto === "up" };
      }
    }
    // PIERCING LINE / DARK CLOUD COVER
    if (p1.body >= 0.6 * aV) {
      const p1Mid = (p1.b.o + p1.b.c) / 2;
      if (p1.bear && b.bull && b.b.o < p1.b.c && b.b.c > p1Mid && b.b.c < p1.b.o && ctx2.trendInto === "down") {
        return { code: "PIERCE", nameEn: "Piercing Line", nameBn: "পিয়ার্সিং লাইন", n: 2, side: "bull", bias: "reversal", i0: k - 1, i1: k, base: 65, gate: (c) => c.trendInto === "down" };
      }
      if (p1.bull && b.bear && b.b.o > p1.b.c && b.b.c < p1Mid && b.b.c > p1.b.o && ctx2.trendInto === "up") {
        return { code: "DARKCLOUD", nameEn: "Dark Cloud Cover", nameBn: "ডার্ক ক্লাউড কভার", n: 2, side: "bear", bias: "reversal", i0: k - 1, i1: k, base: 65, gate: (c) => c.trendInto === "up" };
      }
      // HARAMI / HARAMI CROSS (small body — or a doji — inside the big one)
      const insideBull = p1.bear && b.b.o >= Math.min(p1.b.o, p1.b.c) && b.b.c <= Math.max(p1.b.o, p1.b.c);
      const insideBear = p1.bull && b.b.o <= Math.max(p1.b.o, p1.b.c) && b.b.c >= Math.min(p1.b.o, p1.b.c);
      if (insideBull && b.body <= 0.5 * p1.body && ctx2.trendInto === "down") {
        if (b.bodyRatio <= 0.12 && b.range >= 0.6 * aV) {
          return { code: "HARAMI-X+", nameEn: "Bullish Harami Cross", nameBn: "বুলিশ হারামি ক্রস", n: 2, side: "bull", bias: "reversal", i0: k - 1, i1: k, base: 64, gate: (c) => c.trendInto === "down" };
        }
        return { code: "HARAMI+", nameEn: "Bullish Harami", nameBn: "বুলিশ হারামি", n: 2, side: "bull", bias: "reversal", i0: k - 1, i1: k, base: 58, gate: (c) => c.trendInto === "down" };
      }
      if (insideBear && b.body <= 0.5 * p1.body && ctx2.trendInto === "up") {
        if (b.bodyRatio <= 0.12 && b.range >= 0.6 * aV) {
          return { code: "HARAMI-X-", nameEn: "Bearish Harami Cross", nameBn: "বেয়ারিশ হারামি ক্রস", n: 2, side: "bear", bias: "reversal", i0: k - 1, i1: k, base: 64, gate: (c) => c.trendInto === "up" };
        }
        return { code: "HARAMI-", nameEn: "Bearish Harami", nameBn: "বেয়ারিশ হারামি", n: 2, side: "bear", bias: "reversal", i0: k - 1, i1: k, base: 58, gate: (c) => c.trendInto === "up" };
      }
    }
    // TWEEZER TOP/BOTTOM (matching extremes after a directional leg)
    if (Math.abs(b.b.l - p1.b.l) <= 0.12 * aV && p1.bear && b.bull && ctx2.trendInto === "down" && b.range >= 0.6 * aV) {
      return { code: "TWEEZER-B", nameEn: "Tweezer Bottom", nameBn: "টুইজার বটম", n: 2, side: "bull", bias: "reversal", i0: k - 1, i1: k, base: 60, gate: (c) => c.trendInto === "down" };
    }
    if (Math.abs(b.b.h - p1.b.h) <= 0.12 * aV && p1.bull && b.bear && ctx2.trendInto === "up" && b.range >= 0.6 * aV) {
      return { code: "TWEEZER-T", nameEn: "Tweezer Top", nameBn: "টুইজার টপ", n: 2, side: "bear", bias: "reversal", i0: k - 1, i1: k, base: 60, gate: (c) => c.trendInto === "up" };
    }
  }

  // ─────────── N=1 ───────────
  {
    const body = b.body, range = b.range;
    // HAMMER / HANGING MAN — the same shape; the APPROACH LEG decides the side
    if (range >= 0.7 * aV && body >= 0.1 * aV &&
        b.loWick >= 1.9 * body && b.loWick >= 0.5 * aV &&
        b.upWick <= 0.35 * range && b.closePos >= 0.6) {
      if (ctx.trendInto === "down") {
        return { code: "HAMMER", nameEn: "Hammer", nameBn: "হ্যামার", n: 1, side: "bull", bias: "reversal", i0: k, i1: k, base: 66, gate: (c) => c.trendInto === "down" };
      }
      if (ctx.trendInto === "up") {
        return { code: "HANGMAN", nameEn: "Hanging Man", nameBn: "হ্যাংগিং ম্যান", n: 1, side: "bear", bias: "reversal", i0: k, i1: k, base: 62, gate: (c) => c.trendInto === "up" };
      }
    }
    // INVERTED HAMMER / SHOOTING STAR
    if (range >= 0.7 * aV && body >= 0.1 * aV &&
        b.upWick >= 1.9 * body && b.upWick >= 0.5 * aV &&
        b.loWick <= 0.35 * range && b.closePos <= 0.4) {
      if (ctx.trendInto === "down") {
        return { code: "INVHAMMER", nameEn: "Inverted Hammer", nameBn: "ইনভার্টেড হ্যামার", n: 1, side: "bull", bias: "reversal", i0: k, i1: k, base: 50, gate: (c) => c.trendInto === "down" };
      }
      if (ctx.trendInto === "up") {
        return { code: "SHOOTSTAR", nameEn: "Shooting Star", nameBn: "শুটিং স্টার", n: 1, side: "bear", bias: "reversal", i0: k, i1: k, base: 66, gate: (c) => c.trendInto === "up" };
      }
    }
    // DRAGONFLY / GRAVESTONE DOJI
    if (range >= 0.8 * aV && body <= 0.12 * range) {
      if (b.loWick >= 0.62 * range && b.upWick <= 0.14 * range && ctx.trendInto === "down") {
        return { code: "DRAGONFLY", nameEn: "Dragonfly Doji", nameBn: "ড্রাগনফ্লাই দোজি", n: 1, side: "bull", bias: "reversal", i0: k, i1: k, base: 60, gate: (c) => c.trendInto === "down" };
      }
      if (b.upWick >= 0.62 * range && b.loWick <= 0.14 * range && ctx.trendInto === "up") {
        return { code: "GRAVESTONE", nameEn: "Gravestone Doji", nameBn: "গ্রেভস্টোন দোজি", n: 1, side: "bear", bias: "reversal", i0: k, i1: k, base: 60, gate: (c) => c.trendInto === "up" };
      }
    }
    // MARUBOZU — full-body conviction bar; the APPROACH LEG decides what it
    // means: with the leg = continuation, against the leg = a key-reversal
    // attempt (which then has to survive the counter-trend structure gate)
    if (range >= 0.85 * aV && b.bodyRatio >= 0.82) {
      if (b.bull && ctx.trendInto === "up") {
        return { code: "MARUBOZU+", nameEn: "Bullish Marubozu", nameBn: "বুলিশ মারুবোজু", n: 1, side: "bull", bias: "continuation", i0: k, i1: k, base: 60, gate: (c) => c.trendInto === "up" };
      }
      if (b.bull) {
        return { code: "MARUBOZU+", nameEn: "Bullish Marubozu", nameBn: "বুলিশ মারুবোজু", n: 1, side: "bull", bias: "reversal", i0: k, i1: k, base: 52, gate: (c) => c.trendInto === "down" };
      }
      if (ctx.trendInto === "down") {
        return { code: "MARUBOZU-", nameEn: "Bearish Marubozu", nameBn: "বেয়ারিশ মারুবোজু", n: 1, side: "bear", bias: "continuation", i0: k, i1: k, base: 60, gate: (c) => c.trendInto === "down" };
      }
      return { code: "MARUBOZU-", nameEn: "Bearish Marubozu", nameBn: "বেয়ারিশ মারুবোজু", n: 1, side: "bear", bias: "reversal", i0: k, i1: k, base: 52, gate: (c) => c.trendInto === "up" };
    }
    // BELT HOLD — opens at the extreme, runs one way
    if (body >= 0.6 * aV && b.closePos >= 0.75 && b.loWick <= 0.12 * range && b.bull && ctx.trendInto === "down") {
      return { code: "BELT+", nameEn: "Bullish Belt Hold", nameBn: "বুলিশ বেল্ট হোল্ড", n: 1, side: "bull", bias: "reversal", i0: k, i1: k, base: 56, gate: (c) => c.trendInto === "down" };
    }
    if (body >= 0.6 * aV && b.closePos <= 0.25 && b.upWick <= 0.12 * range && b.bear && ctx.trendInto === "up") {
      return { code: "BELT-", nameEn: "Bearish Belt Hold", nameBn: "বেয়ারিশ বেল্ট হোল্ড", n: 1, side: "bear", bias: "reversal", i0: k, i1: k, base: 56, gate: (c) => c.trendInto === "up" };
    }
    // NOTE v19.0 tuning: DOJI and SPINNING TOP are deliberately NOT in the
    // tradeable catalog. Both fired often in the walk-forward run on real
    // XAUUSD tape (20 + 28 fires on M5) and won 18–32% at a 1.8R target —
    // an indecision shape with a direction bolted on is noise, not a
    // setup. The engine keeps them out; “wait for confirmation” is the
    // roadmap/structure layer's job, not a candle box's.
  }
  return null;
}

// ─────────────────────────── acceptance (the strategy's quality gate) ───────────────────────────
//
// The SAME gate runs live and in the backtest — the win rates the panel
// quotes describe exactly what the chart would have boxed, not a raw shape
// census. Two rules on top of each pattern's own context gate:
//   1. CONFIDENCE FLOOR — a weak shape in the wrong place is not a setup.
//   2. COUNTER-TREND STRUCTURE GATE — a reversal AGAINST the prevailing
//      HH/HL ↔ LH/LL structure only plays when it has REAL confluence:
//      sitting on a live S/R level AND an RSI extreme or a volume spike.
//      (Data: on the v19.0 walk-forward, counter-trend reversals without
//      confluence won ~20% at 1.8R — the gate deletes that bucket.)

const CANDLE_CONF_FLOOR = 52;

function accepts(hit: RawHit, ctx: BarContext, conf: number): boolean {
  if (conf < CANDLE_CONF_FLOOR) return false;
  if (hit.bias === "reversal") {
    const against =
      (hit.side === "bull" && ctx.structure === "LH/LL") ||
      (hit.side === "bear" && ctx.structure === "HH/HL");
    if (against) {
      // the level must defend the pattern's OWN side — a bull reversal
      // sitting on RESISTANCE is supply overhead, not confluence
      const rightLevel =
        (hit.side === "bull" && ctx.atLevel?.side === "support") ||
        (hit.side === "bear" && ctx.atLevel?.side === "resistance");
      const rsiExtreme =
        (hit.side === "bull" && ctx.rsi != null && ctx.rsi <= 34) ||
        (hit.side === "bear" && ctx.rsi != null && ctx.rsi >= 66);
      if (!(rightLevel && (rsiExtreme || ctx.volZ >= 1.5))) return false;
    }
  }
  return true;
}

// ─────────────────────────── scoring / plan / logic ───────────────────────────

function scoreConfidence(hit: RawHit, ctx: BarContext, A: Anatomy[]): number {
  let c = hit.base;
  const aV = ctx.atr;
  // reversal shapes pay at S/R; continuation pays with the trend
  if (hit.bias === "reversal" && hit.side === "bull" && ctx.atLevel?.side === "support") c += 12;
  if (hit.bias === "reversal" && hit.side === "bear" && ctx.atLevel?.side === "resistance") c += 12;
  if (hit.bias === "continuation") {
    const withTrend = (hit.side === "bull" && ctx.trendInto === "up") || (hit.side === "bear" && ctx.trendInto === "down");
    if (withTrend) c += 10;
  }
  // reversal WITH the prevailing structure pays (a bear reversal in LH/LL
  // is the trend doing its work — the counter-trend case is gated above)
  if (hit.bias === "reversal") {
    if ((hit.side === "bull" && ctx.structure === "HH/HL") || (hit.side === "bear" && ctx.structure === "LH/LL")) c += 6;
  }
  // momentum extremes agree
  if (hit.side === "bull" && ctx.rsi != null && ctx.rsi <= 34) c += 8;
  if (hit.side === "bear" && ctx.rsi != null && ctx.rsi >= 66) c += 8;
  // overextension favors the reversal side
  if (hit.side === "bull" && ctx.emaDist <= -1.2) c += 5;
  if (hit.side === "bear" && ctx.emaDist >= 1.2) c += 5;
  // trigger-bar volume conviction
  if (ctx.volZ >= 1.5) c += 6;
  // strong trigger close
  const last = A[hit.i1];
  if (hit.side === "bull" && last.closePos >= 0.78) c += 4;
  if (hit.side === "bear" && last.closePos <= 0.22) c += 4;
  // pattern size (in ATR) — a real shape, not a doji-dust box
  const spanAtr = Math.max(...A.slice(hit.i0, hit.i1 + 1).map((x) => x.range)) / aV;
  if (spanAtr >= 1.2) c += 5;
  return Math.max(28, Math.min(96, Math.round(c)));
}

/**
 * Trade-plan geometry (v19.0, measured on the walk-forward grid):
 *   · SL     — 0.15 ATR beyond the pattern extreme
 *   · TP     — 1.5R (the exit grid: 1.5R beat 1.0/1.2R on three of four
 *     timeframes), capped by the nearest LIVE opposing level as-of the
 *     entry bar. If that cap leaves reward below 1.15R there is no room
 *     to run → the trade is DROPPED (returns null).
 *   · entry  — CONFIRMATION-FIRST (the big v19.0 finding): the engine
 *     does NOT pay the trigger close. A pattern becomes a trade only
 *     when a following bar CLOSES beyond the pattern extreme (within
 *     CONFIRM_WINDOW bars) — the textbook "wait for confirmation", which
 *     flipped every timeframe positive on the walk-forward run
 *     (M5 −19.8→−0.8R · M15 +1.7→+11.0R · H1 −17.2→+8.6R · H4 −13.6→+3.7R).
 *     Unconfirmed patterns stay on the chart as WATCH (pending) setups.
 */
const SL_BUFFER_ATR = 0.15;
const TP_R = 1.5;
const MIN_ROOM_R = 1.15;
/** bars a pattern has to confirm in (close beyond its extreme) */
const CONFIRM_WINDOW = 6;
/** the close must clear the extreme by this much (wick-only breaks don't count) */
const CONFIRM_EDGE_ATR = 0.05;

/** plan for a KNOWN entry (a confirmation close, or the pending level for
 *  fresh watch setups). Null = no room to run before opposing supply. */
function planFrom(
  s: Series, hit: RawHit, ctx: BarContext, entry: number,
): { entry: number; sl: number; tp: number; rr: number } | null {
  const aV = ctx.atr;
  const seg = s.a.slice(hit.i0, hit.i1 + 1);
  const lo = Math.min(...seg.map((x) => x.b.l));
  const hi = Math.max(...seg.map((x) => x.b.h));
  if (hit.side === "bull") {
    const sl = lo - SL_BUFFER_ATR * aV;
    const risk = Math.max(1e-9, entry - sl);
    let tp = entry + TP_R * risk;
    let rr = TP_R;
    const opp = nearestLevel(s, Math.max(hit.i1, 0), "resistance", aV);
    if (opp != null && opp > entry + MIN_ROOM_R * risk && opp < tp) {
      tp = opp - 0.1 * aV;
      rr = Math.round(((tp - entry) / risk) * 100) / 100;
    }
    if (rr < MIN_ROOM_R) return null;
    return { entry, sl, tp, rr };
  }
  const sl = hi + SL_BUFFER_ATR * aV;
  const risk = Math.max(1e-9, sl - entry);
  let tp = entry - TP_R * risk;
  let rr = TP_R;
  const opp = nearestLevel(s, Math.max(hit.i1, 0), "support", aV);
  if (opp != null && opp < entry - MIN_ROOM_R * risk && opp > tp) {
    tp = opp + 0.1 * aV;
    rr = Math.round(((entry - tp) / risk) * 100) / 100;
  }
  if (rr < MIN_ROOM_R) return null;
  return { entry, sl, tp, rr };
}

/** nearest LIVE level of `side` as-of bar i (for TP capping) */
function nearestLevel(s: Series, i: number, side: "support" | "resistance", aV: number): number | null {
  const kind = side === "resistance" ? "high" : "low";
  const cands = s.sw.filter((w) => w.kind === kind && w.index <= i - 3).slice(-6);
  let best: number | null = null;
  let bestDist = Infinity;
  for (const w of cands) {
    let broken = false;
    for (let j = w.index + 1; j <= i; j++) {
      const b = s.bars[j];
      if (kind === "high" ? b.c > w.price + 0.15 * aV : b.c < w.price - 0.15 * aV) { broken = true; break; }
    }
    if (broken) continue;
    const dist = kind === "high" ? w.price - s.bars[i].c : s.bars[i].c - w.price;
    if (dist > 0 && dist < bestDist) { bestDist = dist; best = w.price; }
  }
  return best;
}

/** the fully-resolved story of one candidate: did it confirm, where did it
 *  enter, and what happened after. Drives BOTH the live read and the
 *  backtest — one pipeline, one truth. */
interface ResolvedSetup {
  hit: RawHit;
  ctx: BarContext;
  conf: number;
  /** the PATTERN lifecycle (what the chart box shows) */
  status: CandleStatus;
  /** the TRADE outcome (only when status === "confirmed") — computed with
   *  the backtest's exact rule so the chart and the stats can never
   *  disagree: stop touched before target = lost, target touched first =
   *  won, neither within the horizon = open (mark-to-market) */
  outcome: "won" | "lost" | "open" | null;
  /** the trade's R multiple at resolution (won: +rr · lost: −1 · open: MTM) */
  outcomeR: number | null;
  /** the confirmation bar (when status came from a confirmation) */
  confirmBar: number;
  /** entry price: the confirmation close (confirmed) or the pending
   *  confirmation level (fresh/failed-before-confirm/expired) */
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  /** true while no confirmation close has printed yet (a WATCH setup) */
  pending: boolean;
  /** confirmed setups whose level-capped reward fell below the room
   *  floor — the pattern printed and confirmed, but the engine passed */
  noRoom: boolean;
}

function resolveSetup(s: Series, hit: RawHit, ctx: BarContext, conf: number): ResolvedSetup {
  const aV = ctx.atr;
  const seg = s.a.slice(hit.i0, hit.i1 + 1);
  const segHi = Math.max(...seg.map((x) => x.b.h));
  const segLo = Math.min(...seg.map((x) => x.b.l));
  const bull = hit.side === "bull";
  const confirmLvl = bull ? segHi + CONFIRM_EDGE_ATR * aV : segLo - CONFIRM_EDGE_ATR * aV;
  const slLvl = bull ? segLo - SL_BUFFER_ATR * aV : segHi + SL_BUFFER_ATR * aV;
  const base = { hit, ctx, conf, confirmBar: -1, sl: slLvl, pending: true, noRoom: false, outcome: null, outcomeR: null } as ResolvedSetup;

  const pendingPlan = planFrom(s, hit, ctx, confirmLvl);
  if (pendingPlan) Object.assign(base, { tp: pendingPlan.tp, rr: pendingPlan.rr, entry: confirmLvl });
  else Object.assign(base, { tp: bull ? confirmLvl + TP_R * (confirmLvl - slLvl) : confirmLvl - TP_R * (slLvl - confirmLvl), rr: TP_R, entry: confirmLvl });

  // walk the bars that follow the pattern
  const lastIdx = s.bars.length - 1;
  let confirmedAt = -1;
  for (let j = hit.i1 + 1; j <= Math.min(lastIdx, hit.i1 + CONFIRM_WINDOW); j++) {
    const b = s.bars[j];
    if (bull ? b.c > confirmLvl : b.c < confirmLvl) { confirmedAt = j; break; }
    if (bull ? b.c < slLvl : b.c > slLvl) return { ...base, status: "failed" }; // broke before confirming
  }
  if (confirmedAt < 0) {
    // never confirmed in the window — a watch setup that never triggered
    const barsSince = lastIdx - hit.i1;
    return { ...base, status: barsSince <= CONFIRM_WINDOW ? "fresh" : "expired" };
  }
  // CONFIRMED — the entry is this bar's close; re-price the plan from here
  const entry = s.bars[confirmedAt].c;
  const plan = planFrom(s, hit, ctx, entry);
  const confirmed: ResolvedSetup = {
    ...base, status: "confirmed", confirmBar: confirmedAt, entry, pending: false, outcome: null, outcomeR: null,
    ...(plan ? { sl: plan.sl, tp: plan.tp, rr: plan.rr } : {}),
    noRoom: plan == null,
  };
  if (plan == null) return confirmed; // no room — the engine passed on the trade
  // and the trade itself, with the backtest's exact resolution rule
  const lastTrade = Math.min(lastIdx, confirmedAt + BACKTEST_HORIZON);
  const risk = Math.abs(entry - plan.sl) || 1e-9;
  for (let j = confirmedAt + 1; j <= lastTrade; j++) {
    const b = s.bars[j];
    if (bull) {
      if (b.l <= plan.sl) return { ...confirmed, outcome: "lost", outcomeR: -1 };
      if (b.h >= plan.tp) return { ...confirmed, outcome: "won", outcomeR: plan.rr };
    } else {
      if (b.h >= plan.sl) return { ...confirmed, outcome: "lost", outcomeR: -1 };
      if (b.l <= plan.tp) return { ...confirmed, outcome: "won", outcomeR: plan.rr };
    }
    if (j === lastTrade) {
      return {
        ...confirmed, outcome: "open",
        outcomeR: (bull ? b.c - entry : entry - b.c) / risk,
      };
    }
  }
  return confirmed;
}

/** bilingual logic bullets — pattern signature first, market context after */
function buildLogic(hit: RawHit, ctx: BarContext, A: Anatomy[]): { en: string[]; bn: string[] } {
  const en: string[] = [];
  const bn: string[] = [];
  const last = A[hit.i1];
  const fmt = (v: number) => v.toFixed(1);
  // ── pattern signature (what the SHAPE says) ──
  switch (hit.code) {
    case "HAMMER": case "HANGMAN":
      en.push(`Long lower wick (${fmt(last.loWick / ctx.atr)} ATR) — sellers drove price down, buyers rejected the low and closed near the top of the bar.`);
      bn.push(`লম্বা নিচের উইক (${fmt(last.loWick / ctx.atr)} ATR) — সেলাররা দাম ফেলেছে, বায়াররা লো রিজেক্ট করে বারের উপরের দিকে ক্লোজ করেছে।`);
      break;
    case "SHOOTSTAR": case "INVHAMMER":
      en.push(`Long upper wick (${fmt(last.upWick / ctx.atr)} ATR) — buyers pushed up, supply absorbed the push and closed the bar near its low.`);
      bn.push(`লম্বা উপরের উইক (${fmt(last.upWick / ctx.atr)} ATR) — বায়াররা উপরে ঠেলেছে, সাপ্লাই সেটা শুষে নিয়ে বারের নিচের দিকে ক্লোজ।`);
      break;
    case "ENGULF+": case "OUTSIDE-UP":
      en.push(`The bull body engulfs the entire prior bear body — demand overwhelmed the down bar in one session.`);
      bn.push(`বুল বডি আগের পুরো বিয়ার বডি গিলে ফেলেছে — এক সেশনেই ডিমান্ড ডাউন বারকে ছাপিয়ে গেছে।`);
      break;
    case "ENGULF-": case "OUTSIDE-DN":
      en.push(`The bear body engulfs the entire prior bull body — supply overwhelmed the up bar in one session.`);
      bn.push(`বিয়ার বডি আগের পুরো বুল বডি গিলে ফেলেছে — এক সেশনেই সাপ্লাই আপ বারকে ছাপিয়ে গেছে।`);
      break;
    case "MORNING*":
      en.push(`Big bear bar → small indecision star → strong bull close back above the first bar's midpoint: selling exhausted, buyers took over.`);
      bn.push(`বড় বিয়ার বার → ছোট ইন্ডিসিশন স্টার → শক্তিশালী বুল ক্লোজ প্রথম বারের মিডপয়েন্টের উপরে: সেলিং শেষ, বায়ার দখলে।`);
      break;
    case "EVENING*":
      en.push(`Big bull bar → small indecision star → strong bear close back below the first bar's midpoint: buying exhausted, sellers took over.`);
      bn.push(`বড় বুল বার → ছোট ইন্ডিসিশন স্টার → শক্তিশালী বিয়ার ক্লোজ প্রথম বারের মিডপয়েন্টের নিচে: বাইং শেষ, সেলার দখলে।`);
      break;
    case "SOLDIERS":
      en.push(`Three consecutive full bull bodies, each opening inside the prior body and closing higher — steady demand, no sell-the-close.`);
      bn.push(`টানা তিনটা ফুল বুল বডি, প্রতিটা আগের বডির ভেতরে ওপেন করে উঁচুতে ক্লোজ — ধারাবাহিক ডিমান্ড, ক্লোজে সেল নেই।`);
      break;
    case "CROWS":
      en.push(`Three consecutive full bear bodies, each opening inside the prior body and closing lower — steady supply, no dip-buying.`);
      bn.push(`টানা তিনটা ফুল বিয়ার বডি, প্রতিটা আগের বডির ভেতরে ওপেন করে নিচুতে ক্লোজ — ধারাবাহিক সাপ্লাই, ডিপে বাই নেই।`);
      break;
    case "PIERCE":
      en.push(`Opened below the prior close, rallied back above the prior body's midpoint — buyers reclaimed most of the down bar.`);
      bn.push(`আগের ক্লোজের নিচে ওপেন, তারপর আগের বডির মিডপয়েন্টের উপরে রally — বায়ার ডাউন বারের বেশিরভাগ ফিরিয়ে নিয়েছে।`);
      break;
    case "DARKCLOUD":
      en.push(`Opened above the prior close, sold off back below the prior body's midpoint — sellers reclaimed most of the up bar.`);
      bn.push(`আগের ক্লোজের উপরে ওপেন, তারপর আগের বডির মিডপয়েন্টের নিচে বিক্রি — সেলার আপ বারের বেশিরভাগ ফিরিয়ে নিয়েছে।`);
      break;
    case "HARAMI+": case "HARAMI-X+":
      en.push(`Small body (or doji) fully inside the prior big bear body — the down-drive lost momentum inside the prior bar's range.`);
      bn.push(`ছোট বডি (বা দোজি) আগের বড় বিয়ার বডির পুরো ভেতরে — ডাউন-ড্রাইভ আগের বারের রেঞ্জের ভেতরেই মোমেন্টাম হারিয়েছে।`);
      break;
    case "HARAMI-":
      en.push(`Small body fully inside the prior big bull body — the up-drive lost momentum inside the prior bar's range.`);
      bn.push(`ছোট বডি আগের বড় বুল বডির পুরো ভেতরে — আপ-ড্রাইভ আগের বারের রেঞ্জের ভেতরেই মোমেন্টাম হারিয়েছে।`);
      break;
    case "TWEEZER-B":
      en.push(`Two bars testing the SAME low — the level held twice; the second close back up shows who won the fight.`);
      bn.push(`দুই বার একই লো টেস্ট — লেভেল দুইবার ধরেছে; দ্বিতীয় বারের উপরের ক্লোজ দেখায় লড়াই কে জিতেছে।`);
      break;
    case "TWEEZER-T":
      en.push(`Two bars testing the SAME high — the level capped price twice; the second close back down shows who won the fight.`);
      bn.push(`দুই বার একই হাই টেস্ট — লেভেল দুইবার দাম আটকেছে; দ্বিতীয় বারের নিচের ক্লোজ দেখায় লড়াই কে জিতেছে।`);
      break;
    case "RISING3":
      en.push(`Big bull bar, three small pullback bars held INSIDE its range, then a bull close above the big bar's close — the pullback was absorbed, trend resumes.`);
      bn.push(`বড় বুল বার, তার রেঞ্জের ভেতরে সীমাবদ্ধ তিনটা ছোট পুলব্যাক বার, তারপর বিগ বারের ক্লোজের উপরে বুল ক্লোজ — পুলব্যাক শোষিত, ট্রেন্ড রিজিউম।`);
      break;
    case "FALLING3":
      en.push(`Big bear bar, three small bounce bars held INSIDE its range, then a bear close below the big bar's close — the bounce was absorbed, trend resumes.`);
      bn.push(`বড় বিয়ার বার, তার রেঞ্জের ভেতরে সীমাবদ্ধ তিনটা ছোট বাউন্স বার, তারপর বিগ বারের ক্লোজের নিচে বিয়ার ক্লোজ — বাউন্স শোষিত, ট্রেন্ড রিজিউম।`);
      break;
    case "PULLBACK3": case "PULLBACK3-":
      en.push(`Impulse leg → orderly 3-bar pullback that holds the impulse origin → trigger bar closing back beyond the pullback start: continuation confirmed.`);
      bn.push(`ইমপালস লেগ → সুশৃঙ্খল ৩-বার পুলব্যাক (ইমপালস লো ধরে রাখে) → ট্রিগার বার পুলব্যাকের শুরুর বাইরে ক্লোজ: কন্টিনিউয়েশন কনফার্ম।`);
      break;
    case "INSIDE-UP": case "INSIDE-DN":
      en.push(`Harami contraction, then a close beyond the big bar's extreme — the pause resolved in the reversal direction.`);
      bn.push(`হারামি কনট্রাকশন, তারপর বিগ বারের এক্সট্রিমের বাইরে ক্লোজ — পজটি রিভার্সাল দিকেই মীমাংসা।`);
      break;
    case "DRAGONFLY":
      en.push(`Open = high = close with a deep lower tail — the whole sell leg was bought back before the close.`);
      bn.push(`ওপেন = হাই = ক্লোজ, সাথে গভীর নিচের টেইল — পুরো সেল লেগ ক্লোজের আগেই ফিরে কেনা হয়েছে।`);
      break;
    case "GRAVESTONE":
      en.push(`Open = low = close with a deep upper tail — the whole buy leg was sold back before the close.`);
      bn.push(`ওপেন = লো = ক্লোজ, সাথে গভীর উপরের টেইল — পুরো বাই লেগ ক্লোজের আগেই ফিরে বিক্রি হয়েছে।`);
      break;
    case "MARUBOZU+": case "MARUBOZU-":
      en.push(`Full-body bar with almost no wicks — one side controlled the entire session; that control usually carries into the next bars.`);
      bn.push(`প্রায় উইক-ছাড়া ফুল-বডি বার — পুরো সেশন এক পক্ষের নিয়ন্ত্রণে; সেই নিয়ন্ত্রণ পরের বারগুলোতেও সাধারণত চলে।`);
      break;
    case "BELT+": case "BELT-":
      en.push(`Opens at the extreme and never looks back — an immediate one-sided rejection of the prior leg.`);
      bn.push(`এক্সট্রিমে ওপেন করে আর পেছনে তাকায় না — আগের লেগের তাৎক্ষণিক একতরফা রিজেকশন।`);
      break;
    case "DOJI": case "SPINNING":
      en.push(`Open ≈ close after a directional leg AT a level — conviction dried up exactly where the market had to decide.`);
      bn.push(`ডিরেকশনাল লেগের পর লেভেলে ওপেন ≈ ক্লোজ — মার্কেট যেখানে সিদ্ধান্ত নিতে হয় ঠিক সেখানেই কনভিকশন শুকিয়ে গেছে।`);
      break;
    default: break;
  }
  // ── market context (WHY here, why now) ──
  if (hit.bias === "reversal") {
    if (hit.side === "bull" && ctx.atLevel?.side === "support") {
      en.push(`Pattern sits ON support ${ctx.atLevel.price.toFixed(2)} (tested ×${ctx.atLevel.hits}) — demand defending a proven shelf.`);
      bn.push(`প্যাটার্নটি সাপোর্ট ${ctx.atLevel.price.toFixed(2)} এর উপরে (×${ctx.atLevel.hits} টেস্টেড) — প্রমাণিত শেল্ফে ডিমান্ড ডিফেন্স করছে।`);
    } else if (hit.side === "bear" && ctx.atLevel?.side === "resistance") {
      en.push(`Pattern sits ON resistance ${ctx.atLevel.price.toFixed(2)} (tested ×${ctx.atLevel.hits}) — supply defending a proven ceiling.`);
      bn.push(`প্যাটার্নটি রেসিসট্যান্স ${ctx.atLevel.price.toFixed(2)} এ (×${ctx.atLevel.hits} টেস্টেড) — প্রমাণিত ছাদে সাপ্লাই ডিফেন্স করছে।`);
    }
    if (ctx.trendInto === "down" && hit.side === "bull") {
      en.push(`Approach leg fell ${Math.abs(ctx.legAtr).toFixed(1)} ATR into the pattern — an extended leg is reversal fuel.`);
      bn.push(`প্যাটার্নের আগে ${Math.abs(ctx.legAtr).toFixed(1)} ATR নিচের লেগ — এক্সটেন্ডেড লেগ রিভার্সালের জ্বালানি।`);
    }
    if (ctx.trendInto === "up" && hit.side === "bear") {
      en.push(`Approach leg rallied ${ctx.legAtr.toFixed(1)} ATR into the pattern — an extended leg is reversal fuel.`);
      bn.push(`প্যাটার্নের আগে ${ctx.legAtr.toFixed(1)} ATR উপরের লেগ — এক্সটেন্ডেড লেগ রিভার্সালের জ্বালানি।`);
    }
  } else if (hit.bias === "continuation") {
    en.push(`Fires WITH the ${ctx.trendInto === "up" ? "up" : "down"} leg — continuation patterns pay when the trend they ride is intact.`);
    bn.push(`${ctx.trendInto === "up" ? "আপ" : "ডাউন"} লেগের সাথে ফায়ার করে — কন্টিনিউয়েশন প্যাটার্ন তখনই কাজে লাগে যখন যে ট্রেন্ডে চলে সেটা অটুট।`);
  }
  if (hit.side === "bull" && ctx.rsi != null && ctx.rsi <= 34) {
    en.push(`RSI ${ctx.rsi.toFixed(0)} — oversold tape supports the bounce.`);
    bn.push(`RSI ${ctx.rsi.toFixed(0)} — ওভারসোল্ড টেপ বাউন্সকে সাপোর্ট করে।`);
  }
  if (hit.side === "bear" && ctx.rsi != null && ctx.rsi >= 66) {
    en.push(`RSI ${ctx.rsi.toFixed(0)} — overbought tape supports the drop.`);
    bn.push(`RSI ${ctx.rsi.toFixed(0)} — ওভারবট টেপ ড্রপকে সাপোর্ট করে।`);
  }
  if (ctx.volZ >= 1.5) {
    en.push(`Trigger bar volume +${ctx.volZ.toFixed(1)}σ above its trailing average — real participation, not a thin-tape fake.`);
    bn.push(`ট্রিগার বারের ভলিউম ট্রেইলিং গড়ের চেয়ে +${ctx.volZ.toFixed(1)}σ — আসল পার্টিসিপেশন, থিন-টেপ ফেক না।`);
  }
  // structure honesty
  if (hit.side === "bull" && ctx.structure === "LH/LL") {
    en.push(`Careful: structure is still LH/LL (downtrend) — this is a counter-trend reversal until a higher low forms.`);
    bn.push(`সতর্কতা: স্ট্রাকচার এখনো LH/LL (ডাউনট্রেন্ড) — হায়ার লো না আসা পর্যন্ত এটা কাউন্টার-ট্রেন্ড রিভার্সাল।`);
  }
  if (hit.side === "bear" && ctx.structure === "HH/HL") {
    en.push(`Careful: structure is still HH/HL (uptrend) — this is a counter-trend reversal until a lower high forms.`);
    bn.push(`সতর্কতা: স্ট্রাকচার এখনো HH/HL (আপট্রেন্ড) — লোয়ার হাই না আসা পর্যন্ত এটা কাউন্টার-ট্রেন্ড রিভার্সাল।`);
  }
  return { en, bn };
}

/** resolve the pattern against the bars AFTER it: confirmed / failed / fresh / expired */
function resolveStatus(s: Series, hit: RawHit, plan: { entry: number; sl: number; tp: number }): CandleStatus {
  const aV = (s.atr[hit.i1] ?? 1) || 1;
  const segHi = Math.max(...s.a.slice(hit.i0, hit.i1 + 1).map((x) => x.b.h));
  const segLo = Math.min(...s.a.slice(hit.i0, hit.i1 + 1).map((x) => x.b.l));
  for (let j = hit.i1 + 1; j < s.bars.length; j++) {
    const b = s.bars[j];
    if (hit.side === "bull") {
      if (b.c > segHi + 0.05 * aV) return "confirmed";   // a close beyond the pattern high
      if (b.c < plan.sl) return "failed";                  // a close beyond the stop
    } else {
      if (b.c < segLo - 0.05 * aV) return "confirmed";
      if (b.c > plan.sl) return "failed";
    }
  }
  return s.bars.length - 1 - hit.i1 <= 8 ? "fresh" : "expired";
}

// ─────────────────────────── public API ───────────────────────────

export interface CandleRead {
  /** the patterns, newest first (bounded by `max`) */
  patterns: CandlePattern[];
  /** the chart drawings for those patterns */
  drawings: CandleDrawing[];
}

/** one fully-evaluated candidate fire (pre-suppression) */
// ── the TWO-STRIKES guard (v19.0, from the walk-forward diagnostic) ──
//
// On the real tape the big losing clusters were CASCADES: a support breaks
// and the engine keeps printing bull reversals at it (10-05: five bull
// fires in 85 minutes, conf 76–96, ALL lost). Textbook: after repeated
// failed same-side attempts the directional run is dominant — stop firing
// that side until the tape proves otherwise. Mechanically: a candidate is
// suppressed when ≥2 same-side candidates fired within the last
// STRIKE_WINDOW bars AND their entries are already violated (0.2 ATR
// against them) as of the candidate's close. Suppressed attempts still
// count as attempts — a knife has no fewer edges for having been dodged.
const STRIKE_WINDOW = 30;      // bars
const STRIKE_BREACH_ATR = 0.2; // entry-violation depth, in ATR

/**
 * Shared pipeline: candidates (newest-first span-blocking) → chronological
 * two-strikes filter. The SAME collection feeds the live read and the
 * backtest — what you see is exactly what was measured.
 */
function collectFires(s: Series, from: number): FireCandidate[] {
  // pass A — raw candidates, newest-first (span priority: newest wins)
  const cands: FireCandidate[] = [];
  const spans: { i0: number; i1: number }[] = [];
  for (let k = s.bars.length - 1; k >= from; k--) {
    const hit = matchAt(s, k);
    if (!hit) continue;
    const ctx = contextAt(s, hit.i0, hit.i1);
    if (!hit.gate(ctx)) continue;
    if (spans.some((x) => hit.i0 <= x.i1 && hit.i1 >= x.i0)) continue;
    const conf = scoreConfidence(hit, ctx, s.a);
    if (!accepts(hit, ctx, conf)) continue; // the shared quality gate
    spans.push({ i0: hit.i0, i1: hit.i1 });
    cands.push({ hit, ctx, conf });
  }
  // pass B — chronological two-strikes filter
  cands.sort((a, b) => a.hit.i1 - b.hit.i1);
  const attempts: { i1: number; side: "bull" | "bear"; close: number; atr: number }[] = [];
  const kept: FireCandidate[] = [];
  for (const c of cands) {
    const now = s.bars[c.hit.i1].c;
    const strikes = attempts.filter(
      (a) =>
        a.side === c.hit.side &&
        c.hit.i1 - a.i1 <= STRIKE_WINDOW &&
        (c.hit.side === "bull"
          ? now < a.close - STRIKE_BREACH_ATR * a.atr
          : now > a.close + STRIKE_BREACH_ATR * a.atr),
    ).length;
    // every candidate is remembered as an attempt (suppressed or not)
    attempts.push({ i1: c.hit.i1, side: c.hit.side, close: s.bars[c.hit.i1].c, atr: c.ctx.atr });
    if (strikes >= 2) continue; // the run is dominant — same side stands down
    kept.push(c);
  }
  return kept.reverse(); // newest first again
}

/** the FireCandidate shape (post-restructure: no plan pre-confirmation) */
interface FireCandidate {
  hit: RawHit;
  ctx: BarContext;
  conf: number;
}

/**
 * Detect the candlestick setups on a CLOSED-bar window. `max` bounds how
 * many show (newest first); detection scans the last `scanBars` bars so
 * the read stays fresh without mining noise. Statuses tell the whole
 * story: fresh = WATCH (pattern printed, entry waits for the confirmation
 * close), confirmed = the confirmation printed and the plan is live,
 * failed = broke before confirming (or the stop closed through after),
 * expired = the window passed with no confirmation.
 */
export function detectCandlePatterns(barsIn: Candle[], sourceTf?: string, max = 6, scanBars = 160): CandleRead {
  const patterns: CandlePattern[] = [];
  const drawings: CandleDrawing[] = [];
  try {
    const closed = barsIn.filter((b) => !b.f);
    if (closed.length < 60) return { patterns, drawings };
    const s = buildSeries(closed);
    const fires = collectFires(s, Math.max(12, s.bars.length - scanBars));
    let shown = 0;
    for (const { hit, ctx, conf } of fires) {
      const r = resolveSetup(s, hit, ctx, conf);
      // expired setups never became trades — panel keeps them (context),
      // the chart does not (they are non-events, not ink)
      const drawIt = r.status !== "expired";
      if (drawIt && shown >= max) continue;
      if (drawIt) shown++;
      const logic = buildLogic(hit, ctx, s.a);
      const seg = s.a.slice(hit.i0, hit.i1 + 1);
      const lo = Math.min(...seg.map((x) => x.b.l));
      const hi = Math.max(...seg.map((x) => x.b.h));
      // the confirmation rule is part of the strategy — say it in the logic
      if (r.status === "fresh") {
        logic.en.push(`WATCH — entry only on a CLOSE ${r.hit.side === "bull" ? "above" : "below"} ${(r.hit.side === "bull" ? Math.max(hi, r.entry) : Math.min(lo, r.entry)).toFixed(2)} (pattern extreme + buffer) within ${CONFIRM_WINDOW} bars. No confirmation, no trade.`);
        logic.bn.push(`ওয়াচ — প্যাটার্ন এক্সট্রিমের ${r.hit.side === "bull" ? "উপরে" : "নিচে"} ক্লোজ হলেই এন্ট্রি (${(r.hit.side === "bull" ? Math.max(hi, r.entry) : Math.min(lo, r.entry)).toFixed(2)} — ${CONFIRM_WINDOW} বারের মধ্যে)। কনফার্মেশন না এলে ট্রেড নেই।`);
      }
      const p: CandlePattern = {
        id: `${hit.code}:${s.bars[hit.i0].t}`,
        code: hit.code, nameEn: hit.nameEn, nameBn: hit.nameBn,
        n: hit.n, side: hit.side, bias: hit.bias,
        direction: hit.side === "bull" ? "up" : "down",
        t0: s.bars[hit.i0].t, t1: s.bars[hit.i1].t,
        lo, hi, triggerClose: s.bars[hit.i1].c,
        confidence: conf, status: r.status, outcome: r.outcome,
        entry: r.entry, sl: r.sl, tp: r.tp, rr: r.rr,
        logicEn: logic.en, logicBn: logic.bn,
        context: {
          trendInto: ctx.trendInto,
          atLevel: ctx.atLevel?.side ?? null,
          levelPrice: ctx.atLevel?.price ?? null,
          structure: ctx.structure,
          rsi: ctx.rsi,
          volZ: Math.round(ctx.volZ * 10) / 10,
        },
      };
      if (patterns.length >= 8) continue; // payload cap — the panel needs the freshest reads, not the census
      patterns.push(p);
      if (drawIt) {
        drawings.push({
          kind: "candle",
          code: hit.code,
          name: hit.code,
          side: hit.side,
          n: hit.n,
          direction: p.direction,
          status: r.status,
          outcome: r.outcome ?? undefined,
          confidence: conf,
          t0: p.t0, t1: p.t1, lo, hi,
          ...(sourceTf ? { source_tf: sourceTf } : {}),
        });
      }
    }
    return { patterns, drawings };
  } catch {
    return { patterns, drawings }; // candle ink must never break /api/analysis
  }
}

/** how many bars a resolved pattern had to prove itself in */
const BACKTEST_HORIZON = 24;

/**
 * Walk-forward backtest of the candle STRATEGY (confirmation-entry): a
 * candidate becomes a TRADE only when a bar closes beyond the pattern
 * extreme within CONFIRM_WINDOW bars (the textbook rule that flipped
 * every timeframe positive). The fill is that confirmation close; the
 * stop is the pattern extreme ± 0.15 ATR; the target 1.5R capped by the
 * nearest live level; resolution is STOP-FIRST over the 24 bars after
 * the fill. Per-code and per-candle-count stats — the win-rate badges in
 * the UI carry THESE numbers, from this symbol's own tape.
 */
export function backtestCandles(barsIn: Candle[]): CandleBacktest {
  const empty: CandleBacktest = {
    scanned: 0, horizonBars: BACKTEST_HORIZON, open: 0,
    overall: { fired: 0, won: 0, lost: 0, expired: 0, winPct: 0, avgR: 0, totalR: 0 },
    byCode: [], byN: [],
  };
  try {
    const closed = barsIn.filter((b) => !b.f);
    if (closed.length < 120) return empty;
    const s = buildSeries(closed);
    empty.scanned = s.bars.length;
    const fires = collectFires(s, 20);
    const byCode = new Map<string, CandlePatternStat>();
    const byN = new Map<number, { n: number; fired: number; won: number; rSum: number }>();
    let fired = 0, won = 0, lost = 0, expired = 0, open = 0, rSum = 0;
    for (const { hit, ctx, conf } of fires) {
      if (hit.i1 + 3 >= s.bars.length) { open++; continue; } // too fresh to judge
      const r = resolveSetup(s, hit, ctx, conf);
      if (r.status !== "confirmed" || r.pending || r.noRoom || r.outcome == null || r.outcomeR == null) {
        // never confirmed (or confirmed into no room) — a watch that
        // didn't become a trade; counted as expired, not as a loss
        expired++;
        continue;
      }
      const outcome = r.outcome === "open" ? "expired" : r.outcome;
      const rv = r.outcomeR;
      fired++;
      rSum += rv;
      if (outcome === "won") won++;
      else if (outcome === "lost") lost++;
      else expired++;
      const rec = byCode.get(hit.code) ?? {
        code: hit.code, nameEn: hit.nameEn, nameBn: hit.nameBn, n: hit.n, side: hit.side,
        fired: 0, won: 0, lost: 0, expired: 0, winPct: 0, avgR: 0, totalR: 0,
      };
      rec.fired++;
      if (outcome === "won") rec.won++;
      else if (outcome === "lost") rec.lost++;
      else rec.expired++;
      rec.totalR += rv;
      byCode.set(hit.code, rec);
      const nRec = byN.get(hit.n) ?? { n: hit.n, fired: 0, won: 0, rSum: 0 };
      nRec.fired++;
      if (outcome === "won") nRec.won++;
      nRec.rSum += rv;
      byN.set(hit.n, nRec);
    }
    const decided = won + lost;
    for (const rec of byCode.values()) {
      const d = rec.won + rec.lost;
      rec.winPct = d ? Math.round((rec.won / d) * 100) : 0;
      rec.avgR = rec.fired ? Math.round((rec.totalR / rec.fired) * 100) / 100 : 0;
      rec.totalR = Math.round(rec.totalR * 10) / 10;
    }
    return {
      scanned: s.bars.length,
      horizonBars: BACKTEST_HORIZON,
      open,
      overall: {
        fired, won, lost, expired,
        winPct: decided ? Math.round((won / decided) * 100) : 0,
        avgR: fired ? Math.round((rSum / fired) * 100) / 100 : 0,
        totalR: Math.round(rSum * 10) / 10,
      },
      byCode: [...byCode.values()].sort((a, b) => b.fired - a.fired),
      byN: [...byN.values()].map((x) => ({
        n: x.n, fired: x.fired,
        winPct: x.fired ? Math.round((x.won / x.fired) * 100) : 0,
        avgR: x.fired ? Math.round((x.rSum / x.fired) * 100) / 100 : 0,
      })).sort((a, b) => a.n - b.n),
    };
  } catch {
    return empty;
  }
}

/** the catalog size the UI can quote ("32 setups · 1–5 candles") */
export const CANDLE_CATALOG_SIZE = 32;
