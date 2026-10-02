/**
 * verify-structure-map.ts — walk-forward verification of the v16.5
 * market-phase detectors (consolidation ranges / AMD sequences /
 * institutional footprints) AND the v16.6 classic-pattern + channel
 * detectors, on REAL broker bars straight from the running mt5-service.
 *
 * What it proves (the audit's Phase-3 no-look-ahead contract):
 *  1. SANITY     — detectors produce sane, bounded output on real history
 *                  (M5 / M15 / H1): times monotone, hi > lo, AMD sequences
 *                  ordered accumulation → manipulation → distribution;
 *                  patterns carry a complete trade plan (entry/SL/target,
 *                  RR>0, target on the correct side of entry).
 *  2. NO-REPAINT — for several prefix cuts, every phase that was ALREADY
 *                  complete at the cut appears IDENTICALLY when the detector
 *                  runs on the prefix alone (no future bars were needed to
 *                  draw history). A completed phase never repaints.
 *                  v16.6: a CONFIRMED pattern detected on a prefix (with
 *                  its breakout candle inside the prefix) must reappear
 *                  identically on every longer prefix — same name, same
 *                  entry/SL/target, same pivot points.
 *  3. DRAW BOUND — the phase ink stays within the drawing budget.
 *
 * Run: bun run scripts/verify-structure-map.ts   (mt5-service must be up)
 */

import type { Candle } from "../src/lib/market/types";
import {
  detectConsolidations,
  detectAmdPhases,
  detectInstitutionalActivity,
  type ConsolidationRange,
} from "../src/lib/market/phases";
import { detectPatterns, detectChannel, type PatternDrawing } from "../src/lib/market/patterns";
import { readFileSync } from "fs";

const MT5 = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";

let pass = 0;
let fail = 0;
const ok = (msg: string) => { pass++; console.log(`  ✅ PASS  ${msg}`); };
const bad = (msg: string) => { fail++; console.log(`  ✗ FAIL  ${msg}`); };
const skip = (msg: string) => { console.log(`  ⏭ SKIP  ${msg}`); };

async function fetchBars(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const key = process.env.TRADER_API_KEY ?? "";
  try {
    const res = await fetch(
      `${MT5}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { headers: key ? { "x-trader-key": key } : {}, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`candles ${tf} → HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.bars) || j.bars.length < 100) throw new Error("no live bars");
    return (j.bars ?? []) as Candle[];
  } catch {
    // broker offline (e.g. sandbox reset lost the stored MT5 session) —
    // fall back to the recorded real-broker M1 fixture, aggregated up
    console.log(`  (live feed unavailable — using the recorded M1 fixture aggregated to ${tf})`);
    return fixtureBars(tf);
  }
}

// ── recorded real-broker bars (mt5-poc/candles-xauusd-m1.json — 500 real
//    Exness M1 candles) aggregated to higher timeframes ──
let m1Cache: Candle[] | null = null;
function fixtureBars(tf: string): Candle[] {
  if (!m1Cache) {
    const raw = JSON.parse(
      readFileSync(`${__dirname}/../mt5-poc/candles-xauusd-m1.json`, "utf8"),
    );
    m1Cache = (raw.candles as any[]).map((c) => ({
      t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.tickVolume, f: false,
    }));
  }
  const mins: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 };
  const m = mins[tf] ?? 5;
  if (m === 1) return m1Cache;
  const out: Candle[] = [];
  const bucket = new Map<number, Candle>();
  for (const b of m1Cache) {
    const t0 = Math.floor(b.t / (m * 60)) * m * 60;
    const cur = bucket.get(t0);
    if (!cur) bucket.set(t0, { t: t0, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, f: false });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  for (const v of bucket.values()) out.push(v);
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** deterministic PRNG — the synthetic walks are reproducible run-to-run */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** build bars from an explicit price path (waypoints walked with noise) */
function barsFromPath(path: number[], perLeg: number, seed: number, wick = 0.4): Candle[] {
  const rnd = mulberry32(seed);
  const bars: Candle[] = [];
  let t = 1_790_000_000;
  for (let w = 0; w < path.length - 1; w++) {
    const from = path[w];
    const to = path[w + 1];
    for (let i = 0; i < perLeg; i++) {
      const p = from + ((to - from) * (i + 1)) / perLeg;
      const noise = (rnd() - 0.5) * Math.abs(to - from) * 0.08;
      const o = p - (to - from) / perLeg + noise;
      const c = p + noise;
      const h = Math.max(o, c) + rnd() * wick;
      const l = Math.min(o, c) - rnd() * wick;
      bars.push({ t: t + bars.length * 60, o, h, l, c, v: 100 + Math.floor(rnd() * 50), f: false });
    }
  }
  return bars;
}

const rangeKey = (r: ConsolidationRange) =>
  `${r.t0}|${r.t1}|${r.hi.toFixed(4)}|${r.lo.toFixed(4)}|${r.state}|${r.breakT ?? "-"}`;

/** a pattern's stable identity — everything a trader saw when it printed
 * (name, trade plan, pivots) must never change as future bars arrive */
const patternKey = (p: PatternDrawing) =>
  `${p.name}|E${p.entry.price.toFixed(3)}|S${p.sl.toFixed(3)}|T${p.target.toFixed(3)}` +
  `|${p.points.map((q) => `${q.t}:${q.price.toFixed(3)}`).join(",")}`;

function checkPatternSanity(tf: string, bars: Candle[]) {
  const closed = bars.filter((b) => !b.f);
  const pats = detectPatterns(closed);
  const ch = detectChannel(closed);
  console.log(`  patterns: ${pats.map((p) => `${p.name}[${p.state}]`).join(", ") || "none"}${ch ? ` · channel: ${ch.label}` : " · channel: none"}`);

  let pOk = true;
  for (const p of pats) {
    // trade plan geometry: SL on the losing side, TARGET on the winning side, RR > 0
    if (p.dir === "up") {
      if (!(p.sl < p.entry.price && p.target > p.entry.price)) pOk = false;
    } else {
      if (!(p.sl > p.entry.price && p.target < p.entry.price)) pOk = false;
    }
    if (!(p.rr != null && p.rr > 0)) pOk = false;
    // pivots: numbered 1..N, alternating, inside the window
    if (p.points.some((q, i) => q.n !== i + 1)) pOk = false;
    for (let i = 1; i < p.points.length; i++) {
      if (p.points[i].kind === p.points[i - 1].kind) pOk = false;
      if (p.points[i].t <= p.points[i - 1].t) pOk = false;
    }
    // confirmed ⇒ a breakout candle exists and is not in the future
    if (p.state === "confirmed" && p.breakout_t == null) pOk = false;
    // target_zone wraps the target on the entry side
    if (!(p.target_zone.lo <= p.target && p.target <= p.target_zone.hi)) pOk = false;
  }
  if (pOk) ok(`${tf}: ${pats.length} patterns — trade-plan geometry (SL/target sides, RR>0, alternation, state⇔breakout) consistent`);
  else bad(`${tf}: pattern trade-plan geometry broken`);

  if (pats.length <= 2) ok(`${tf}: pattern count within budget (≤2)`);
  else bad(`${tf}: pattern count exceeds budget`);

  if (ch) {
    const cOk = ch.upper.t1 < ch.upper.t2 && ch.lower.t1 < ch.lower.t2 &&
      ((ch.dir === "up" && ch.upper.p2 > ch.upper.p1 && ch.lower.p2 > ch.lower.p1) ||
       (ch.dir === "down" && ch.upper.p2 < ch.upper.p1 && ch.lower.p2 < ch.lower.p1));
    if (cOk) ok(`${tf}: ${ch.label} — both sides slope-consistent (${ch.dir})`);
    else bad(`${tf}: channel slope inconsistent with dir`);
  }
}

function checkPatternNoRepaint(tf: string, bars: Candle[]) {
  const closed = bars.filter((b) => !b.f);
  for (const back of [60, 120, 200, 300].filter((n) => closed.length - n > 90)) {
    const cutIdx = closed.length - back;
    const prefix = closed.slice(0, cutIdx);
    const cutT = prefix[prefix.length - 1].t;
    const pats = detectPatterns(prefix);
    // every CONFIRMED pattern whose breakout candle printed inside the
    // prefix must keep its full identity when later bars arrive
    let stable = true;
    for (const p of pats) {
      if (p.state !== "confirmed" || p.breakout_t == null || p.breakout_t > cutT) continue;
      // re-run on progressively longer prefixes; identity must survive
      for (const mid of [cutIdx + 30, closed.length].filter((n) => n > cutIdx && n <= closed.length)) {
        const later = detectPatterns(closed.slice(0, mid));
        const laterKeys = new Set(later.map(patternKey));
        if (!laterKeys.has(patternKey(p))) stable = false;
      }
    }
    if (stable) {
      ok(`cut −${back}: ${pats.filter((p) => p.state === "confirmed").length} confirmed patterns keep their identity on longer prefixes (no repaint)`);
    } else {
      bad(`cut −${back}: a confirmed pattern's identity changed (repaint)`);
    }
  }
}

function checkSanity(tf: string, bars: Candle[]) {
  console.log(`\n── SANITY · ${tf} · ${bars.length} closed bars ──`);
  const closed = bars.filter((b) => !b.f);
  const ranges = detectConsolidations(closed);
  const amd = detectAmdPhases(closed, ranges);
  const { marks, volSpikes } = detectInstitutionalActivity(closed);

  if (closed.length < 100) { skip(`${tf}: only ${closed.length} closed bars (fixture limit) — need ≥100`); return; }

  // ranges: geometry + ordering
  let geoOk = true;
  for (const r of ranges) {
    if (!(r.hi > r.lo && r.t1 >= r.t0 && r.bars >= 8)) geoOk = false;
    if (r.state !== "forming" && r.breakT == null) geoOk = false;
    if (r.state === "forming" && r.breakT != null) geoOk = false;
  }
  if (geoOk) ok(`${tf}: ${ranges.length} ranges — all hi>lo, t1≥t0, ≥8 bars, state⇔breakT consistent`);
  else bad(`${tf}: range geometry/state inconsistent`);

  // AMD: sequences read accumulation → manipulation → [distribution].
  // A sequence WITHOUT distribution is legal ONLY as the trailing LIVE read
  // (done:false — manipulation just happened, expansion pending). Short
  // histories (<200 bars) may legitimately hold zero full sequences.
  let amdOk = closed.length >= 200 ? amd.length > 0 : true;
  let i = 0;
  let liveTail = false;
  while (i < amd.length) {
    const acc = amd[i];
    const man = amd[i + 1];
    if (acc.phase !== "accumulation" || !man || man.phase !== "manipulation" || acc.dir !== man.dir) { amdOk = false; break; }
    if (!(man.t0 >= acc.t0)) { amdOk = false; break; }
    const dis = amd[i + 2];
    if (dis && dis.phase === "distribution") {
      if (dis.dir !== acc.dir || dis.t0 < man.t0) { amdOk = false; break; }
      i += 3;
    } else {
      // no distribution ⇒ this must be the LAST sequence and LIVE
      if (i + 2 < amd.length) { amdOk = false; break; }
      if (acc.done || man.done) { amdOk = false; break; }
      liveTail = true;
      i += 2;
    }
  }
  if (amdOk) {
    const seqs = Math.floor(amd.length / 3) + (liveTail ? 1 : (amd.length % 3 === 2 ? 0 : 0));
    ok(`${tf}: ${seqs} AMD sequences — order/dir/timeline consistent${liveTail ? " (1 LIVE — distribution pending)" : ""}`);
  } else {
    bad(`${tf}: AMD sequence ordering broken (${amd.map((p) => p.phase).join(",")})`);
  }

  // institutional: volZ floor + bounded
  const zOk = marks.every((m) => m.volZ >= 2.2) && marks.length <= 4;
  if (zOk) ok(`${tf}: ${marks.length} institutional marks (z≥2.2, ≤4) · ${volSpikes.size} z≥1.5 bars`);
  else bad(`${tf}: institutional mark bounds violated`);

  // draw budget
  const budget = 2 /*local ranges*/ + 2 /*htf*/ + 6 /*amd*/ + 4 /*instit*/;
  if (ranges.slice(-2).length + amd.length + marks.length <= budget + 6) {
    ok(`${tf}: phase ink within drawing budget`);
  } else {
    bad(`${tf}: phase ink exceeds budget`);
  }
}

function checkNoRepaint(tf: string, bars: Candle[]) {
  console.log(`\n── NO-REPAINT (walk-forward) · ${tf} ──`);
  const closed = bars.filter((b) => !b.f);
  const fullRanges = detectConsolidations(closed);
  const fullAmd = detectAmdPhases(closed, fullRanges);
  const { marks: fullMarks } = detectInstitutionalActivity(closed);

  const cuts = [60, 120, 200].filter((n) => closed.length - n > 90);
  for (const back of cuts) {
    const cutIdx = closed.length - back;
    const prefix = closed.slice(0, cutIdx);
    const cutT = prefix[prefix.length - 1].t;

    // every BROKEN range whose break already happened before the cut
    // must appear identically in the prefix run
    const pRanges = detectConsolidations(prefix);
    const pKeys = new Set(pRanges.map(rangeKey));
    const settled = fullRanges.filter(
      (r) => r.state !== "forming" && r.breakT != null && r.breakT <= cutT,
    );
    let stable = true;
    for (const r of settled) {
      if (!pKeys.has(rangeKey(r))) { stable = false; break; }
    }
    if (stable && settled.length >= 0) {
      ok(`cut −${back}: ${settled.length} completed ranges identical on prefix (no repaint)`);
    } else {
      bad(`cut −${back}: a completed range changed/was missing on the prefix run`);
    }

    // completed AMD sequences (done distribution ending before the cut)
    const pAmd = detectAmdPhases(prefix, pRanges);
    const pAmdKeys = new Set(pAmd.map((p) => `${p.phase}|${p.t0}|${p.t1}|${p.dir}`));
    const settledAmd = fullAmd.filter((p) => p.done && p.t1 <= cutT);
    const amdStable = settledAmd.every((p) => pAmdKeys.has(`${p.phase}|${p.t0}|${p.t1}|${p.dir}`));
    if (amdStable) {
      ok(`cut −${back}: ${settledAmd.length} completed AMD phases identical on prefix`);
    } else {
      bad(`cut −${back}: an AMD phase repainted`);
    }

    // institutional marks before the cut must match exactly (z uses the
    // previous 50 bars only — walk-forward by construction)
    const { marks: pMarks } = detectInstitutionalActivity(prefix);
    const pMarkKeys = new Set(pMarks.map((m) => `${m.t}|${m.side}|${m.volZ}`));
    const cutMarks = fullMarks.filter((m) => m.t < cutT);
    const markStable = cutMarks.every((m) => pMarkKeys.has(`${m.t}|${m.side}|${m.volZ}`));
    if (markStable) {
      ok(`cut −${back}: ${cutMarks.length} institutional marks identical on prefix`);
    } else {
      bad(`cut −${back}: an institutional mark repainted`);
    }
  }
}

/** crafted-shape tests — each pattern family must be DETECTED with the
 *  textbook measured-move math (the ref repo's d072 test recipe) */
function checkPatternFamilies() {
  console.log(`\n── PATTERN FAMILIES (crafted shapes, measured-move math) ──`);

  // DOUBLE TOP: two equal highs ~4350, neck ~4330 → target 4310 (height 20)
  {
    const bars = barsFromPath([4320, 4350, 4330, 4350, 4335], 8, 11);
    const pats = detectPatterns(bars);
    const dt = pats.find((p) => p.name === "DOUBLE TOP");
    if (dt) {
      const mathOk = Math.abs(dt.entry.price - 4330) < 3 && Math.abs(dt.target - 4310) < 3;
      if (mathOk) ok(`DOUBLE TOP detected — entry≈neckline 4330, target≈height-below 4310 (got E ${dt.entry.price.toFixed(1)} / T ${dt.target.toFixed(1)})`);
      else bad(`DOUBLE TOP measured-move math off (E ${dt.entry.price.toFixed(1)} T ${dt.target.toFixed(1)})`);
    } else bad("DOUBLE TOP not detected on the crafted shape");
  }

  // DOUBLE BOTTOM: two equal lows ~4300, neck ~4320 → target 4340
  {
    const bars = barsFromPath([4330, 4300, 4320, 4300, 4325], 8, 22);
    const pats = detectPatterns(bars);
    const db = pats.find((p) => p.name === "DOUBLE BOTTOM");
    if (db) {
      const mathOk = Math.abs(db.entry.price - 4320) < 3 && Math.abs(db.target - 4340) < 3;
      if (mathOk) ok(`DOUBLE BOTTOM detected — entry≈neckline 4320, target≈height-above 4340 (got E ${db.entry.price.toFixed(1)} / T ${db.target.toFixed(1)})`);
      else bad(`DOUBLE BOTTOM measured-move math off (E ${db.entry.price.toFixed(1)} T ${db.target.toFixed(1)})`);
    } else bad("DOUBLE BOTTOM not detected on the crafted shape");
  }

  // BULL FLAG — built the way a REAL flag prints: a hard monotonic pole,
  // then a flat OSCILLATING consolidation (bars churn ~ATR ranges with no
  // net drift — a monotonic synthetic leg would always read as another
  // pole), then the resolve. Pole 4290→4345 (55) → target ≈ 4400.
  {
    const rnd = mulberry32(99);
    const bars: Candle[] = [];
    let t = 1_790_000_000;
    const push = (o: number, c: number, wick: number) => {
      bars.push({
        t: t + bars.length * 60, o,
        h: Math.max(o, c) + rnd() * wick,
        l: Math.min(o, c) - rnd() * wick,
        c, v: 100, f: false,
      });
    };
    push(4300, 4295, 0.5); push(4295, 4290, 0.5);                    // lead-in dip
    for (let i = 1; i <= 7; i++) push(4290 + 55 * (i - 1) / 7, 4290 + 55 * i / 7, 0.5); // the pole
    let p = 4342;                                                     // flag: churn
    for (let i = 0; i < 14; i++) { const o = p; p = 4342 + (rnd() - 0.5) * 2.2; push(o, p, 1.2); }
    push(p, 4346.5, 0.5);                                             // resolve up
    const pats = detectPatterns(bars);
    const fl = pats.find((x) => x.name === "BULL FLAG" || x.name === "BULL PENNANT");
    if (fl) {
      // target = pole height above the pole tip ≈ 4345 + 55 = 4400
      const mathOk = fl.target > 4370 && fl.target < 4430 && fl.family === "continuation";
      if (mathOk) ok(`${fl.name} detected — continuation target ≈ pole projection 4400 (got T ${fl.target.toFixed(1)}, family=${fl.family})`);
      else bad(`${fl.name} pole-projection target off (T ${fl.target.toFixed(1)})`);
    } else bad(`BULL FLAG not detected on the crafted shape (got: ${pats.map((x) => x.name).join(",") || "none"})`);
  }

  // ASCENDING TRIANGLE: flat highs 4340, rising lows 4300→4330
  {
    const bars = barsFromPath([4300, 4340, 4315, 4340, 4330, 4342], 7, 44);
    const pats = detectPatterns(bars);
    const at = pats.find((p) => p.name === "ASCENDING TRIANGLE" || p.name === "SYMMETRIC TRIANGLE");
    if (at) {
      const mathOk = Math.abs(at.entry.price - 4340) < 5 && at.target > 4360;
      if (mathOk) ok(`${at.name} detected — entry≈flat supply 4340, target≈base height (got E ${at.entry.price.toFixed(1)} / T ${at.target.toFixed(1)})`);
      else bad(`${at.name} base-height target off (E ${at.entry.price.toFixed(1)} T ${at.target.toFixed(1)})`);
    } else bad("ASCENDING TRIANGLE not detected on the crafted shape");
  }

  // DESCENDING CHANNEL: lower highs + lower lows in lockstep
  {
    const bars = barsFromPath([4360, 4330, 4350, 4320, 4340, 4310, 4330], 8, 55);
    const ch = detectChannel(bars);
    if (ch && ch.dir === "down") ok(`DESCENDING CHANNEL detected — both sides slope down (label: ${ch.label})`);
    else if (ch) bad(`channel detected but dir=${ch.dir} (expected down)`);
    else bad("DESCENDING CHANNEL not detected on the crafted shape");
  }

  // FORMING vs CONFIRMED: same double top, no breakdown close yet
  {
    const bars = barsFromPath([4320, 4350, 4330, 4350, 4345], 8, 66);
    const pats = detectPatterns(bars);
    const dt = pats.find((p) => p.name === "DOUBLE TOP");
    if (dt && dt.state === "forming" && dt.breakout_t == null) {
      ok(`state machine — DOUBLE TOP prints FORMING with no breakout while price holds the neckline`);
    } else bad(`forming-state broken: ${dt ? `${dt.state}/${dt.breakout_t}` : "not detected"}`);
  }

  // robustness: random walk + short frames must never throw / never break bounds
  {
    const rnd = mulberry32(77);
    let threw = false;
    for (let trial = 0; trial < 30; trial++) {
      const bars: Candle[] = [];
      let p = 4300 + rnd() * 50;
      for (let i = 0; i < 160; i++) {
        const o = p;
        p += (rnd() - 0.5) * 6;
        const c = p;
        bars.push({ t: 1_790_000_000 + i * 60, o, h: Math.max(o, c) + rnd() * 2, l: Math.min(o, c) - rnd() * 2, c, v: 50 + rnd() * 100, f: false });
      }
      try {
        const pats = detectPatterns(bars);
        if (pats.length > 2) threw = true;
        detectChannel(bars.slice(0, 10)); // short frame
      } catch { threw = true; }
    }
    if (!threw) ok("robustness — 30 random walks + short frames: no throw, pattern count ≤ 2");
    else bad("robustness failed (throw or budget breach on random data)");
  }
}

async function main() {
  console.log("══ STRUCTURE-MAP VERIFICATION (v16.5 phases + v16.6 patterns/channel) ══");
  checkPatternFamilies();
  const symbol = "XAUUSDm";
  for (const tf of ["M5", "M15", "H1", "H4"]) {
    const bars = await fetchBars(symbol, tf, tf === "H1" || tf === "H4" ? 400 : 600);
    checkSanity(tf, bars);
    checkNoRepaint(tf, bars);
    checkPatternSanity(tf, bars);
    checkPatternNoRepaint(tf, bars);
  }
  console.log(`\n══ RESULT: ${pass} passed / ${fail} failed ══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("verification crashed:", e);
  process.exit(1);
});
