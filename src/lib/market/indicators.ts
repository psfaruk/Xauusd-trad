/**
 * Indicator formulas — exact port of the reference engine's pandas logic,
 * rewritten as plain array passes (closed bars only, no lookahead).
 */

import type { Candle } from "./types";

export function ema(values: number[], n: number): (number | null)[] {
  if (values.length < n) return values.map(() => null);
  const k = 2 / (n + 1);
  const out: (number | null)[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i];
  prev /= n;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (i === n - 1) { out.push(prev); continue; }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function last<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return arr[i];
  return null;
}

/** True range series. */
export function trueRange(bars: Candle[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** Wilder ATR (alpha = 1/n). */
export function atr(bars: Candle[], n = 14): (number | null)[] {
  const tr = trueRange(bars);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < n) return out;
  let prev = 0;
  for (let i = 0; i < n; i++) prev += tr[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(bars: Candle[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= n; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d >= 0) avgG += d; else avgL -= d;
  }
  avgG /= n; avgL /= n;
  const val = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[n] = val(avgG, avgL);
  for (let i = n + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
    out[i] = val(avgG, avgL);
  }
  return out;
}

export function macd(bars: Candle[], fast = 12, slow = 26, signal = 9) {
  const closes = bars.map((b) => b.c);
  const eFast = ema(closes, fast);
  const eSlow = ema(closes, slow);
  const line: number[] = bars.map((_, i) =>
    eFast[i] != null && eSlow[i] != null ? (eFast[i] as number) - (eSlow[i] as number) : NaN,
  );
  const valid = line.map((v) => (Number.isFinite(v) ? v : 0));
  const sig = ema(valid, signal);
  const hist = line.map((v, i) => (Number.isFinite(v) && sig[i] != null ? v - (sig[i] as number) : NaN));
  return { line, signal: sig, hist };
}

export function stochastic(bars: Candle[], kN = 14, kSmooth = 3, dSmooth = 3) {
  const raw: number[] = bars.map((b, i) => {
    const from = Math.max(0, i - kN + 1);
    let hi = -Infinity, lo = Infinity;
    for (let j = from; j <= i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    return hi === lo ? 50 : ((b.c - lo) / (hi - lo)) * 100;
  });
  const k = sma(raw, kSmooth);
  const kValid = k.map((v) => (v == null ? 50 : v));
  const d = sma(kValid, dSmooth);
  return { k, d };
}

export function bollinger(bars: Candle[], n = 20, mult = 2) {
  const closes = bars.map((b) => b.c);
  const mid = sma(closes, n);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    const from = i - n + 1;
    let sq = 0;
    const m = mid[i] as number;
    for (let j = from; j <= i; j++) sq += (closes[j] - m) ** 2;
    const sd = Math.sqrt(sq / n);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  const width = upper.map((u, i) => (u != null && lower[i] != null ? (u - (lower[i] as number)) / (mid[i] as number) : null));
  const pctB = bars.map((b, i) =>
    upper[i] != null && lower[i] != null && upper[i]! !== lower[i]!
      ? (b.c - (lower[i] as number)) / ((upper[i] as number) - (lower[i] as number))
      : null,
  );
  return { upper, mid, lower, width, pctB };
}

/** Kaufman efficiency ratio (net / path) over window. */
export function efficiencyRatio(bars: Candle[], n = 20): number {
  if (bars.length < n + 1) return 0;
  const from = bars.length - 1 - n;
  const net = Math.abs(bars[bars.length - 1].c - bars[from].c);
  let path = 0;
  for (let i = from + 1; i < bars.length; i++) path += Math.abs(bars[i].c - bars[i - 1].c);
  return path === 0 ? 0 : net / path;
}

/** ADX (Wilder). */
export function adx(bars: Candle[], n = 14): number {
  if (bars.length < n * 2 + 1) return 0;
  const tr = trueRange(bars);
  const plusDM: number[] = [0], minusDM: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const smooth = (arr: number[]) => {
    let s = 0;
    const out: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < n) { s += arr[i]; out.push(i === n - 1 ? s : NaN); continue; }
      s = s - s / n + arr[i];
      out.push(s);
    }
    return out;
  };
  const sTR = smooth(tr), sP = smooth(plusDM), sM = smooth(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (!Number.isFinite(sTR[i]) || sTR[i] === 0) { dx.push(NaN); continue; }
    const pdi = (100 * sP[i]) / sTR[i];
    const mdi = (100 * sM[i]) / sTR[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }
  // Wilder-smooth the last n DX values
  const valid = dx.filter((v) => Number.isFinite(v));
  if (valid.length < n) return 0;
  let a = 0;
  for (let i = valid.length - n; i < valid.length; i++) a += valid[i];
  a /= n;
  for (let i = valid.length - n + 1; i < valid.length; i++) a = (a * (n - 1) + valid[i]) / n;
  return a;
}

/** Rolling volume z-score vs trailing window. */
export function volZ(bars: Candle[], n = 60): number {
  if (bars.length < n + 1) return 0;
  const vols = bars.slice(-n - 1, -1).map((b) => b.v);
  const cur = bars[bars.length - 1].v;
  const mean = vols.reduce((a, b) => a + b, 0) / n;
  const varr = vols.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(varr);
  return sd === 0 ? 0 : (cur - mean) / sd;
}

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
  t: number;
}

/**
 * Fractal swing pivots — bar k is a swing high when its high ≥ the highs of
 * `left` bars before and `right` bars after (confirmed right bars later,
 * no lookahead). Equal-price adjacent duplicates collapse.
 */
export function swings(bars: Candle[], left = 2, right = 2): Swing[] {
  const out: Swing[] = [];
  for (let k = left; k < bars.length - right; k++) {
    let isHigh = true, isLow = true;
    for (let j = k - left; j <= k + right; j++) {
      if (j === k) continue;
      if (bars[j].h > bars[k].h) isHigh = false;
      if (bars[j].l < bars[k].l) isLow = false;
    }
    if (isHigh) out.push({ index: k, price: bars[k].h, kind: "high", t: bars[k].t });
    if (isLow) out.push({ index: k, price: bars[k].l, kind: "low", t: bars[k].t });
  }
  // dedupe: same kind, adjacent index (≤1 apart), equal price → keep first
  const dedup: Swing[] = [];
  for (const s of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.kind === s.kind && s.index - prev.index <= 1 && Math.abs(s.price - prev.price) < 1e-9) continue;
    dedup.push(s);
  }
  return dedup;
}

/** Session name from UTC hour — tokyo 0-7, london 7-16, newyork 13-20. */
export function sessionOf(tsSec: number): "tokyo" | "london" | "newyork" | "off" {
  const h = new Date(tsSec * 1000).getUTCHours();
  if (h < 7) return "tokyo";
  if (h < 13) return "london";
  if (h < 20) return "newyork";
  return "off";
}
