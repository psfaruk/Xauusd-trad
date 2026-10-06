/**
 * demo.ts — DEMO DATA MODE (v20.0)
 *
 * The terminal must be explorable BEFORE an MT5 account is connected (a
 * fresh deployment, or a sandbox restart that wiped the stored credentials).
 * When no credentials exist, the manager serves a clearly-labelled synthetic
 * feed instead of a dead "disconnected" screen:
 *
 *   · ONE deterministic master price path per symbol (M5 buckets, 90 days)
 *     built from a seeded PRNG with regime drift + volatility clustering +
 *     session rhythm — every reload generates the SAME chart.
 *   · Higher TFs (M15…D1) are pure aggregations of that path, so the MTF
 *     story (H1 S/R vs M15 structure) stays coherent across timeframes.
 *   · M1 is a 24h sub-path carved INSIDE the last M5 bars (chained opens,
 *     closes pinned to the parent, highs/lows inside the parent envelope).
 *   · A live tick loop walks a small mean-reverting deviation around the
 *     deterministic anchor, injected through the manager's NORMAL quote
 *     path — quotes, forming bars, bar open/close events, order-flow
 *     trackers and the analysis fan-out all work unchanged.
 *   · HONESTY: source stays "demo", the account block stays null (no fake
 *     balance), trading stays impossible (the trader gates on source==="mt5"),
 *     and demo ticks are NEVER recorded into the real-tick archive.
 */

import type { Bar } from "./manager";

// ── per-symbol demo profile ────────────────────────────────────────────────
interface DemoSym {
  base: number;      // anchor price at the oldest generated bar
  digits: number;    // quote precision
  dayVolPct: number; // daily volatility % (1.0 = 1%)
  spreadBp: number;  // spread in basis points of price (3bp on 4000 gold ≈ 0.12)
}

const SYMS: Record<string, DemoSym> = {
  XAUUSDm:    { base: 4015, digits: 2, dayVolPct: 0.95, spreadBp: 3.0 },
  XAUUSD247m: { base: 4015, digits: 2, dayVolPct: 0.95, spreadBp: 3.4 },
  XAGUSDm:    { base: 51.4, digits: 3, dayVolPct: 1.7, spreadBp: 4.5 },
  USOILm:     { base: 63.8, digits: 2, dayVolPct: 1.9, spreadBp: 4.0 },
  UKOILm:     { base: 68.2, digits: 2, dayVolPct: 1.8, spreadBp: 4.5 },
  USTECm:     { base: 21450, digits: 1, dayVolPct: 1.1, spreadBp: 2.5 },
  USTEC_x100m:{ base: 214.5, digits: 2, dayVolPct: 1.1, spreadBp: 3.5 },
  US500m:     { base: 5920, digits: 1, dayVolPct: 0.85, spreadBp: 2.5 },
  US500_x100m:{ base: 59.20, digits: 2, dayVolPct: 0.85, spreadBp: 3.5 },
  BTCUSDm:    { base: 94800, digits: 2, dayVolPct: 2.9, spreadBp: 2.0 },
  ETHUSDm:    { base: 3240, digits: 2, dayVolPct: 3.3, spreadBp: 2.2 },
  SOLUSDm:    { base: 182, digits: 2, dayVolPct: 4.2, spreadBp: 3.0 },
  EURUSDm:    { base: 1.0915, digits: 5, dayVolPct: 0.38, spreadBp: 1.0 },
  GBPUSDm:    { base: 1.2712, digits: 5, dayVolPct: 0.42, spreadBp: 1.2 },
  USDJPYm:    { base: 154.85, digits: 3, dayVolPct: 0.40, spreadBp: 1.2 },
  AUDUSDm:    { base: 0.6562, digits: 5, dayVolPct: 0.46, spreadBp: 1.4 },
  USDCADm:    { base: 1.3988, digits: 5, dayVolPct: 0.34, spreadBp: 1.6 },
  USDCHFm:    { base: 0.8018, digits: 5, dayVolPct: 0.36, spreadBp: 1.6 },
  NZDUSDm:    { base: 0.6012, digits: 5, dayVolPct: 0.50, spreadBp: 1.8 },
  EURJPYm:    { base: 168.95, digits: 3, dayVolPct: 0.44, spreadBp: 1.6 },
  GBPJPYm:    { base: 196.75, digits: 3, dayVolPct: 0.55, spreadBp: 2.2 },
  EURGBPm:    { base: 0.8588, digits: 5, dayVolPct: 0.28, spreadBp: 1.4 },
};

const M5 = 300;
const PATH_DAYS = 90;               // master path window
const PATH_BARS = PATH_DAYS * 288;  // M5 bars in the window
const M1_LOOKBACK = 24 * 60;        // M1 sub-path depth (chart loads ≤900)

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/** mulberry32 — tiny, fast, seedable PRNG */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** standard-normal via Box–Muller on a seeded uniform stream */
function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** UTC hour → relative session activity (Asia calm, London/NY loud) */
function sessionMul(hourUtc: number): number {
  if (hourUtc >= 7 && hourUtc < 10) return 1.28;   // London open
  if (hourUtc >= 13 && hourUtc < 17) return 1.32;  // NY
  if (hourUtc >= 17 && hourUtc < 21) return 1.05;  // NY pm overlap fade
  if (hourUtc >= 0 && hourUtc < 7) return 0.72;    // Asia
  return 0.85;
}

/** one M5 bar of the master path, deterministically from (symbol, index) */
function masterBar(idx: number, open: number, symSeed: number, dayVol: number): Bar {
  // regime block = 4h → drift & vol multiplier persist within a block
  const block = Math.floor(idx / 48);
  const rb = rng(symSeed ^ Math.imul(block, 2654435761));
  const drift = (rb() * 2 - 1) * 0.55;          // −0.55..0.55 σ per bar
  const volMul = 0.55 + rb() * 1.25;             // 0.55..1.8
  // per-bar randomness
  const r = rng(symSeed ^ Math.imul(idx, 40503) ^ 0x9e3779b9);
  // σ per M5 bar from daily vol (288 M5 bars/day), session-scaled
  const barSig = (dayVol / 100) / Math.sqrt(288) * volMul;
  const dt = new Date(idx * M5 * 1000);
  const sig = barSig * sessionMul(dt.getUTCHours());
  const ret = drift * barSig * 0.35 + gauss(r) * sig;
  const close = open * (1 + ret);
  // intrabar extremes from two further draws, kept inside a sane envelope
  const wickUp = Math.abs(gauss(r)) * sig * 0.7;
  const wickDn = Math.abs(gauss(r)) * sig * 0.7;
  const high = Math.max(open, close) * (1 + wickUp * 0.55);
  const low = Math.min(open, close) * (1 - wickDn * 0.55);
  const vBase = 60 + Math.abs(ret) / Math.max(1e-9, barSig) * 140; // vol ∝ |move|
  const vol = Math.round(vBase * (0.6 + r() * 0.8) * sessionMul(dt.getUTCHours()));
  return { t: 0, o: open, h: high, l: Math.max(low, Math.min(open, close) * 0.999), c: close, v: Math.max(5, vol) };
}

/** the per-symbol master path (lazily built, kept for the process life) */
interface SymbolPath {
  bars: Bar[];        // CLOSED M5 bars, oldest→newest (last may be the forming bucket once ticked forward)
  symSeed: number;
  dayVol: number;
  base: number;
  builtAt: number;    // epoch ms — the path may need extending as time passes
}

export class DemoFeed {
  private paths = new Map<string, SymbolPath>();
  /** live deviation state per symbol: mid walks around the anchor */
  private live = new Map<string, { mid: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** injected by the manager: the normal quote path (bid/ask → ticks, bars, flow) */
  injectQuote: ((symbol: string, digits: number, bid: number, ask: number) => void) | null = null;

  constructor(
    private now: () => number,                       // epoch seconds
    private getSubscribedTfs: (symbol: string) => string[],
  ) {}

  get isRunning() { return this.running; }

  symbolNames(): string[] { return Object.keys(SYMS); }
  symbolDigits(name: string): number { return SYMS[name]?.digits ?? 2; }
  hasSymbol(name: string): boolean { return name in SYMS; }

  // ═══════════════ master path ═══════════════

  private pathFor(symbol: string): SymbolPath {
    let p = this.paths.get(symbol);
    const profile = SYMS[symbol] ?? { base: 100, digits: 2, dayVolPct: 1, spreadBp: 2 };
    if (!p) {
      p = {
        bars: [],
        symSeed: hashStr(symbol) || 1,
        dayVol: profile.dayVolPct / 100,
        base: profile.base,
        builtAt: 0,
      };
      this.paths.set(symbol, p);
    }
    // (re)build / extend so the path covers [now − PATH_BARS, now] closed buckets
    const lastIdx = Math.floor(this.now() / M5) - 1; // last CLOSED bucket index
    const from = lastIdx - PATH_BARS + 1;
    if (!p.bars.length || p.builtAt < (lastIdx - 1) * M5 * 1000) {
      // append-only extension: generation is fully deterministic (same seeds
      // → same bars), so continuing from the existing chain never seams
      const bars: Bar[] = [];
      let open = p.bars.length
        ? p.bars[p.bars.length - 1].c
        : profile.base;
      const startIdx = p.bars.length ? Math.floor(p.bars[p.bars.length - 1].t / M5) + 1 : from;
      for (let i = startIdx; i <= lastIdx; i++) {
        const b = masterBar(i, open, p.symSeed, p.dayVol);
        b.t = i * M5;
        bars.push(b);
        open = b.c;
      }
      p.bars = p.bars.length ? [...p.bars, ...bars] : bars;
      p.builtAt = lastIdx * M5 * 1000;
      if (p.bars.length > PATH_BARS + 300) p.bars = p.bars.slice(-PATH_BARS - 100);
    }
    return p;
  }

  /** deterministic anchor mid at an arbitrary epoch-second (for the live walk) */
  private anchorAt(p: SymbolPath, tSec: number): number {
    const idx = Math.floor(tSec / M5);
    const last = p.bars[p.bars.length - 1];
    if (!last) return p.base;
    if (idx <= last.t / M5) {
      // closed bucket — binary search
      let lo = 0, hi = p.bars.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (p.bars[mid].t <= idx * M5) lo = mid; else hi = mid - 1;
      }
      return p.bars[lo].c;
    }
    // forming bucket — lerp from its open toward the deterministic close
    const r = rng(p.symSeed ^ Math.imul(idx, 40503) ^ 0x9e3779b9);
    const block = Math.floor(idx / 48);
    const rb = rng(p.symSeed ^ Math.imul(block, 2654435761));
    const drift = (rb() * 2 - 1) * 0.55;
    const volMul = 0.55 + rb() * 1.25;
    const barSig = p.dayVol / Math.sqrt(288) * volMul;
    const dt = new Date(idx * M5 * 1000);
    const sig = barSig * sessionMul(dt.getUTCHours());
    const ret = drift * barSig * 0.35 + gauss(r) * sig;
    const target = last.c * (1 + ret);
    const frac = Math.min(1, (tSec - idx * M5) / M5);
    return last.c + (target - last.c) * frac;
  }

  // ═══════════════ per-TF serving ═══════════════

  /** aggregate the M5 master path up to the requested tf */
  private aggregate(p: SymbolPath, tfSec: number, fromT: number, toT: number): Bar[] {
    const out: Bar[] = [];
    let cur: Bar | null = null;
    for (const b of p.bars) {
      if (b.t + M5 <= fromT || b.t >= toT) continue;
      const bucket = Math.floor(b.t / tfSec) * tfSec;
      if (!cur || cur.t !== bucket) {
        if (cur) out.push(cur);
        cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** M1 sub-path: carve 5 chained M1 bars inside each of the last N M5 bars */
  private m1Path(p: SymbolPath, count: number): Bar[] {
    const out: Bar[] = [];
    const tail = p.bars.slice(-Math.ceil(count / 5) - 1);
    for (const parent of tail) {
      const r = rng(p.symSeed ^ Math.imul(parent.t, 2246822519));
      // 4 intermediate mids walking parent.open → parent.close, clamped
      const mids: number[] = [parent.o];
      let prev = parent.o;
      for (let i = 1; i <= 4; i++) {
        const target = parent.o + (parent.c - parent.o) * (i / 5);
        const wobble = gauss(r) * (parent.h - parent.l) * 0.06;
        prev = Math.min(parent.h, Math.max(parent.l, target + wobble));
        mids.push(prev);
      }
      mids.push(parent.c);
      // which children touch the parent's high / low (seeded positions)
      const hiAt = 1 + Math.floor(r() * 5);
      const loAt = 1 + Math.floor(r() * 5);
      for (let i = 0; i < 5; i++) {
        const o = mids[i], c = mids[i + 1];
        let h = Math.max(o, c), l = Math.min(o, c);
        if (i + 1 === hiAt) h = Math.max(h, parent.h);
        if (i + 1 === loAt) l = Math.min(l, parent.l);
        h = Math.min(parent.h, h + Math.abs(gauss(r)) * (parent.h - parent.l) * 0.08);
        l = Math.max(parent.l, l - Math.abs(gauss(r)) * (parent.h - parent.l) * 0.08);
        const v = Math.max(2, Math.round(parent.v / 5 * (0.5 + r())));
        out.push({ t: parent.t + i * 60, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v });
      }
    }
    return out.slice(-count);
  }

  /**
   * Serve `limit` bars of `tf` for `symbol`.
   * `liveBars` = the manager cache's tick-built bars for this key (the live
   * forming bar + any bars the tick walk already closed) — they WIN over the
   * deterministic history for their timestamps and extend it.
   */
  serveCandles(symbol: string, tf: string, limit: number, liveBars: Bar[] | null): Bar[] {
    const tfSec = TF_SEC[tf] ?? 60;
    const p = this.pathFor(symbol);
    const now = this.now();
    const nowBucket = Math.floor(now / tfSec) * tfSec;
    let gen: Bar[];
    if (tf === "M1") {
      gen = this.m1Path(p, Math.min(Math.max(limit, 200), 2200));
    } else if (tf === "M5") {
      gen = p.bars.slice(-limit);
    } else {
      const fromT = nowBucket - tfSec * (limit + 2);
      gen = this.aggregate(p, tfSec, fromT, nowBucket + tfSec);
    }
    // drop a partially-covered newest generated bucket (it is the forming one
    // unless the live walk already owns it)
    if (gen.length && gen[gen.length - 1].t >= nowBucket) gen = gen.slice(0, -1);
    // merge: generated history + live continuation
    let merged = gen;
    if (liveBars?.length) {
      const genLast = gen.length ? gen[gen.length - 1].t : -1;
      const byT = new Map<number, Bar>();
      for (const b of gen) byT.set(b.t, b);
      for (const b of liveBars) {
        if (b.t > genLast || byT.has(b.t)) byT.set(b.t, b);
      }
      merged = [...byT.values()].sort((a, b) => a.t - b.t);
    }
    return merged.slice(-limit);
  }

  // ═══════════════ live tick loop ═══════════════

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 700);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.live.clear();
  }

  private tick() {
    if (!this.running || !this.injectQuote) return;
    const now = this.now();
    for (const name of Object.keys(SYMS)) {
      const profile = SYMS[name];
      const p = this.pathFor(name);
      const anchor = this.anchorAt(p, now);
      let st = this.live.get(name);
      if (!st) {
        st = { mid: anchor };
        this.live.set(name, st);
      }
      // mean-reverting random walk around the deterministic anchor:
      // the live tape stays NEAR the path (so regenerating history never
      // jumps) but wiggles like a real feed.
      const r = rng((hashStr(name) ^ Math.imul(now, 2654435761)) >>> 0);
      const tickSig = (profile.dayVolPct / 100) / Math.sqrt(288 * 60); // per-tick σ
      const pull = (anchor - st.mid) * 0.06;
      const step = gauss(r) * tickSig + pull;
      st.mid = st.mid * (1 + step);
      // mean-revert hard if we somehow drifted > 6× the bar σ off the anchor
      const maxDev = st.mid * tickSig * 30;
      if (Math.abs(anchor - st.mid) > maxDev) st.mid = anchor + Math.sign(st.mid - anchor) * maxDev;
      const half = st.mid * profile.spreadBp / 10000 / 2;
      const bid = +(st.mid - half).toFixed(profile.digits + 2);
      const ask = +(st.mid + half).toFixed(profile.digits + 2);
      this.injectQuote(name, profile.digits, bid, ask);
    }
  }
}
