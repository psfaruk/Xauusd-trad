/**
 * patterns.ts — the classic chart-pattern engine (v16.6).
 *
 * A faithful TypeScript port of the reference repo's
 * `backend/app/analysis/patterns.py` (commit 7241c36, "the studied
 * @easytradingeasy recipe"): the drawing style the user pointed at —
 * numbered swing circles 1..N, thin geometry lines, whisper shading,
 * ENTRY ring + red dashed SL + gold TARGET band + breakout arrow, and
 * the measured-move math that answers "reversal হলে কত দূর যাবে /
 * continue করলে কত দূর যাবে" for every pattern it prints.
 *
 * Families detected on the ACTIVE timeframe's closed window (the ones
 * that actually print on intraday gold):
 *   reversal      — DOUBLE/TRIPLE TOP/BOTTOM, HEAD & SHOULDERS (+inverse)
 *   continuation  — BULL/BEAR FLAG + PENNANT (impulse pole + consolidation)
 *   boundary      — ASC/DESC/SYMMETRIC TRIANGLE, RISING/FALLING WEDGE,
 *                   BULL/BEAR RECTANGLE
 *
 * Every detection carries the textbook trade plan: entry at the trigger
 * level, SL beyond the pattern extreme, TARGET at the measured move
 * (pattern height / pole projection), RR, and a forming→confirmed state
 * (confirmed = a CLOSE through the trigger, never a wick).
 *
 * Walk-forward contract (same as phases.ts): detection runs on CLOSED
 * bars only and a pattern printed "at bar i" never repaints — verified
 * by scripts/verify-structure-map.ts on prefix cuts of real broker bars.
 */

import type { Candle } from "./types";
import { atr, last, swings, type Swing } from "./indicators";

// pattern quality floors / tolerances (in ATR units — ref repo values)
const TOP_TOL = 0.30; // peaks count as "equal" within 0.30 ATR
const MIN_HEIGHT = 0.9; // pattern height must reach 0.9 ATR (a real shape)
const MAX_HEIGHT = 14.0; // …but not a monthly mega-structure
const POLE_MIN = 1.8; // flag pole: 1.8 ATR impulse
const FLAG_MAXRETR = 0.55; // flag may retrace at most 55% of the pole
const MAX_POINTS_GAP = 26; // max bars between consecutive pivots
const TOL_FLAT = 0.22; // rectangle / triangle flat-side tolerance
const CONFIRM_PAD = 0.05; // close must finish this far past the level
const MIN_SWINGS = 3; // a double top is already high-trough-high (3)
const RECENT_BARS = 40; // the last pivot must be within this many bars
const WINDOW = 150; // the visible window we scan (like the ref engine)

// ───────────────────────────────── types ─────────────────────────────────

export interface PatternPoint {
  t: number;
  price: number;
  n: number;
  kind: "high" | "low";
}

export interface PatternLine {
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  dash?: boolean;
}

export interface PatternDrawing {
  kind: "pattern";
  name: string;
  family: "reversal" | "continuation" | "boundary";
  dir: "up" | "down";
  state: "forming" | "confirmed";
  points: PatternPoint[];
  lines: PatternLine[];
  zone: { t: number; lo: number; hi: number } | null;
  entry: { price: number; t?: number };
  sl: number;
  target: number;
  target_zone: { lo: number; hi: number };
  height_atr: number | null;
  rr: number | null;
  note: string;
  breakout_t?: number;
  tone: "bull" | "bear";
  source_tf?: string;
}

interface Pivot {
  t: number;
  price: number;
  kind: "high" | "low";
  i: number;
}

// ─────────────────────────────── helpers ────────────────────────────────

/** Confirmed alternating pivots inside the window (strict high/low
 * alternation — pattern geometry needs it). Same recipe as the ref. */
function pivots(bars: Candle[]): Pivot[] {
  const win = bars.slice(-WINDOW);
  const off = bars.length - win.length;
  // only scan the tail where consecutive pivots can be ≤ MAX_POINTS_GAP
  const sub = win.slice(Math.max(0, win.length - MAX_POINTS_GAP * 4));
  const baseOff = bars.length - sub.length;
  const raw = swings(sub, 2, 2).map((s: Swing) => ({
    t: s.t, price: s.price, kind: s.kind, i: baseOff + s.index,
  }));
  // guarantee strict alternation: same kind twice → keep the extreme
  const alt: Pivot[] = [];
  for (const p of raw) {
    const prev = alt[alt.length - 1];
    if (prev && prev.kind === p.kind) {
      if (p.kind === "high" && p.price >= prev.price) alt[alt.length - 1] = p;
      else if (p.kind === "low" && p.price <= prev.price) alt[alt.length - 1] = p;
    } else {
      alt.push(p);
    }
  }
  void off;
  return alt;
}

function mkPattern(
  name: string, family: PatternDrawing["family"], dirn: "up" | "down",
  pts: Pivot[], lines: PatternLine[],
  zone: { lo: number; hi: number; t: number } | null,
  entry: number, sl: number, target: number, state: PatternDrawing["state"],
  atrVal: number, note: string, breakoutT?: number,
): PatternDrawing {
  const hi = Math.max(...pts.map((p) => p.price));
  const lo = Math.min(...pts.map((p) => p.price));
  const height = hi - lo;
  const numbered: PatternPoint[] = pts.map((p, i) => ({
    t: p.t, price: p.price, n: i + 1, kind: p.kind,
  }));
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(target - entry);
  const rr = risk > 1e-9 ? Number((reward / risk).toFixed(2)) : null;
  // target band: from target back toward entry by 30% of height
  const bandW = 0.3 * height;
  const [tLo, tHi] = dirn === "down" ? [target, target + bandW] : [target - bandW, target];
  return {
    kind: "pattern",
    name, family, dir: dirn, state,
    points: numbered,
    lines,
    zone: zone ? { t: zone.t, lo: zone.lo, hi: zone.hi } : null,
    entry: { price: entry, t: breakoutT },
    sl,
    target,
    target_zone: { lo: tLo, hi: tHi },
    height_atr: atrVal > 0 ? Number((height / atrVal).toFixed(2)) : null,
    rr,
    note,
    breakout_t: breakoutT,
    tone: dirn === "up" ? "bull" : "bear",
  };
}

const ln = (a: Pivot, b: Pivot, dash = false): PatternLine => ({
  t1: a.t, p1: a.price, t2: b.t, p2: b.price, dash,
});

/** first bar-time at/after pivot p.i whose close cleared the level —
 * the breakout candle (walk-forward: scans only bars after the trigger) */
function breakoutAfter(
  bars: Candle[], fromI: number, dir: "up" | "down", level: number, pad: number,
): number | undefined {
  for (let k = fromI; k < bars.length; k++) {
    if (dir === "up" && bars[k].c > level + pad) return bars[k].t;
    if (dir === "down" && bars[k].c < level - pad) return bars[k].t;
  }
  return undefined;
}

// ─────────────────── family 1: tops / bottoms / H&S (reversal) ───────────────────

function topsBottoms(bars: Candle[], pts: Pivot[], a: number): PatternDrawing | null {
  const n = bars.length;
  const closes = bars.map((b) => b.c);
  const lastClose = closes[n - 1];
  const highs = pts.filter((p) => p.kind === "high").slice(-4);
  const lows = pts.filter((p) => p.kind === "low").slice(-4);

  // ---------- tops family (double/triple/H&S — bearish reversals) --------
  if (highs.length >= 2 && highs[highs.length - 1].i >= n - RECENT_BARS) {
    // H&S first: 3 highs, middle clearly the tallest
    if (highs.length >= 3) {
      const [lsh, head, rsh] = highs.slice(-3);
      const headUp = head.price - Math.max(lsh.price, rsh.price);
      if (headUp > 0.45 * a && Math.abs(lsh.price - rsh.price) <= TOP_TOL * a) {
        const between = pts.filter((p) => p.kind === "low" && lsh.i < p.i && p.i < rsh.i);
        if (between.length) {
          const neckL = between[0];
          const neckR = between[between.length - 1];
          const neck = Math.min(neckL.price, neckR.price);
          const headH = head.price - neck;
          if (headH >= MIN_HEIGHT * a) {
            const conf = lastClose < neck - CONFIRM_PAD * a;
            const ptsSel = pts.filter((p) => lsh.i <= p.i && p.i <= rsh.i + MAX_POINTS_GAP);
            const lines = [
              ln(lsh, neckL), ln(neckL, head),
              ln(head, neckR), ln(neckR, rsh),
              ln(neckL, neckR, true),
            ];
            const entry = neck;
            const sl = Math.max(head.price, rsh.price) + 0.25 * a;
            const target = neck - headH;
            const breakoutT = conf ? breakoutAfter(bars, rsh.i, "down", neck, CONFIRM_PAD * a) : undefined;
            return mkPattern(
              "HEAD & SHOULDERS", "reversal", "down",
              ptsSel.length ? ptsSel : pts, lines,
              { lo: neck, hi: head.price, t: lsh.t },
              entry, sl, target, conf ? "confirmed" : "forming", a,
              `Head ${(headH / a).toFixed(1)}A above neckline — bearish reversal; target = head height below neckline`,
              breakoutT,
            );
          }
        }
      }
    }
    // triple top: 3 near-equal highs
    if (highs.length >= 3) {
      const [h1, h2, h3] = highs.slice(-3);
      const spread = Math.max(h1.price, h2.price, h3.price) - Math.min(h1.price, h2.price, h3.price);
      if (spread <= TOP_TOL * a) {
        const lown = pts.filter((p) => p.kind === "low" && h1.i < p.i && p.i < h3.i);
        if (lown.length) {
          const neck = Math.min(...lown.map((p) => p.price));
          const top = Math.max(h1.price, h2.price, h3.price);
          const height = top - neck;
          if (height >= MIN_HEIGHT * a) {
            const conf = lastClose < neck - CONFIRM_PAD * a;
            const ptsSel = pts.filter((p) => h1.i <= p.i && p.i <= h3.i + MAX_POINTS_GAP);
            const lines = [ln(h1, h2), ln(h2, h3), ln(lown[0], lown[lown.length - 1], true)];
            const entry = neck;
            const sl = top + 0.25 * a;
            const target = neck - height;
            const breakoutT = conf ? breakoutAfter(bars, h3.i, "down", neck, CONFIRM_PAD * a) : undefined;
            return mkPattern(
              "TRIPLE TOP", "reversal", "down",
              ptsSel.length ? ptsSel : pts, lines,
              { lo: neck, hi: top, t: h1.t },
              entry, sl, target, conf ? "confirmed" : "forming", a,
              "Three failed attacks on the same supply — bearish reversal; target = pattern height",
              breakoutT,
            );
          }
        }
      }
    }
    // double top
    const [h1, h2] = highs.slice(-2);
    if (Math.abs(h1.price - h2.price) <= TOP_TOL * a) {
      const lown = pts.filter((p) => p.kind === "low" && h1.i < p.i && p.i < h2.i);
      if (lown.length) {
        const neck = Math.min(...lown.map((p) => p.price));
        const top = Math.max(h1.price, h2.price);
        const height = top - neck;
        if (height >= MIN_HEIGHT * a) {
          const conf = lastClose < neck - CONFIRM_PAD * a;
          const ptsSel = pts.filter((p) => h1.i <= p.i && p.i <= h2.i + MAX_POINTS_GAP);
          const lines = [ln(h1, h2), ln(lown[0], lown[lown.length - 1], true)];
          const entry = neck;
          const sl = top + 0.25 * a;
          const target = neck - height;
          const breakoutT = conf ? breakoutAfter(bars, h2.i, "down", neck, CONFIRM_PAD * a) : undefined;
          return mkPattern(
            "DOUBLE TOP", "reversal", "down",
            ptsSel.length ? ptsSel : pts, lines,
            { lo: neck, hi: top, t: h1.t },
            entry, sl, target, conf ? "confirmed" : "forming", a,
            "Equal highs = liquidity above taken, then rejected — bearish reversal; target = pattern height",
            breakoutT,
          );
        }
      }
    }
  }

  // ---------- bottoms family (bullish reversals) ------------------------
  if (lows.length >= 2 && lows[lows.length - 1].i >= n - RECENT_BARS) {
    // inverse H&S: 3 lows, middle clearly the deepest
    if (lows.length >= 3) {
      const [lsh, head, rsh] = lows.slice(-3);
      const headDn = Math.min(lsh.price, rsh.price) - head.price;
      if (headDn > 0.45 * a && Math.abs(lsh.price - rsh.price) <= TOP_TOL * a) {
        const between = pts.filter((p) => p.kind === "high" && lsh.i < p.i && p.i < rsh.i);
        if (between.length) {
          const neckL = between[0];
          const neckR = between[between.length - 1];
          const neck = Math.max(neckL.price, neckR.price);
          const headH = neck - head.price;
          if (headH >= MIN_HEIGHT * a) {
            const conf = lastClose > neck + CONFIRM_PAD * a;
            const ptsSel = pts.filter((p) => lsh.i <= p.i && p.i <= rsh.i + MAX_POINTS_GAP);
            const lines = [
              ln(lsh, neckL), ln(neckL, head),
              ln(head, neckR), ln(neckR, rsh),
              ln(neckL, neckR, true),
            ];
            const entry = neck;
            const sl = Math.min(head.price, rsh.price) - 0.25 * a;
            const target = neck + headH;
            const breakoutT = conf ? breakoutAfter(bars, rsh.i, "up", neck, CONFIRM_PAD * a) : undefined;
            return mkPattern(
              "INVERSE HEAD & SHOULDERS", "reversal", "up",
              ptsSel.length ? ptsSel : pts, lines,
              { lo: head.price, hi: neck, t: lsh.t },
              entry, sl, target, conf ? "confirmed" : "forming", a,
              `Head ${(headH / a).toFixed(1)}A below neckline — bullish reversal; target = head height above neckline`,
              breakoutT,
            );
          }
        }
      }
    }
    // triple bottom
    if (lows.length >= 3) {
      const [l1, l2, l3] = lows.slice(-3);
      const bot = Math.min(l1.price, l2.price, l3.price);
      const spread = Math.max(l1.price, l2.price, l3.price) - bot;
      if (spread <= TOP_TOL * a) {
        const highsB = pts.filter((p) => p.kind === "high" && l1.i < p.i && p.i < l3.i);
        if (highsB.length) {
          const neck = Math.max(...highsB.map((p) => p.price));
          const height = neck - bot;
          if (height >= MIN_HEIGHT * a) {
            const conf = lastClose > neck + CONFIRM_PAD * a;
            const ptsSel = pts.filter((p) => l1.i <= p.i && p.i <= l3.i + MAX_POINTS_GAP);
            const lines = [
              ln(l1, l2), ln(l2, l3),
              ln(highsB[0], highsB[highsB.length - 1], true),
            ];
            const entry = neck;
            const sl = bot - 0.25 * a;
            const target = neck + height;
            const breakoutT = conf ? breakoutAfter(bars, l3.i, "up", neck, CONFIRM_PAD * a) : undefined;
            return mkPattern(
              "TRIPLE BOTTOM", "reversal", "up",
              ptsSel.length ? ptsSel : pts, lines,
              { lo: bot, hi: neck, t: l1.t },
              entry, sl, target, conf ? "confirmed" : "forming", a,
              "Three failed attacks on the same demand — bullish reversal; target = pattern height",
              breakoutT,
            );
          }
        }
      }
    }
    // double bottom
    const [l1, l2] = lows.slice(-2);
    if (Math.abs(l1.price - l2.price) <= TOP_TOL * a) {
      const highsB = pts.filter((p) => p.kind === "high" && l1.i < p.i && p.i < l2.i);
      if (highsB.length) {
        const neck = Math.max(...highsB.map((p) => p.price));
        const bot = Math.min(l1.price, l2.price);
        const height = neck - bot;
        if (height >= MIN_HEIGHT * a) {
          const conf = lastClose > neck + CONFIRM_PAD * a;
          const ptsSel = pts.filter((p) => l1.i <= p.i && p.i <= l2.i + MAX_POINTS_GAP);
          const lines = [ln(l1, l2), ln(highsB[0], highsB[highsB.length - 1], true)];
          const entry = neck;
          const sl = bot - 0.25 * a;
          const target = neck + height;
          const breakoutT = conf ? breakoutAfter(bars, l2.i, "up", neck, CONFIRM_PAD * a) : undefined;
          return mkPattern(
            "DOUBLE BOTTOM", "reversal", "up",
            ptsSel.length ? ptsSel : pts, lines,
            { lo: bot, hi: neck, t: l1.t },
            entry, sl, target, conf ? "confirmed" : "forming", a,
            "Equal lows = liquidity below taken, then rejected — bullish reversal; target = pattern height",
            breakoutT,
          );
        }
      }
    }
  }
  return null;
}

// ─────────────── family 2: flags / pennants (continuation) ───────────────

function flags(bars: Candle[], pts: Pivot[], a: number): PatternDrawing | null {
  const n = bars.length;
  const lastClose = bars[n - 1].c;
  if (pts.length < 4) return null;
  const lastP = pts[pts.length - 1];
  if (lastP.i < n - RECENT_BARS) return null;

  // the most recent STRONG impulse leg = the pole (≤18 bars, ≥1.8 ATR).
  // v16.6 guard: a qualifying leg only counts as THE pole when a real
  // consolidation (its own fractal high AND low) sits after its tip —
  // otherwise it's just a bounce inside a larger pole's flag and the
  // walk-back continues to the true impulse.
  let pole: { a: Pivot; b: Pivot; dir: "up" | "down" } | null = null;
  for (let k = pts.length - 1; k > 0; k--) {
    const pa = pts[k - 1];
    const pb = pts[k];
    let move: number | null = null;
    if (pa.kind === "low" && pb.kind === "high") move = pb.price - pa.price;
    else if (pa.kind === "high" && pb.kind === "low") move = pa.price - pb.price;
    if (move == null) continue;
    const barsGap = pb.i - pa.i;
    if (move / a >= POLE_MIN && barsGap >= 2 && barsGap <= 18) {
      const after = pts.filter((p) => p.i > pb.i);
      const hasHigh = after.some((p) => p.kind === "high");
      const hasLow = after.some((p) => p.kind === "low");
      if (!hasHigh || !hasLow) continue; // not a pole+flag yet — keep walking
      pole = { a: pa, b: pb, dir: pb.kind === "high" ? "up" : "down" };
      break;
    }
  }
  if (!pole) return null;
  const { a: pa, b: pb, dir: poleDir } = pole;

  // consolidation pivots after the pole tip
  const cons = pts.filter((p) => p.i > pb.i);
  const consHighs = cons.filter((p) => p.kind === "high");
  const consLows = cons.filter((p) => p.kind === "low");
  if (!consHighs.length || !consLows.length) return null;
  const hiC = Math.max(...consHighs.map((p) => p.price));
  const loC = Math.min(...consLows.map((p) => p.price));

  // converging = pennant (both sides squeeze), else flag
  const converging =
    consHighs.length >= 2 && consLows.length >= 2 &&
    consHighs[consHighs.length - 1].price < consHighs[0].price - 0.1 * a &&
    consLows[consLows.length - 1].price > consLows[0].price + 0.1 * a;

  if (poleDir === "up") {
    const retr = pb.price !== pa.price ? (pb.price - loC) / (pb.price - pa.price) : 1;
    const entry = hiC;
    const sl = loC - 0.2 * a;
    const target = pb.price + (pb.price - pa.price);
    const conf = lastClose > entry + CONFIRM_PAD * a;
    const ptsSel = [pa, pb, ...cons];
    const lines = [ln(pa, pb), ln(cons[0], cons[cons.length - 1])];
    const breakoutT = conf ? breakoutAfter(bars, cons[cons.length - 1].i, "up", entry, CONFIRM_PAD * a) : undefined;
    const note = retr <= FLAG_MAXRETR
      ? `Pole ${(retr * 100).toFixed(0)}% held — continuation up; target = pole height above the flag`
      : "Flag retraced too deep — weak continuation";
    return mkPattern(
      converging ? "BULL PENNANT" : "BULL FLAG", "continuation", "up",
      ptsSel, lines, { lo: loC, hi: hiC, t: cons[0].t },
      entry, sl, target, conf ? "confirmed" : "forming", a, note, breakoutT,
    );
  }

  // bear flag: pole down, consolidation up
  const retr = pa.price !== pb.price ? (hiC - pb.price) / (pa.price - pb.price) : 1;
  const entry = loC;
  const sl = hiC + 0.2 * a;
  const target = pb.price - (pa.price - pb.price);
  const conf = lastClose < entry - CONFIRM_PAD * a;
  const ptsSel = [pa, pb, ...cons];
  const lines = [ln(pa, pb), ln(cons[0], cons[cons.length - 1])];
  const breakoutT = conf ? breakoutAfter(bars, cons[cons.length - 1].i, "down", entry, CONFIRM_PAD * a) : undefined;
  const note = retr <= FLAG_MAXRETR
    ? `Pole ${(retr * 100).toFixed(0)}% held — continuation down; target = pole height below the flag`
    : "Flag retraced too deep — weak continuation";
  return mkPattern(
    converging ? "BEAR PENNANT" : "BEAR FLAG", "continuation", "down",
    ptsSel, lines, { lo: loC, hi: hiC, t: cons[0].t },
    entry, sl, target, conf ? "confirmed" : "forming", a, note, breakoutT,
  );
}

// ───────────── family 3: triangle / wedge / rectangle (boundary) ─────────────

function triangleWedgeRect(bars: Candle[], pts: Pivot[], a: number): PatternDrawing | null {
  const n = bars.length;
  const lastClose = bars[n - 1].c;
  const highs = pts.filter((p) => p.kind === "high").slice(-2);
  const lows = pts.filter((p) => p.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (highs[1].i < n - 45 || lows[1].i < n - 45) return null;
  const [h1, h2] = highs;
  const [l1, l2] = lows;
  const four = [h1, h2, l1, l2].sort((x, y) => x.i - y.i);
  if (four[3].i - four[0].i < 6) return null;

  const hh = Math.abs(h2.price - h1.price);
  const ll = Math.abs(l2.price - l1.price);
  const flatH = hh <= TOL_FLAT * a;
  const flatL = ll <= TOL_FLAT * a;
  const zoneLo = Math.min(l1.price, l2.price);
  const zoneHi = Math.max(h1.price, h2.price);
  const hiSpan = zoneHi - zoneLo;
  if (hiSpan < MIN_HEIGHT * a || hiSpan > MAX_HEIGHT * a) return null;

  const upH = h2.price > h1.price;
  const upL = l2.price > l1.price;

  const emit = (
    name: string, dirn: "up" | "down", entry: number, sl: number, target: number,
    note: string,
  ): PatternDrawing => {
    const lines = [ln(h1, h2), ln(l1, l2)];
    const conf = dirn === "up"
      ? lastClose > entry + CONFIRM_PAD * a
      : lastClose < entry - CONFIRM_PAD * a;
    const trigI = dirn === "up" ? h2.i : l2.i;
    const breakoutT = conf ? breakoutAfter(bars, trigI, dirn, entry, CONFIRM_PAD * a) : undefined;
    return mkPattern(
      name, "boundary", dirn, four, lines,
      { lo: zoneLo, hi: zoneHi, t: four[0].t },
      entry, sl, target, conf ? "confirmed" : "forming", a, note, breakoutT,
    );
  };

  // RECTANGLE: both sides flat — trade the breakout
  if (flatH && flatL) {
    const mid = (h2.price + l2.price) / 2;
    const dirn: "up" | "down" = lastClose > mid ? "up" : "down";
    const entry = dirn === "up" ? h2.price : l2.price;
    const sl = dirn === "up" ? l2.price - 0.2 * a : h2.price + 0.2 * a;
    const target = dirn === "up" ? h2.price + (h2.price - l2.price) : l2.price - (h2.price - l2.price);
    return emit(
      dirn === "up" ? "BULL RECTANGLE" : "BEAR RECTANGLE",
      dirn, entry, sl, target,
      "Balanced range — trade the breakout; target = range height",
    );
  }

  // ASCENDING TRIANGLE: flat highs, rising lows → bullish breakout
  if (flatH && upL && !flatL) {
    const entry = h2.price;
    const sl = l2.price - 0.2 * a;
    const target = h2.price + (h2.price - Math.min(l1.price, l2.price));
    return emit(
      "ASCENDING TRIANGLE", "up", entry, sl, target,
      "Rising lows press the flat supply — bullish breakout; target = base height",
    );
  }

  // DESCENDING TRIANGLE: flat lows, falling highs → bearish breakout
  if (flatL && !upH && !flatH) {
    const entry = l2.price;
    const sl = h2.price + 0.2 * a;
    const target = l2.price - (Math.max(h1.price, h2.price) - l2.price);
    return emit(
      "DESCENDING TRIANGLE", "down", entry, sl, target,
      "Falling highs press the flat demand — bearish breakout; target = base height",
    );
  }

  // SYMMETRIC TRIANGLE: both converge (opposite slopes)
  if (!flatH && !flatL && upH !== upL) {
    const dirn: "up" | "down" = lastClose > (h2.price + l2.price) / 2 ? "up" : "down";
    const entry = dirn === "up" ? h2.price : l2.price;
    const sl = dirn === "up" ? l2.price - 0.2 * a : h2.price + 0.2 * a;
    const target = dirn === "up" ? entry + hiSpan : entry - hiSpan;
    return emit(
      "SYMMETRIC TRIANGLE", dirn, entry, sl, target,
      "Coiling into the apex — breakout resolves the coil; target = base height",
    );
  }

  // RISING WEDGE: both up, converging → bearish resolution
  if (upH && upL && hh < hiSpan * 0.5) {
    const entry = l2.price;
    const sl = h2.price + 0.2 * a;
    const target = l2.price - hiSpan * 0.7;
    return emit(
      "RISING WEDGE", "down", entry, sl, target,
      "Climb decelerating into convergence — bearish resolution",
    );
  }
  // FALLING WEDGE: both down, converging → bullish resolution
  if (!upH && !upL && ll < hiSpan * 0.5) {
    const entry = h2.price;
    const sl = l2.price - 0.2 * a;
    const target = h2.price + hiSpan * 0.7;
    return emit(
      "FALLING WEDGE", "up", entry, sl, target,
      "Slide decelerating into convergence — bullish resolution",
    );
  }
  return null;
}

// ──────────────────────────── orchestrator ────────────────────────────

/**
 * Best classic patterns on the closed window. v18.0 (user reference
 * images — "মাল্টিপল সেটাপ"): returns up to THREE patterns, best-first —
 * the reference cheat-sheet shows several concurrent setups (a boundary
 * coil AND a reversal AND a continuation can all be live at once), so the
 * chart no longer stops at two. Priority: reversal family beats the flag,
 * flag beats the boundary family (the reference channel's teaching order).
 */
export function detectPatterns(bars: Candle[]): PatternDrawing[] {
  try {
    if (bars.length < 24) return [];
    const a = last(atr(bars)) ?? 0;
    if (!a || a <= 0) return [];
    const pts = pivots(bars);
    if (pts.length < MIN_SWINGS) return [];
    const cands: PatternDrawing[] = [];
    for (const fn of [topsBottoms, flags, triangleWedgeRect]) {
      try {
        const r = fn(bars, pts, a);
        if (r) cands.push(r);
      } catch {
        // one family failing must not kill the others (ref contract)
      }
    }
    // de-dup by name; prefer confirmed, then bigger height
    cands.sort((x, y) =>
      (x.state !== "confirmed" ? 1 : 0) - (y.state !== "confirmed" ? 1 : 0) ||
      (y.height_atr ?? 0) - (x.height_atr ?? 0),
    );
    const seen = new Set<string>();
    const out: PatternDrawing[] = [];
    for (const c of cands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
    return out.slice(0, 3);
  } catch {
    // patterns must never break /api/analysis (ref contract)
    return [];
  }
}

// ────────────────────── channel (asc/desc, from the ref drawings.py) ──────────────────────

export interface ChannelDrawing {
  kind: "channel";
  dir: "up" | "down";
  label: string;
  tone: "bull" | "bear";
  upper: { t1: number; p1: number; t2: number; p2: number };
  lower: { t1: number; p1: number; t2: number; p2: number };
  median: { t1: number; p1: number; t2: number; p2: number };
  source_tf?: string;
}

/**
 * Ascending/descending channel from the last TWO swing highs and TWO
 * swing lows (k=3 fractals — the bigger structure): upper + lower
 * parallels + the dashed median. Only prints when both sides agree on
 * the slope — a true channel the market walks between.
 */
export function detectChannel(bars: Candle[]): ChannelDrawing | null {
  if (bars.length < 40) return null;
  const pts = swings(bars.slice(-160), 3, 3);
  const highs = pts.filter((s) => s.kind === "high").slice(-2);
  const lows = pts.filter((s) => s.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs;
  const [l1, l2] = lows;
  const upSlope = h2.price > h1.price && l2.price > l1.price;
  const downSlope = h2.price < h1.price && l2.price < l1.price;
  if (!upSlope && !downSlope) return null;
  const m1 = (h1.price + l1.price) / 2;
  const m2 = (h2.price + l2.price) / 2;
  return {
    kind: "channel",
    dir: upSlope ? "up" : "down",
    label: upSlope ? "Ascending Channel" : "Descending Channel",
    tone: upSlope ? "bull" : "bear",
    upper: { t1: h1.t, p1: h1.price, t2: h2.t, p2: h2.price },
    lower: { t1: l1.t, p1: l1.price, t2: l2.t, p2: l2.price },
    median: { t1: h1.t, p1: m1, t2: h2.t, p2: m2 },
  };
}

// ──────────────── v18.0: candlestick patterns (the boxed setups) ────────────────
//
// The user's reference screenshots (mastering-bullish-candlestick-patterns +
// the highlighted USCRUDE chart) box the EXACT pattern candles in a thin
// outlined rectangle with a name tag — Hammer / Bullish Harami / Engulfing
// highlighted at the swings that matter. This detector finds the textbook
// 1–3 bar reversals AT REAL EXTREMES ONLY (a hammer mid-range is noise):
// the pattern must sit after a ≥0.8 ATR approach leg into it, so every box
// on the chart is a decision candle, not decoration.

export interface CandlePatternDrawing {
  kind: "candle";
  name: string;
  side: "bull" | "bear";
  t0: number;
  t1: number;
  lo: number;
  hi: number;
}

const body = (b: Candle) => Math.abs(b.c - b.o);
const range = (b: Candle) => Math.max(1e-9, b.h - b.l);
const upperWick = (b: Candle) => b.h - Math.max(b.o, b.c);
const lowerWick = (b: Candle) => Math.min(b.o, b.c) - b.l;

/**
 * Classic candlestick reversals, boxed. Returns the most significant
 * `max` (default 2) non-overlapping patterns from the last 60 CLOSED
 * bars, newest first — the renderer draws the thin highlight rectangle.
 */
export function detectCandles(bars: Candle[], max = 2): CandlePatternDrawing[] {
  try {
    const closed = bars.filter((b) => !b.f);
    if (closed.length < 25) return [];
    const a = last(atr(closed.slice(-90))) ?? 0;
    if (!a || a <= 0) return [];
    const win = closed.slice(-60);
    const out: CandlePatternDrawing[] = [];
    const spans: { i0: number; i1: number }[] = [];
    const overlaps = (i0: number, i1: number) =>
      spans.some((s) => i0 <= s.i1 && i1 >= s.i0);

    for (let k = win.length - 1; k >= 3 && out.length < max; k--) {
      const b = win[k];          // the pattern's last bar
      const p1 = win[k - 1];     // middle / previous bar
      const p2 = win[k - 2];     // first bar (3-bar patterns)
      // context: the approach leg INTO the pattern (7 bars before it)
      const ctxFrom = win[Math.max(0, k - 9)];
      let found: CandlePatternDrawing | null = null;

      const box = (i0: number, i1: number, name: string, side: "bull" | "bear"): CandlePatternDrawing => {
        const seg = win.slice(i0, i1 + 1);
        return {
          kind: "candle", name, side,
          t0: seg[0].t, t1: seg[seg.length - 1].t,
          lo: Math.min(...seg.map((x) => x.l)),
          hi: Math.max(...seg.map((x) => x.h)),
        };
      };

      // ── HAMMER (bull) / SHOOTING STAR (bear): one decisive candle ──
      if (range(b) >= 0.7 * a) {
        const hammer = lowerWick(b) >= 1.8 * body(b) && upperWick(b) <= 0.6 * body(b) + 0.12 * a;
        const star = upperWick(b) >= 1.8 * body(b) && lowerWick(b) <= 0.6 * body(b) + 0.12 * a;
        if (hammer && b.c < ctxFrom.c) {
          // a hammer after a DROP (approach leg down) — demand rejection
          found = box(k, k, "HAMMER", "bull");
        } else if (star && b.c > ctxFrom.c) {
          // a shooting star after a RISE — supply rejection
          found = box(k, k, "SHOOTING STAR", "bear");
        }
      }

      // ── ENGULFING (2 bars): the second body swallows the first ──
      if (!found && range(b) >= 0.6 * a) {
        const bullEng =
          p1.c < p1.o && b.c > b.o &&
          b.c >= Math.max(p1.o, p1.c) && b.o <= Math.min(p1.o, p1.c) &&
          body(b) >= 1.0 * body(p1) &&
          b.c < ctxFrom.c; // after a drop
        const bearEng =
          p1.c > p1.o && b.c < b.o &&
          b.o >= Math.max(p1.o, p1.c) && b.c <= Math.min(p1.o, p1.c) &&
          body(b) >= 1.0 * body(p1) &&
          b.c > ctxFrom.c; // after a rise
        if (bullEng) found = box(k - 1, k, "BULL ENGULF", "bull");
        else if (bearEng) found = box(k - 1, k, "BEAR ENGULF", "bear");
      }

      // ── MORNING / EVENING STAR (3 bars): exhaustion → stall → reversal ──
      if (!found && body(b) >= 0.8 * a && body(p2) >= 0.8 * a) {
        const stall = body(p1) <= 0.35 * a;
        const morning =
          p2.c < p2.o && b.c > b.o && stall &&
          b.c >= (p2.o + p2.c) / 2 && b.c < ctxFrom.c;
        const evening =
          p2.c > p2.o && b.c < b.o && stall &&
          b.c <= (p2.o + p2.c) / 2 && b.c > ctxFrom.c;
        if (morning) found = box(k - 2, k, "MORNING STAR", "bull");
        else if (evening) found = box(k - 2, k, "EVENING STAR", "bear");
      }

      if (found && !overlaps(k - 2, k)) {
        out.push(found);
        spans.push({ i0: k - 2, i1: k });
      }
    }
    return out;
  } catch {
    return []; // candle ink must never break /api/analysis
  }
}
