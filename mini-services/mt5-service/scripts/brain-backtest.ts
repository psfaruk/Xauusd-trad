/**
 * brain-backtest — verify the v12 AI-brain ENTRY/EXIT pipeline on REAL ticks.
 *
 * Replays data/ticks-<SYM>.json (real MT5 ticks recorded live) through the
 * SAME FlowTracker the service uses (lamp + deepRead), then simulates the
 * deterministic rails of the CURRENT brain (v12, R-multiple mode):
 *
 *   · candidate floor per symbol class (priority 0.26 / standard 0.42)
 *   · offline-strict conviction gate: sig.strength ≥ profile.minStrength
 *     (adaptive multiplier replayed at its neutral 1.0 — live range 0.85–1.25)
 *   · 3-chart confluence (M15 structure + cross-candle delta + 30s tick path)
 *     + candle-age gate + extension-chase guard + trend agree
 *   · SL = ATR × profile.slAtrMult (structure-aware adjust, spread floor,
 *     ATR cap) · TP = entry ± slDist × profile.tpR (R-MULTIPLE, never $)
 *   · breakeven at breakevenR · runner trail after trailR (trailGive)
 *   · flow-flip at flipStrength · dead-flow time stop at maxHoldMs
 *   · adverse cut at maxAdverseR · cooldown = cooldownMs × (prio ? 0.5 : 1)
 *
 * The LLM judge cannot be replayed — this validates the deterministic rails
 * (exactly what runs when the model is unreachable, which the journal showed
 * was most of the time). Honest numbers only: if this is negative, the
 * system has no business going live regardless of what the judge would add.
 *
 * v12.1: previously this script mirrored the OLD v5 constants (tpR 2.0,
 * SL_ATR_MULT 1.5, CAND_FLOOR 0.30, 8-min hold) — so every "brain backtest"
 * run before this commit tested a brain that no longer exists. It now
 * mirrors trader.ts RISK (conservative default — the post-migration mode)
 * with per-symbol spread/digits (BTC is NOT gold).
 *
 * Run:  bun run scripts/brain-backtest.ts [symbol] [profile] [sweep]
 *       e.g. bun run scripts/brain-backtest.ts XAUUSDm conservative sweep
 */

import fs from "node:fs";
import path from "node:path";
import { FlowTracker } from "../src/flow";

const SYMBOL = process.argv[2] ?? "XAUUSDm";
const ARG_PROFILE = (process.argv.find((a) => ["conservative", "balanced", "aggressive"].includes(a)) ??
  "conservative") as RiskMode;
const SWEEP = process.argv.includes("sweep");

// ── per-symbol market microstructure (v12.1: BTC is not gold) ──
const MARKET: Record<string, { digits: number; spread: number }> = {
  XAUUSDm: { digits: 3, spread: 0.24 },   // typical Exness gold spread (price units)
  XAGUSDm: { digits: 3, spread: 0.03 },
  BTCUSDm: { digits: 2, spread: 35 },     // real BTC spread is tens of USD, not 0.24
  ETHUSDm: { digits: 2, spread: 2.4 },
};
const mkt = MARKET[SYMBOL] ?? { digits: 2, spread: 0.0025 * 2000 }; // sane fallback
const DIGITS = mkt.digits;
const SPREAD = mkt.spread;
const TICKS_FILE = path.join(import.meta.dir, "..", "data", `ticks-${SYMBOL}.json`);

// ── v12 RiskProfile — EXACT mirror of trader.ts RISK (keep in sync!) ──
type RiskMode = "conservative" | "balanced" | "aggressive";
interface RiskProfile {
  minStrength: number;
  slAtrMult: number;
  tpR: number;
  breakevenR: number;
  trailR: number;
  trailGive: number;
  flipStrength: number;
  maxHoldMs: number;
  maxAdverseR: number;
  cooldownMs: number;
}
const RISK: Record<RiskMode, RiskProfile> = {
  conservative: {
    minStrength: 0.55, slAtrMult: 1.8, tpR: 1.6, breakevenR: 0.8, trailR: 1.1,
    trailGive: 0.55, flipStrength: 0.72, maxHoldMs: 10 * 60_000, maxAdverseR: 0.7,
    cooldownMs: 100_000,
  },
  balanced: {
    minStrength: 0.45, slAtrMult: 1.5, tpR: 1.5, breakevenR: 0.7, trailR: 1.1,
    trailGive: 0.6, flipStrength: 0.68, maxHoldMs: 8 * 60_000, maxAdverseR: 0.6,
    cooldownMs: 70_000,
  },
  aggressive: {
    minStrength: 0.35, slAtrMult: 1.2, tpR: 1.8, breakevenR: 0.8, trailR: 1.2,
    trailGive: 0.7, flipStrength: 0.62, maxHoldMs: 6 * 60_000, maxAdverseR: 0.55,
    cooldownMs: 45_000,
  },
};

// ── shared brain constants (trader.ts) ──
const PRIORITY_SYMBOLS = new Set(["XAUUSDm", "USOILm", "USTEC_x100m"]); // lamp floor 0.26, cooldown ×0.5
const CAND_FLOOR_PRIO = 0.26;
const CAND_FLOOR_STD = 0.42;
const EXT_MAX_ATR = 1.75;             // never chase further than this many ATR past EMA20
const SPREAD_BUDGET = 3.5;            // SL ≥ spread × 3.5
const SL_ATR_CAP = 3.6;               // SL never wider than ATR × 3.6
const RUNNER_GIVE = 0.35;             // extra trail give while flow is with us
const ADAPTIVE_MIN_REPLAY = 1.0;      // live adaptive range 0.85–1.25; replay neutral

interface Tick { t: number; p: number }
interface Bar { t: number; o: number; h: number; l: number; c: number }

function loadTicks(): Tick[] {
  const parsed = JSON.parse(fs.readFileSync(TICKS_FILE, "utf8")) as { ticks?: Tick[] } | Tick[];
  const raw = Array.isArray(parsed) ? parsed : (parsed.ticks ?? []);
  return raw.filter((x) => x && typeof x.t === "number" && x.p > 0).sort((a, b) => a.t - b.t);
}

/** aggregate raw ticks into fixed-second bars */
function toBars(ticks: Tick[], sec: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let bucket = -1;
  for (const tk of ticks) {
    const b = Math.floor(tk.t / 1000 / sec) * sec;
    if (b !== bucket) {
      if (cur) out.push(cur);
      cur = { t: b, o: tk.p, h: tk.p, l: tk.p, c: tk.p };
      bucket = b;
    } else if (cur) {
      cur.h = Math.max(cur.h, tk.p);
      cur.l = Math.min(cur.l, tk.p);
      cur.c = tk.p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function atr(bars: Bar[], n = 14): number {
  if (bars.length < n + 1) return 0;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    sum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  return sum / n;
}

function ema(vals: number[], n = 20): number {
  const k = 2 / (n + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

/** linear-regression slope in ATRs per bar */
function slopeAtr(bars: Bar[], a: number): number {
  const closes = bars.slice(-60).map((b) => b.c);
  const n = closes.length;
  if (n < 10 || a <= 0) return 0;
  const meanX = (n - 1) / 2, meanY = closes.reduce((x, y) => x + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den ? (num / den) / a : 0;
}

interface SimPos {
  side: "buy" | "sell";
  entry: number;
  sl: number;
  tp: number;
  slDist: number;
  peakR: number;
  beMoved: boolean;
  openedAt: number;
}

interface Trade {
  side: "buy" | "sell";
  entry: number; exit: number;
  pnlR: number; peakR: number;
  heldMs: number;
  exitKind: string;
}

function simulate(ticks: Tick[], mode: "v12" | "old", prof: RiskProfile): Trade[] {
  const tracker = new FlowTracker(SYMBOL, "M1", DIGITS);
  const m1: Bar[] = [];            // completed M1 bars
  const m15: Bar[] = [];           // completed M15 bars
  let m1cur: Bar | null = null;
  let m15cur: Bar | null = null;
  let lastM1Bucket = -1, lastM15Bucket = -1;

  const trades: Trade[] = [];
  let pos: SimPos | null = null;
  let lastEntryAt = 0;
  let pathWin: Tick[] = [];
  const prio = PRIORITY_SYMBOLS.has(SYMBOL);
  const candFloor = prio ? CAND_FLOOR_PRIO : CAND_FLOOR_STD;
  const cooldownMs = prof.cooldownMs * (prio ? 0.5 : 1);
  // offline-strict conviction (judge-unavailable path; adaptive at neutral)
  const strict = Math.min(0.85, prof.minStrength * ADAPTIVE_MIN_REPLAY);

  const closePos = (p: SimPos, price: number, at: number, why: string) => {
    const dir = p.side === "buy" ? 1 : -1;
    trades.push({
      side: p.side, entry: p.entry, exit: price,
      pnlR: ((price - p.entry) * dir) / p.slDist,
      peakR: p.peakR, heldMs: at - p.openedAt, exitKind: why,
    });
  };

  for (const tk of ticks) {
    // ── bar aggregation ──
    const b1 = Math.floor(tk.t / 1000 / 60) * 60;
    if (b1 !== lastM1Bucket) {
      if (m1cur) m1.push(m1cur);
      m1cur = { t: b1, o: tk.p, h: tk.p, l: tk.p, c: tk.p };
      lastM1Bucket = b1;
    } else if (m1cur) {
      m1cur.h = Math.max(m1cur.h, tk.p); m1cur.l = Math.min(m1cur.l, tk.p); m1cur.c = tk.p;
    }
    const b15 = Math.floor(tk.t / 1000 / 900) * 900;
    if (b15 !== lastM15Bucket) {
      if (m15cur) m15.push(m15cur);
      m15cur = { t: b15, o: tk.p, h: tk.p, l: tk.p, c: tk.p };
      lastM15Bucket = b15;
    } else if (m15cur) {
      m15cur.h = Math.max(m15cur.h, tk.p); m15cur.l = Math.min(m15cur.l, tk.p); m15cur.c = tk.p;
    }

    // 30s tick-path window
    pathWin.push(tk);
    while (pathWin.length && tk.t - pathWin[0].t > 30_000) pathWin.shift();

    tracker.tick(tk.p, Math.floor(tk.t / 1000), tk.t);
    const fp = tracker.payload(tk.t);
    const sig = fp.sig;

    // ══ POSITION MANAGEMENT (every tick) ══
    if (pos) {
      const p = pos;
      const dir = p.side === "buy" ? 1 : -1;
      const pts = (tk.p - p.entry) * dir;
      const r = pts / p.slDist;
      p.peakR = Math.max(p.peakR, r);

      // hard SL / TP
      if ((p.side === "buy" && tk.p <= p.sl) || (p.side === "sell" && tk.p >= p.sl)) {
        closePos(p, p.sl, tk.t, mode === "v12" ? (p.beMoved ? "trail/BE stop" : "SL hit") : "SL hit");
        pos = null;
      } else if ((p.side === "buy" && tk.p >= p.tp) || (p.side === "sell" && tk.p <= p.tp)) {
        closePos(p, p.tp, tk.t, "TP hit");
        pos = null;
      } else {
        const flowWithUs = sig.state === p.side;
        const flowAgainst = sig.state === (p.side === "buy" ? "sell" : "buy");
        // flow flip (v12: per-profile flipStrength, only far from TP)
        if (flowAgainst && sig.strength >= prof.flipStrength && r < prof.tpR * 0.5) {
          closePos(p, tk.p, tk.t, "flow flipped");
          pos = null;
        } else if (mode === "v12") {
          // breakeven (v12: later — 0.8R conservative — so young winners breathe)
          if (!p.beMoved && r >= prof.breakevenR) {
            p.sl = p.entry + dir * p.slDist * 0.05;
            p.beMoved = true;
          }
          // runner trail (v12: per-profile trailGive)
          if (r >= prof.trailR) {
            const give = prof.trailGive + (flowWithUs ? RUNNER_GIVE : 0);
            const stop = p.entry + dir * p.slDist * Math.max(0.2, p.peakR - give);
            if (dir > 0 ? stop > p.sl : stop < p.sl) p.sl = stop;
          }
          // time stop — ONLY dead flow
          if (tk.t - p.openedAt > prof.maxHoldMs && r < 0.15 && (sig.state === "neutral" || sig.quiet)) {
            closePos(p, tk.p, tk.t, "time stop (dead)");
            pos = null;
          }
          // adverse cut (v12: per-profile maxAdverseR)
          if (pos && r <= -prof.maxAdverseR && flowAgainst) {
            closePos(p, tk.p, tk.t, "adverse cut");
            pos = null;
          }
        } else {
          // OLD: blind time stop (any R < 0.15 at 8 min)
          if (tk.t - p.openedAt > 8 * 60_000 && r < 0.15) {
            closePos(p, tk.p, tk.t, "time stop (blind)");
            pos = null;
          }
          // OLD: plain trail
          if (pos && r >= prof.trailR) {
            const stop = p.entry + dir * p.slDist * Math.max(0.2, p.peakR - 0.6);
            if (dir > 0 ? stop > p.sl : stop < p.sl) p.sl = stop;
          }
          if (pos && r <= -0.85 && flowAgainst) {
            closePos(p, tk.p, tk.t, "adverse cut");
            pos = null;
          }
        }
      }
      if (pos) continue;  // one position at a time
    }

    // ══ ENTRY PIPELINE (v12 offline rails) ══
    if (sig.state !== "buy" && sig.state !== "sell") continue;
    const side = sig.state as "buy" | "sell";
    // 1. lamp candidate floor (priority pairs are deliberately lower —
    //    the judge + offline-strict gate do the real filtering)
    if (sig.strength < candFloor) continue;
    // 2. offline-strict conviction (what runs when the LLM is unreachable)
    if (mode === "v12" && sig.strength < strict) continue;
    // 3. per-symbol cooldown (priority pairs rest half as long)
    if (tk.t - lastEntryAt < cooldownMs) continue;

    // 4. candle-age gate — don't enter on a stale/just-opening M1 candle
    const ageFrac = (tk.t / 1000 % 60) / 60;
    if (mode === "v12" && (ageFrac < 0.10 || ageFrac > 0.85)) continue;
    if (mode === "old" && ageFrac > 0.85) continue;

    if (m1.length < 16) continue;
    const a = atr(m1);
    if (a <= 0) continue;
    const e = ema(m1.slice(-40).map((b) => b.c));
    const extAtr = Math.abs(tk.p - e) / a;
    if (extAtr > EXT_MAX_ATR) { lastEntryAt = tk.t; continue; }  // chase guard

    const trendOk = side === "buy" ? tk.p > e : tk.p < e;

    if (mode === "v12") {
      // ── 3-CHART CONFLUENCE ──
      // 1. structure: M15 slope must not oppose (needs some M15 history)
      let structureOk = true;
      if (m15.length >= 12) {
        const s = slopeAtr(m15, atr(m15, 14) || a);
        structureOk = Math.abs(s) < 0.12 || (side === "buy" ? s > 0 : s < 0);
      }
      // 2. delta micro: current AND previous candle delta agree
      const deep = tracker.deepRead();
      const dirSign = side === "buy" ? 1 : -1;
      const deltaOk = deep.prevDelta !== 0 || deep.curDelta !== 0
        ? (deep.prevDelta * dirSign > 0 && deep.curDelta * dirSign > 0)
        : (fp.deltaPct * dirSign >= 0.25);
      // 3. tick path (last 30s): net push + holding its end + up-tick balance
      let pathOk = true;
      if (pathWin.length >= 8) {
        const first = pathWin[0].p, last = pathWin[pathWin.length - 1].p;
        const net = (last - first) * dirSign;
        const hi = Math.max(...pathWin.map((x) => x.p));
        const lo = Math.min(...pathWin.map((x) => x.p));
        const span = hi - lo || 1e-9;
        const closeFrac = (last - lo) / span;
        let ups = 0;
        for (let i = 1; i < pathWin.length; i++) if (pathWin[i].p > pathWin[i - 1].p) ups++;
        const upFrac = ups / (pathWin.length - 1);
        pathOk = net > 0
          && (side === "buy" ? closeFrac >= 0.55 : closeFrac <= 0.45)
          && (side === "buy" ? upFrac >= 0.48 : upFrac <= 0.52);
      }
      if (!(structureOk && deltaOk && pathOk)) { lastEntryAt = tk.t; continue; }
    } else {
      // OLD local rules: strength ≥ 0.45 + trend + momentum
      const mom = fp.deltaPct; // proxy for the old momentum feel
      if (!(sig.strength >= 0.45 && trendOk && (side === "buy" ? mom > -0.15 : mom < 0.15))) continue;
    }

    // ── SL/TP (v12: R-multiple, structure-aware) ──
    let slDist = a * prof.slAtrMult;
    if (mode === "v12") {
      const last3 = m1.slice(-3);
      const ext = side === "buy" ? Math.min(...last3.map((b) => b.l)) : Math.max(...last3.map((b) => b.h));
      const d = Math.abs(tk.p - ext) + a * 0.25;
      if (d >= slDist * 0.7 && d <= slDist * 1.6) slDist = d;
    }
    if (slDist < SPREAD * SPREAD_BUDGET) slDist = SPREAD * SPREAD_BUDGET;
    if (slDist > a * SL_ATR_CAP) slDist = a * SL_ATR_CAP;
    if (SPREAD > slDist * 0.45) continue;   // spread eats the setup — skip

    const entry = side === "buy" ? tk.p + SPREAD / 2 : tk.p - SPREAD / 2;
    pos = {
      side, entry,
      sl: side === "buy" ? entry - slDist : entry + slDist,
      tp: side === "buy" ? entry + slDist * prof.tpR : entry - slDist * prof.tpR,
      slDist, peakR: 0, beMoved: false, openedAt: tk.t,
    };
    lastEntryAt = tk.t;
  }
  return trades;
}

// ═══════════════════════ report ═══════════════════════
function report(name: string, trades: Trade[], spanMs: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0).length;
  const tpHits = trades.filter((t) => t.exitKind === "TP hit").length;
  const slHits = trades.filter((t) => t.exitKind === "SL hit");
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0);
  const avgR = n ? totalR / n : 0;
  const avgHold = n ? trades.reduce((s, t) => s + t.heldMs, 0) / n / 1000 : 0;
  let consecLoss = 0, maxConsecLoss = 0;
  for (const t of trades) {
    if (t.pnlR <= 0) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }
  const byExit = new Map<string, number>();
  for (const t of trades) byExit.set(t.exitKind, (byExit.get(t.exitKind) ?? 0) + 1);
  const hours = spanMs / 3_600_000;

  console.log(`\n┌───────── ${name} ─────────`);
  console.log(`│ trades: ${n} in ${hours.toFixed(1)}h (${(n / hours).toFixed(1)}/h)`);
  if (!n) { console.log("│ (no trades)"); return; }
  console.log(`│ WIN rate:      ${((wins / n) * 100).toFixed(1)}%  (${wins}/${n})`);
  console.log(`│ TP hit rate:   ${((tpHits / n) * 100).toFixed(1)}%`);
  console.log(`│ SL hit rate:   ${((slHits.length / n) * 100).toFixed(1)}%`);
  console.log(`│ total R: ${totalR.toFixed(2)} · avg R/trade: ${avgR.toFixed(3)} (expectancy)`);
  console.log(`│ avg hold: ${avgHold.toFixed(0)}s · worst loss-streak: ${maxConsecLoss}`);
  console.log(`│ exits: ${[...byExit.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log("└─────────────────────────────");
}

const ticks = loadTicks();
const spanMs = ticks[ticks.length - 1].t - ticks[0].t;
const prof = RISK[ARG_PROFILE];
console.log(`brain-backtest v12 · ${SYMBOL}${PRIORITY_SYMBOLS.has(SYMBOL) ? " (★prio)" : ""} · digits ${DIGITS} · spread ${SPREAD}`);
console.log(`tape: ${ticks.length.toLocaleString()} real ticks · ${(spanMs / 3_600_000).toFixed(2)}h`);
console.log(`profile: ${ARG_PROFILE} { minStr ${prof.minStrength} · slAtr ${prof.slAtrMult} · tpR ${prof.tpR} · beR ${prof.breakevenR} · trailR ${prof.trailR} · flip ${prof.flipStrength} · maxHold ${prof.maxHoldMs / 60000}m · adverse ${prof.maxAdverseR}R · cooldown ${prof.cooldownMs / 1000}s }`);
report(`v12 rails (${ARG_PROFILE}, R-multiple mode)`, simulate(ticks, "v12", prof), spanMs);
report("OLD v4 rules (trend+mom, ATR SL, blind time-stop)", simulate(ticks, "old", prof), spanMs);

// ── sweep: the three v12 profiles + a TP/BE grid around them ──
if (SWEEP) {
  console.log("\n═══ v12 profiles head-to-head ═══");
  for (const [name, p] of Object.entries(RISK)) {
    const ts = simulate(ticks, "v12", p);
    const n = ts.length;
    const wins = ts.filter((t) => t.pnlR > 0).length;
    const totR = ts.reduce((s, t) => s + t.pnlR, 0);
    console.log(
      `${name.padEnd(13)} n=${String(n).padEnd(4)} win%=${n ? ((wins / n) * 100).toFixed(1).padEnd(6) : "—".padEnd(6)} totalR=${totR.toFixed(2).padEnd(7)} avgR=${n ? (totR / n).toFixed(3) : "—"}`,
    );
  }
  console.log("\n═══ TP/BE/TRAIL grid (v12 rails, conservative base) ═══");
  console.log("TP_R   BE_R   TRAIL_R  n    win%    TP-hit%  totalR  avgR");
  const base = RISK.conservative;
  for (const tp of [1.2, 1.4, 1.6, 1.8, 2.0]) {
    for (const be of [0.7, 0.8, 0.9]) {
      for (const tr of [1.0, 1.1, 1.2]) {
        const p: RiskProfile = { ...base, tpR: tp, breakevenR: be, trailR: tr };
        const ts = simulate(ticks, "v12", p);
        const n = ts.length;
        const wins = ts.filter((t) => t.pnlR > 0).length;
        const tpH = ts.filter((t) => t.exitKind === "TP hit").length;
        const totR = ts.reduce((s, t) => s + t.pnlR, 0);
        console.log(
          `${tp.toFixed(1).padEnd(6)} ${be.toFixed(1).padEnd(6)} ${tr.toFixed(1).padEnd(7)} ${String(n).padEnd(5)} ${n ? ((wins / n) * 100).toFixed(1).padEnd(7) : "—".padEnd(7)} ${n ? ((tpH / n) * 100).toFixed(1).padEnd(7) : "—".padEnd(7)} ${totR.toFixed(2).padEnd(7)} ${n ? (totR / n).toFixed(3) : "—"}`,
        );
      }
    }
  }
}
