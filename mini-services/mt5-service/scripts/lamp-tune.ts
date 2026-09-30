/**
 * lamp-tune — sweep candidate lamp tunes against the REAL recorded tape
 * (data/ticks-<SYM>.json) and report the user-contract metrics:
 *   · flips/h  (হুটহাট metric — target 4..20/h)
 *   · coverage % (how often the lamp is lit)
 *   · CONCURRENT % — while lit, candle moves with the lamp (green ⇒ up)
 *   · DRIFT 30s forward — while lit, does price continue the signaled way
 *   · episode P&L (entry→exit pts) + worst adverse
 * Anti-overfit: the same tune must behave on BOTH the real tape and a
 * longer synthetic reconstruction of real bars.
 */
import fs from "node:fs";
import path from "node:path";
import { FlowTracker, type SigTune, DEFAULT_TUNE } from "../src/flow";

const SYMBOL = process.argv[2] ?? "XAUUSDm";
const TF = process.argv[3] ?? "M1";
const BASE = "http://localhost:3031";

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

function synthTicks(bar: Bar, digits: number): { t: number; p: number }[] {
  const rand = rng(bar.t);
  const n = Math.max(24, Math.min(bar.v || 60, 480));
  const range = bar.h - bar.l || Math.pow(10, -digits);
  const q = Math.pow(10, digits);
  const step = Math.max(range / 48, 1 / q);
  const bull = bar.c >= bar.o;
  const oppositeFirst = rand() < 0.55;
  const firstExtreme = oppositeFirst ? (bull ? bar.l : bar.h) : (bull ? bar.h : bar.l);
  const secondExtreme = oppositeFirst ? (bull ? bar.h : bar.l) : (bull ? bar.l : bar.h);
  const anchors = [bar.o, firstExtreme, secondExtreme, bar.c];
  const cutA = 0.2 + rand() * 0.5;
  const cutB = Math.min(0.9, cutA + 0.15 + rand() * 0.4);
  const P_RUN = 0.57;
  const out: { t: number; p: number }[] = [];
  let price = bar.o;
  let dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const leg = u < cutA ? 0 : u < cutB ? 1 : 2;
    const target = anchors[leg + 1];
    if (rand() >= P_RUN) {
      const toward = target > price ? 1 : -1;
      dir = rand() < 0.82 ? (toward as 1 | -1) : (-(toward as 1 | -1) as 1 | -1);
    }
    let p = price + dir * step;
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

function run(ticks: { t: number; p: number }[], digits: number, tune: Partial<SigTune>) {
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
  const engaged = sigAt.filter((s) => s !== "neutral").length;

  let driftChecked = 0, driftWon = 0, driftSum = 0;
  for (const ep of episodes) {
    let k = ep.i0;
    while (k <= ep.i1) {
      const t0 = ticks[k].t;
      let m = k;
      while (m < ticks.length - 1 && ticks[m].t - t0 < 30_000) m++;
      if (ticks[m].t - t0 >= 24_000) {
        const drift = (priceAt[m] - priceAt[k]) * (ep.side === "buy" ? 1 : -1) * scale;
        driftChecked++; driftSum += drift;
        if (drift > 0) driftWon++;
      }
      while (k <= ep.i1 && ticks[k].t - t0 < 5_000) k++;
    }
  }
  const pts = episodes.map((e) => (priceAt[e.i1] - priceAt[e.i0]) * (e.side === "buy" ? 1 : -1) * scale);
  const won = pts.filter((p) => p > 0).length;
  let worstAdverse = 0;
  for (const e of episodes) {
    for (let k = e.i0; k <= e.i1; k++) {
      const adv = (priceAt[k] - priceAt[e.i0]) * (e.side === "buy" ? -1 : 1) * scale;
      if (adv > worstAdverse) worstAdverse = adv;
    }
  }
  let concordChecked = 0, concordWon = 0;
  for (let k = 0; k < sigAt.length; k++) {
    if (sigAt[k] === "neutral") continue;
    concordChecked++;
    const up = priceAt[k] >= oAt[k];
    if ((sigAt[k] === "buy") === up) concordWon++;
  }
  return {
    flips: episodes.length,
    flipPerHour: episodes.length / hours,
    coverage: (engaged / sigAt.length) * 100,
    concordPct: concordChecked ? (concordWon / concordChecked) * 100 : 0,
    driftPct: driftChecked ? (driftWon / driftChecked) * 100 : 0,
    avgDriftPts: driftChecked ? driftSum / driftChecked : 0,
    epWinPct: episodes.length ? (won / episodes.length) * 100 : 0,
    epAvgPts: pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0,
    epTotalPts: pts.reduce((a, b) => a + b, 0),
    worstAdverse,
  };
}

async function main() {
  const recPath = path.join(process.cwd(), "data", `ticks-${SYMBOL}.json`);
  let real: { t: number; p: number }[] = [];
  try {
    const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
    if (rec?.ticks?.length > 6_000) real = rec.ticks;
  } catch { /* none */ }

  const res = await fetch(`${BASE}/api/candles?symbol=${SYMBOL}&tf=M1&limit=500`);
  const data = await res.json() as { bars: Bar[]; digits: number };
  const digits = data.digits;
  const synth: { t: number; p: number }[] = [];
  for (const b of data.bars) synth.push(...synthTicks(b, digits));

  console.log(`\n═══ LAMP TUNE SWEEP · ${SYMBOL} ${TF} ═══`);
  console.log(`real ticks: ${real.length} (${real.length ? ((real[real.length - 1].t - real[0].t) / 3_600_000).toFixed(2) : "0"}h)   synth: ${synth.length} ticks from ${data.bars.length} bars\n`);

  const variants: [string, Partial<SigTune>][] = [
    ["0 PRODUCTION (today — never fires)", {}],
    ["2 FAST-GAUGE: raw.34 δ.18 a.09 minD10 age8% p1.2s trend", {
      entryRaw: 0.34, deltaExtreme: 0.18, posBuy: 0.56, posSell: 0.44,
      minDecisive: 10, persistEnterMs: 1200, cooldownMs: 4000, minHoldM1: 8000,
      ageFrac: 0.08, ageMinMs: 6000, deltaAlpha: 0.09,
    } as Partial<SigTune>],
    ["2b FAST-GAUGE strict: raw.36 δ.20 a.09 minD12 age10% p1.5s trend", {
      entryRaw: 0.36, deltaExtreme: 0.20, posBuy: 0.57, posSell: 0.43,
      minDecisive: 12, persistEnterMs: 1500, cooldownMs: 4000, minHoldM1: 8000,
      ageFrac: 0.10, ageMinMs: 6000, deltaAlpha: 0.09,
    } as Partial<SigTune>],
    ["2c FAST-GAUGE very-strict: raw.38 δ.22 a.09 minD14 age10% p1.8s trend", {
      entryRaw: 0.38, deltaExtreme: 0.22, posBuy: 0.58, posSell: 0.42,
      minDecisive: 14, persistEnterMs: 1800, cooldownMs: 4500, minHoldM1: 8000,
      ageFrac: 0.10, ageMinMs: 7000, deltaAlpha: 0.09,
    } as Partial<SigTune>],
    ["2d FAST-GAUGE wide: raw.32 δ.16 a.09 minD12 age8% p1.4s trend", {
      entryRaw: 0.32, deltaExtreme: 0.16, posBuy: 0.56, posSell: 0.44,
      minDecisive: 12, persistEnterMs: 1400, cooldownMs: 4000, minHoldM1: 8000,
      ageFrac: 0.08, ageMinMs: 6000, deltaAlpha: 0.09,
    } as Partial<SigTune>],
    ["2e MID-GAUGE: raw.34 δ.18 a.07 minD12 age8% p1.3s trend", {
      entryRaw: 0.34, deltaExtreme: 0.18, posBuy: 0.56, posSell: 0.44,
      minDecisive: 12, persistEnterMs: 1300, cooldownMs: 4000, minHoldM1: 8000,
      ageFrac: 0.08, ageMinMs: 6000, deltaAlpha: 0.07,
    } as Partial<SigTune>],
  ];

  const fmt = (label: string, r: ReturnType<typeof run>) =>
    `${label.padEnd(58)} flips/h ${r.flipPerHour.toFixed(1).padStart(5)}  cov ${r.coverage.toFixed(0).padStart(3)}%  CONCUR ${r.concordPct.toFixed(0).padStart(3)}%  drift30s ${r.driftPct.toFixed(0).padStart(3)}% (${r.avgDriftPts >= 0 ? "+" : ""}${r.avgDriftPts.toFixed(0)}pt)  ep win ${r.epWinPct.toFixed(0).padStart(3)}% avg ${r.epAvgPts >= 0 ? "+" : ""}${r.epAvgPts.toFixed(0)}pt worstAdv ${r.worstAdverse.toFixed(0)}`;

  console.log("── REAL TAPE ──");
  for (const [label, tune] of variants) {
    if (!real.length) { console.log(`${label}: no real ticks`); continue; }
    try { console.log(fmt(label, run(real, digits, tune))); }
    catch (e) { console.log(`${label}: ERROR ${e}`); }
  }
  console.log("\n── SYNTH (reconstructed real bars — robustness check) ──");
  for (const [label, tune] of variants) {
    try { console.log(fmt(label, run(synth, digits, tune))); }
    catch (e) { console.log(`${label}: ERROR ${e}`); }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
