/**
 * phases.ts — the market-STRUCTURE narrative layer (v16.5, user spec):
 * WHERE the market consolidates (range boxes), WHERE the smart-money AMD
 * sequence plays out (Accumulation → Manipulation → Distribution — the
 * banks/institutions stop-hunt then expand), WHERE big players left their
 * footprint (tick-volume-spiked impulse candles = institutional interest),
 * and the HTF (H1/H4) ranges for the multi-timeframe story.
 *
 * Walk-forward contract (audit §Phase-3): every range / phase / mark
 * emitted "at bar i" is computed from bars ≤ i ONLY. A completed phase
 * never repaints when future bars arrive — verified by
 * scripts/verify-structure-map.ts on real broker bars.
 */

import type { Candle } from "./types";
import { atr } from "./indicators";

// ───────────────────────── consolidation ranges ─────────────────────────

export interface ConsolidationRange {
  t0: number; // first bar of the range
  t1: number; // last bar INSIDE the range (before the break)
  hi: number;
  lo: number;
  bars: number;
  /** forming = price still inside at the last bar; broken_* = a close beyond the edge */
  state: "forming" | "broken_up" | "broken_down";
  /** the bar that closed outside (known at that bar — no repaint) */
  breakT?: number;
}

/**
 * A consolidation = a run of ≥ minBars bars whose total width stays within
 * maxRangeAtr × ATR and which ends when a bar CLOSES beyond the running
 * hi/lo (the break) or the width explodes (gap through). The live tail
 * still inside the bounds is reported as state:"forming".
 */
export function detectConsolidations(
  bars: Candle[],
  opts: { minBars?: number; maxRangeAtr?: number; impulseAtr?: number } = {},
): ConsolidationRange[] {
  const { minBars = 8, maxRangeAtr = 3.2, impulseAtr = 1.25 } = opts;
  if (bars.length < minBars + 4) return [];
  const a = atr(bars);
  const atrAt = (i: number): number => {
    for (let k = Math.min(i, a.length - 1); k >= 0; k--) {
      if (a[k] != null) return a[k] as number;
    }
    return 0;
  };

  const out: ConsolidationRange[] = [];
  let start = -1;
  let hi = -Infinity;
  let lo = Infinity;

  const flush = (endIdx: number, state: ConsolidationRange["state"], breakT?: number) => {
    if (start >= 0 && endIdx - start + 1 >= minBars) {
      out.push({
        t0: bars[start].t, t1: bars[endIdx].t,
        hi, lo, bars: endIdx - start + 1,
        state, breakT,
      });
    }
    start = -1;
    hi = -Infinity;
    lo = Infinity;
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ai = atrAt(i) || 1;
    const body = Math.abs(b.c - b.o);
    if (start < 0) {
      // a range starts on the first NON-impulse bar after a move
      if (body >= impulseAtr * ai) continue;
      start = i;
      hi = b.h;
      lo = b.l;
      continue;
    }
    const nHi = Math.max(hi, b.h);
    const nLo = Math.min(lo, b.l);
    const tooWide = nHi - nLo > maxRangeAtr * ai;
    const brokeUp = b.c > hi;
    const brokeDown = b.c < lo;
    if (tooWide) {
      // a bar blew through the bounds — treat as the break if it closed outside
      flush(
        i - 1,
        brokeUp ? "broken_up" : brokeDown ? "broken_down" : "forming",
        brokeUp || brokeDown ? b.t : undefined,
      );
      if (body < impulseAtr * ai) { start = i; hi = b.h; lo = b.l; }
      continue;
    }
    if (brokeUp || brokeDown) {
      flush(i - 1, brokeUp ? "broken_up" : "broken_down", b.t);
      if (body < impulseAtr * ai) { start = i; hi = b.h; lo = b.l; }
      continue;
    }
    hi = nHi;
    lo = nLo;
  }
  // live tail — still inside the bounds at the last bar
  if (start >= 0 && bars.length - start >= minBars) {
    out.push({
      t0: bars[start].t, t1: bars[bars.length - 1].t,
      hi, lo, bars: bars.length - start, state: "forming",
    });
  }
  return out;
}

// ───────────────────────── AMD phases (the smart-money sequence) ─────────────────────────

export interface AmdPhase {
  phase: "accumulation" | "manipulation" | "distribution";
  t0: number;
  t1: number;
  hi: number;
  lo: number;
  /** resolution direction of the expansion (the tradeable leg) */
  dir: "up" | "down";
  /** done = the sequence resolved (a later consolidation began / sequence completed) */
  done: boolean;
}

/**
 * ICT/Wyckoff AMD on each consolidation range:
 *   ACCUMULATION  — the range itself (institutions build inventory)
 *   MANIPULATION  — right after the range, a wick beyond one edge that
 *                   CLOSES BACK INSIDE (the stop hunt / false break)
 *   DISTRIBUTION  — the expansion leg in the OPPOSITE direction of the hunt
 *
 * A plain breakout without the sweep is NOT an AMD sequence (skipped).
 * LIVE case: a forming range + a recent sweep of one side ⇒ manipulation
 * in progress (done:false) — the on-chart reversal hint.
 */
export function detectAmdPhases(bars: Candle[], ranges: ConsolidationRange[]): AmdPhase[] {
  const out: AmdPhase[] = [];
  const idxOf = (t: number) => bars.findIndex((b) => b.t === t);

  for (const r of ranges) {
    const startIdx = idxOf(r.t1) + 1;
    if (startIdx <= 0 || startIdx >= bars.length) continue;

    if (r.state === "forming") {
      // LIVE manipulation read: a sweep in the last ≤4 bars that closed
      // back inside the forming range → expect the opposite-side expansion.
      for (let i = Math.max(startIdx, bars.length - 4); i < bars.length; i++) {
        const b = bars[i];
        const sweptLow = b.l < r.lo && b.c > r.lo;
        const sweptHigh = b.h > r.hi && b.c < r.hi;
        if (sweptLow || sweptHigh) {
          const dir: "up" | "down" = sweptLow ? "up" : "down";
          out.push({ phase: "accumulation", t0: r.t0, t1: r.t1, hi: r.hi, lo: r.lo, dir, done: false });
          out.push({ phase: "manipulation", t0: b.t, t1: b.t, hi: b.h, lo: b.l, dir, done: false });
          break; // one live read per range
        }
      }
      continue;
    }

    // resolved range: look for the sweep BEFORE/AT the break bar (≤4 bars window)
    const dir: "up" | "down" = r.state === "broken_up" ? "up" : "down";
    const breakIdx = r.breakT != null ? idxOf(r.breakT) : -1;
    if (breakIdx < 0) continue;
    let manip: { t: number; hi: number; lo: number } | null = null;
    for (let i = startIdx; i < Math.min(breakIdx + 1, startIdx + 4, bars.length); i++) {
      const b = bars[i];
      const beyond = dir === "up" ? b.l < r.lo : b.h > r.hi;
      const backIn = dir === "up" ? b.c > r.lo : b.c < r.hi;
      if (beyond && backIn) {
        manip = { t: b.t, hi: b.h, lo: b.l };
        break;
      }
    }
    if (!manip) continue; // plain breakout — no AMD narrative

    // distribution: the expansion from the break bar until the next
    // consolidation starts (or the last bar — still running)
    const nextRange = ranges.find((x) => x.t0 > (r.breakT ?? r.t1));
    const endIdx = nextRange ? Math.max(breakIdx, idxOf(nextRange.t0) - 1) : bars.length - 1;
    let eHi = -Infinity;
    let eLo = Infinity;
    for (let i = breakIdx; i <= endIdx; i++) {
      eHi = Math.max(eHi, bars[i].h);
      eLo = Math.min(eLo, bars[i].l);
    }
    if (!Number.isFinite(eHi) || !Number.isFinite(eLo)) continue;
    const done = !!nextRange;
    out.push({ phase: "accumulation", t0: r.t0, t1: r.t1, hi: r.hi, lo: r.lo, dir, done });
    out.push({ phase: "manipulation", t0: manip.t, t1: manip.t, hi: manip.hi, lo: manip.lo, dir, done });
    out.push({ phase: "distribution", t0: r.breakT!, t1: bars[endIdx].t, hi: eHi, lo: eLo, dir, done });
  }
  // keep the most recent 2 sequences (6 phase segments) — the chart reads clean
  return out.slice(-6);
}

// ───────────────────────── institutional footprints ─────────────────────────

export interface InstitutionalMark {
  t: number;
  price: number;
  side: "buy" | "sell";
  volZ: number;
}

/**
 * Big-player interest = a tick-VOLUME spike (z ≥ 2.2 over the previous 50
 * bars, walk-forward) on a directional impulse body (≥ 1.1 ATR). MT5 volume
 * is tick volume (labeled as such everywhere) — a z-spike is the honest
 * proxy for "banks were active here". Also returns every z ≥ 1.5 bar time
 * so zone labels can carry the INST (institutional) tag.
 */
export function detectInstitutionalActivity(
  bars: Candle[],
  opts: { zMin?: number; bodyAtr?: number; max?: number; win?: number } = {},
): { marks: InstitutionalMark[]; volSpikes: Map<number, number> } {
  const { zMin = 2.2, bodyAtr = 1.1, max = 4, win = 50 } = opts;
  const a = atr(bars);
  const volSpikes = new Map<number, number>();
  const marks: InstitutionalMark[] = [];
  for (let i = win; i < bars.length; i++) {
    // walk-forward stats over the PREVIOUS win bars only — no look-ahead
    let m = 0;
    for (let k = i - win; k < i; k++) m += bars[k].v;
    m /= win;
    let s2 = 0;
    for (let k = i - win; k < i; k++) s2 += (bars[k].v - m) ** 2;
    const sd = Math.sqrt(s2 / win) || 1;
    const z = (bars[i].v - m) / sd;
    if (z < 1.5) continue;
    volSpikes.set(bars[i].t, Number(z.toFixed(2)));
    const ai = a[i] as number | null;
    const body = Math.abs(bars[i].c - bars[i].o);
    if (z >= zMin && ai != null && ai > 0 && body >= bodyAtr * ai) {
      marks.push({
        t: bars[i].t,
        price: bars[i].c,
        side: bars[i].c > bars[i].o ? "buy" : "sell",
        volZ: Number(z.toFixed(1)),
      });
    }
  }
  return { marks: marks.slice(-max), volSpikes };
}
