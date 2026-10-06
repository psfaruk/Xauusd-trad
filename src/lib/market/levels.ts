/**
 * levels.ts — v17.1 multi-timeframe support & resistance key levels.
 *
 * User report: "সকল টাইম ফ্রেমে সাপোর্ট এন্ড রেসিসটেন্স লেভেল ড্রয়িং হচ্ছে না" —
 * S/R was only ever implied by zones/pools on the active chart; every
 * timeframe's OWN structural levels were never drawn. This module reads
 * each timeframe independently and emits its live (unbroken) swing levels:
 *
 *   · a swing HIGH that no later bar has CLOSED above → RESISTANCE
 *   · a swing LOW that no later bar has CLOSED below  → SUPPORT
 *   · hits = how many times the level was TESTED (wick within 0.30 ATR of
 *     the source tf) — ×2+ tags print on the line, single-touch levels
 *     draw dashed
 *   · levels the market closed through are DEAD and never emitted — a
 *     broken level is history, not S/R
 *
 * The levels feed the v17.0 clustering pass: an H1/H4-sourced line is a
 * TIER-1 "HTF key level" (beats fresh OB/FVG, beats local S/R), an
 * active-tf line is tier-3 local S/R. Duplicates at the same price merge
 * into one line with the ×N badge + hover rationale — one line per level.
 */

import type { Candle } from "./types";
import { atr, swings } from "./indicators";

export interface SrLevel {
  price: number;
  side: "support" | "resistance";
  /** times the level was tested (incl. the origin swing) */
  hits: number;
  /** origin swing time (sec) — the line is drawn FROM here */
  t: number;
  /** last touch time (sec) — freshness ruler for the cluster pass */
  lastT: number;
}

/** wick within this many source-tf ATRs of the level = a touch */
const TOUCH_ATR = 0.30;
/** a close this far through the level (in ATRs) breaks it */
const BREAK_ATR = 0.15;

/**
 * The live S/R levels of ONE timeframe. `perSide` caps each side (the
 * route passes 3 for H1/H4 — the key HTF levels — and 2 for the fast tfs
 * whose micro levels churn too fast to matter cross-timeframe).
 */
export function detectKeyLevels(bars: Candle[], perSide = 2): SrLevel[] {
  const n = bars.length;
  if (n < 40) return [];
  const win = bars.slice(-260);
  const a = atr(win);
  const atrAt = (i: number): number => {
    for (let k = Math.min(i, win.length - 1); k >= 0; k--) {
      if (a[k] != null) return a[k] as number;
    }
    return 0;
  };
  const lastAtr = atrAt(win.length - 1) || 1;
  const sw = swings(win, 3, 3); // major-structure fractals (3-left/3-right)
  const out: SrLevel[] = [];

  const build = (kind: "high" | "low") => {
    // freshest 6 swings per side = the candidate pool; older ones are
    // almost always broken or irrelevant by the time they matter
    const pts = sw.filter((s) => s.kind === kind).slice(-6);
    for (const s of pts) {
      const atrS = atrAt(s.index);
      if (!(atrS > 0)) continue;
      const tol = TOUCH_ATR * atrS;
      const breakPad = BREAK_ATR * atrS;
      let hits = 1;
      let lastT = s.t;
      let broken = false;
      // walk FORWARD from the swing bar — no lookahead, honest timeline
      for (let i = s.index + 1; i < win.length; i++) {
        const b = win[i];
        const touched = kind === "high" ? b.h >= s.price - tol : b.l <= s.price + tol;
        if (touched) {
          hits++;
          lastT = b.t;
        }
        if (kind === "high" ? b.c > s.price + breakPad : b.c < s.price - breakPad) {
          broken = true;
          break;
        }
      }
      if (broken) continue; // dead level — never drawn as S/R
      out.push({
        price: s.price,
        side: kind === "high" ? "resistance" : "support",
        hits,
        t: s.t,
        lastT,
      });
    }
  };
  build("high");
  build("low");

  // rank: most-tested first, fresher last-touch breaks ties
  const rank = (x: SrLevel) => x.hits * 1e12 + x.lastT;
  const pick = (side: "support" | "resistance"): SrLevel[] => {
    const arr = out.filter((l) => l.side === side).sort((x, y) => rank(y) - rank(x));
    // dedupe near-identical levels (same structural shelf within 0.35 ATR)
    // keeping the stronger representative
    const kept: SrLevel[] = [];
    for (const l of arr) {
      const dup = kept.find((k) => Math.abs(k.price - l.price) <= 0.35 * lastAtr);
      if (!dup) kept.push(l);
      else if (l.hits > dup.hits) kept[kept.indexOf(dup)] = l;
    }
    return kept.slice(0, perSide);
  };
  return [...pick("support"), ...pick("resistance")];
}
