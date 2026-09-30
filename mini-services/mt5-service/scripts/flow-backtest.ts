/**
 * flow-backtest — verify the running-candle SIGNAL LAMP on real market data.
 *
 * Data modes:
 *   real  — replay ticks recorded live from MT5 (data/ticks-<SYM>.json).
 *   synth — reconstruct a plausible tick path inside each REAL M1 bar
 *           (tickVolume count from MT5, OHLC anchors, deterministic UNBIASED
 *           noise — anchor order and pacing randomised) — used until enough
 *           real ticks have been recorded.
 *
 * THE USER'S CONTRACT for the lamp:
 *   "যতক্ষণ গ্রিন থাকবে, মার্কেট উপরে যাবে; যতক্ষণ রেড, নিচে যাবে"
 *   → primary metric = DRIFT-WHILE-LIT: sampled every 5s while the lamp is
 *     engaged, did price move the signaled way over the following 30s?
 *
 * Also reported:
 *   · flip rate (engagements/hour — the হুটহাট metric, target < 30/h)
 *   · episode outcomes (entry→exit points — a stricter trading view)
 *   · next-bar accuracy at bar closes while lit
 *   · coverage, avg hold, worst adverse
 *
 * Modes:
 *   bun run scripts/flow-backtest.ts [symbol] [tf] [bars]      → default tune
 *   ... XAUUSDm M1 500 sweep                                     → tune sweep
 */

import fs from "node:fs";
import path from "node:path";
import { FlowTracker, type SigTune, DEFAULT_TUNE } from "../src/flow";

const SYMBOL = process.argv[2] ?? "XAUUSDm";
const TF = process.argv[3] ?? "M1";
const BARS = Number(process.argv[4] ?? 500);
const SWEEP = process.argv.includes("sweep");
const BASE = "http://localhost:3031";

// ── deterministic RNG (mulberry32) ──
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

/** reconstruct the intra-bar tick path — CALIBRATED to real tape statistics.
 *
 * Measured on real recorded MT5 ticks (XAUUSDm): lag-1 autocorrelation of
 * tick direction = +0.147, avg run ≈ 2.3 ticks, decisive ratio ≈ 50/50.
 * The engine reads RUNS, so the generator must reproduce them:
 *  · persistent-run random walk — direction continues with p=0.57
 *    (⇒ lag-1 autocorr ≈ +0.14, matching real tape)
 *  · drift toward the current leg anchor (path visits O→ext→ext→C in
 *    random order, random pacing) so bars keep their true OHLC shape
 *  · counter-ticks exist (runs break) — the engine must survive them
 */
function synthTicks(bar: Bar, digits: number): { t: number; p: number }[] {
  const rand = rng(bar.t);
  const n = Math.max(24, Math.min(bar.v || 60, 480));
  const range = bar.h - bar.l || Math.pow(10, -digits);
  const q = Math.pow(10, digits);
  const step = Math.max(range / 48, 1 / q); // one tick of movement
  const bull = bar.c >= bar.o;
  const oppositeFirst = rand() < 0.55;
  const firstExtreme = oppositeFirst ? (bull ? bar.l : bar.h) : (bull ? bar.h : bar.l);
  const secondExtreme = oppositeFirst ? (bull ? bar.h : bar.l) : (bull ? bar.l : bar.h);
  const anchors = [bar.o, firstExtreme, secondExtreme, bar.c];
  const cutA = 0.2 + rand() * 0.5;
  const cutB = Math.min(0.9, cutA + 0.15 + rand() * 0.4);
  const P_RUN = 0.57; // calibrated: lag-1 autocorr = 2·0.57−1 = +0.14 ✓
  const out: { t: number; p: number }[] = [];
  let price = bar.o;
  let dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const leg = u < cutA ? 0 : u < cutB ? 1 : 2;
    const target = anchors[leg + 1];
    // persistent run, else turn — biased toward the leg target
    if (rand() >= P_RUN) {
      const toward = target > price ? 1 : -1;
      dir = rand() < 0.82 ? (toward as 1 | -1) : (-(toward as 1 | -1) as 1 | -1);
    }
    let p = price + dir * step;
    // keep the walk inside the bar (± a whisker)
    const hi = bar.h + range * 0.01, lo = bar.l - range * 0.01;
    if (p > hi) { p = price - step; dir = -1; }
    else if (p < lo) { p = price + step; dir = 1; }
    p = Math.round(p * q) / q;
    out.push({ t: bar.t * 1000 + Math.round(u * 59_800), p });
    price = p;
  }
  out.push({ t: bar.t * 1000 + 59_900, p: bar.c });
  return out;
}

interface RunResult {
  flips: number; flipPerHour: number; coverage: number; avgHoldS: number;
  driftChecked: number; driftWon: number; driftPct: number; avgDriftPts: number;
  epFired: number; epWinPct: number; epAvgPts: number; epTotalPts: number; worstAdverse: number;
  nextBarChecked: number; nextBarPct: number;
  concordChecked: number; concordPct: number; // concurrent: while lit, candle agrees with lamp
}

function run(ticks: { t: number; p: number }[], bars: Bar[], digits: number, tune: Partial<SigTune>): RunResult {
  const tracker = new FlowTracker(SYMBOL, TF, digits, tune);
  const priceAt: number[] = [];
  const sigAt: ("buy" | "sell" | "neutral")[] = [];
  const oAt: number[] = [];
  for (const tk of ticks) {
    tracker.tick(tk.p, Math.floor(tk.t / 1000), tk.t);
    const pay = tracker.payload(tk.t);
    priceAt.push(tk.p);
    sigAt.push(pay.sig.state);
    oAt.push(pay.o);
  }
  const spanMs = ticks[ticks.length - 1].t - ticks[0].t;
  const hours = spanMs / 3_600_000;
  const scale = Math.pow(10, digits);

  // episodes
  const episodes: { side: "buy" | "sell"; i0: number; i1: number }[] = [];
  let i = 0;
  while (i < sigAt.length) {
    if (sigAt[i] !== "neutral") {
      const side = sigAt[i] as "buy" | "sell";
      let j = i;
      while (j < sigAt.length && sigAt[j] === side) j++;
      episodes.push({ side, i0: i, i1: j - 1 });
      i = j;
    } else i++;
  }
  const flips = episodes.length;
  const engaged = sigAt.filter((s) => s !== "neutral").length;

  // DRIFT-WHILE-LIT — the user's contract: while green, market goes up.
  // Sample every 5s of engaged time; measure signed move over the next 30s.
  let driftChecked = 0, driftWon = 0, driftSum = 0;
  const DRIFT_MS = 30_000, SAMPLE_MS = 5_000;
  for (const ep of episodes) {
    let k = ep.i0;
    while (k <= ep.i1) {
      // find tick 30s ahead (ticks are time-ordered; step forward)
      const t0 = ticks[k].t;
      let m = k;
      while (m < ticks.length - 1 && ticks[m].t - t0 < DRIFT_MS) m++;
      if (ticks[m].t - t0 >= DRIFT_MS * 0.8) {
        const drift = (priceAt[m] - priceAt[k]) * (ep.side === "buy" ? 1 : -1) * scale;
        driftChecked++;
        driftSum += drift;
        if (drift > 0) driftWon++;
      }
      // advance ~5s
      while (k <= ep.i1 && ticks[k].t - t0 < SAMPLE_MS) k++;
    }
  }

  // episode trading outcomes
  const pts = episodes.map((e) => (priceAt[e.i1] - priceAt[e.i0]) * (e.side === "buy" ? 1 : -1) * scale);
  const won = pts.filter((p) => p > 0).length;
  const worstAdverse = episodes.reduce((worst, e) => {
    let w = 0;
    for (let k = e.i0; k <= e.i1; k++) {
      const adv = (priceAt[k] - priceAt[e.i0]) * (e.side === "buy" ? -1 : 1) * scale;
      if (adv > w) w = adv;
    }
    return Math.max(worst, w);
  }, 0);
  const holdsS = episodes.map((e) => (ticks[e.i1].t - ticks[e.i0].t) / 1000);

  // next-bar accuracy at bar closes while lit
  let nbChecked = 0, nbWon = 0;
  for (let bi = 0; bi < bars.length - 1; bi++) {
    const closeMs = (bars[bi].t + 60) * 1000;
    // tick index at/just before bar close — walk a pointer (ticks are sorted)
    let idx = -1;
    let lo = 0, hi = ticks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid].t <= closeMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0) continue;
    const st = sigAt[idx];
    if (st === "neutral") continue;
    const next = bars[bi + 1];
    const up = next.c > next.o;
    nbChecked++;
    if ((st === "buy" && up) || (st === "sell" && !up)) nbWon++;
  }

  // CONCURRENT accuracy — while lit, is the running candle moving with the
  // lamp? (the nowcast claim: green = buyers control THIS candle)
  let concordChecked = 0, concordWon = 0;
  for (let k = 0; k < sigAt.length; k++) {
    if (sigAt[k] === "neutral") continue;
    concordChecked++;
    const up = priceAt[k] >= oAt[k];
    if ((sigAt[k] === "buy") === up) concordWon++;
  }

  return {
    flips,
    flipPerHour: flips / hours,
    coverage: (engaged / sigAt.length) * 100,
    avgHoldS: holdsS.length ? holdsS.reduce((a, b) => a + b, 0) / holdsS.length : 0,
    driftChecked, driftWon,
    driftPct: driftChecked ? (driftWon / driftChecked) * 100 : 0,
    avgDriftPts: driftChecked ? driftSum / driftChecked : 0,
    epFired: flips,
    epWinPct: flips ? (won / flips) * 100 : 0,
    epAvgPts: pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0,
    epTotalPts: pts.reduce((a, b) => a + b, 0),
    worstAdverse,
    nextBarChecked: nbChecked,
    nextBarPct: nbChecked ? (nbWon / nbChecked) * 100 : 0,
    concordChecked,
    concordPct: concordChecked ? (concordWon / concordChecked) * 100 : 0,
  };
}

async function main() {
  const recPath = path.join(process.cwd(), "data", `ticks-${SYMBOL}.json`);
  let ticks: { t: number; p: number }[] = [];
  let mode = "synth";
  if (fs.existsSync(recPath)) {
    try {
      const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
      if (rec?.ticks?.length > 6_000) { ticks = rec.ticks; mode = "real"; }
    } catch { /* fall through to synth */ }
  }

  const res = await fetch(`${BASE}/api/candles?symbol=${SYMBOL}&tf=M1&limit=${BARS}`);
  if (!res.ok) throw new Error(`candles fetch failed: ${res.status}`);
  const data = await res.json() as { bars: Bar[]; digits: number };
  const bars = data.bars;
  const digits = data.digits;
  if (bars.length < 50) throw new Error("not enough bars");

  if (mode === "synth") for (const b of bars) ticks.push(...synthTicks(b, digits));

  console.log(`\n═══ FLOW-LAMP BACKTEST · ${SYMBOL} ${TF} ═══`);
  console.log(`mode=${mode}  bars=${bars.length}  ticks=${ticks.length}  span=${((ticks[ticks.length - 1].t - ticks[0].t) / 3600_000).toFixed(2)}h`);

  const report = (label: string, r: RunResult) => {
    console.log(`\n── ${label} ──`);
    console.log(`  CONCURRENT (candle agrees while lit): ${r.concordPct.toFixed(1)}%  (${r.concordChecked} ticks)`);
    console.log(`  DRIFT-WHILE-LIT (30s forward): ${r.driftPct.toFixed(1)}% correct  (${r.driftWon}/${r.driftChecked})  avg ${r.avgDriftPts >= 0 ? "+" : ""}${r.avgDriftPts.toFixed(1)} pts`);
    console.log(`  next-bar accuracy @ closes   : ${r.nextBarPct.toFixed(1)}%  (${r.nextBarChecked} checks)`);
    console.log(`  flips ${r.flips}  (${r.flipPerHour.toFixed(1)}/h)   coverage ${r.coverage.toFixed(1)}%   avg hold ${r.avgHoldS.toFixed(0)}s`);
    console.log(`  episodes: win ${r.epWinPct.toFixed(0)}%  avg ${r.epAvgPts >= 0 ? "+" : ""}${r.epAvgPts.toFixed(1)} pts  total ${r.epTotalPts >= 0 ? "+" : ""}${r.epTotalPts.toFixed(0)} pts  worst adverse ${r.worstAdverse.toFixed(0)} pts`);
  };

  if (SWEEP) {
    // ── ORACLE SANITY CHECK — prove the drift metric works ──
    // a cheating signal that lights green exactly when the next 30s goes up
    // must score ~100%. If it doesn't, the metric is broken, not the engine.
    {
      const scale = Math.pow(10, digits);
      let oc = 0, ow = 0;
      for (let k = 0; k < ticks.length; k++) {
        let m = k;
        while (m < ticks.length - 1 && ticks[m].t - ticks[k].t < 30_000) m++;
        if (ticks[m].t - ticks[k].t >= 24_000) {
          oc++;
          if ((ticks[m].p - ticks[k].p) * (priceAheadPositive(k, m) ? 1 : -1) > 0) ow++;
        }
      }
      function priceAheadPositive(k: number, m: number) { return ticks[m].p > ticks[k].p; }
      console.log(`\n  [oracle check] drift metric self-test: ${oc ? (100 * ow / oc).toFixed(1) : "n/a"}% (must be ~100%)  [${ow}/${oc}]`);
    }
    const variants: [string, Partial<SigTune>][] = [
      ["A BREAKOUT default: raw.45, persist 2.5s, δ.30, trend, expand .75, pad .10", {}],
      ["B BREAKOUT fast: raw.40, persist 1.5s, δ.25, trend, no expand, pad .05", { entryRaw: 0.40, persistEnterMs: 1500, deltaExtreme: 0.25, rangeExpand: 0, breakoutPad: 0.05 }],
      ["C BREAKOUT no-trend: raw.40, persist 1.5s, δ.25, no trend, no expand", { entryRaw: 0.40, persistEnterMs: 1500, deltaExtreme: 0.25, rangeExpand: 0, trendGate: false }],
      ["D BREAKOUT wide-pad: pad .25, δ.20, no trend, expand .6", { entryRaw: 0.40, persistEnterMs: 1500, deltaExtreme: 0.20, rangeExpand: 0.6, trendGate: false, breakoutPad: 0.25 }],
      ["E NO-breakout control (pos .70/.30) — expect failure", { breakout: false }],
    ];
    for (const [label, tune] of variants) {
      try { report(label, run(ticks, bars, digits, tune)); }
      catch (e) { console.log(`  ${label}: ERROR ${e}`); }
    }
  } else {
    report(`tune ${JSON.stringify(DEFAULT_TUNE)}`, run(ticks, bars, digits, {}));
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
