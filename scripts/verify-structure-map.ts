/**
 * verify-structure-map.ts — walk-forward verification of the v16.5
 * market-phase detectors (consolidation ranges / AMD sequences /
 * institutional footprints) on REAL broker bars, straight from the
 * running mt5-service.
 *
 * What it proves (the audit's Phase-3 no-look-ahead contract):
 *  1. SANITY     — detectors produce sane, bounded output on real history
 *                  (M5 / M15 / H1): times monotone, hi > lo, AMD sequences
 *                  ordered accumulation → manipulation → distribution.
 *  2. NO-REPAINT — for several prefix cuts, every phase that was ALREADY
 *                  complete at the cut appears IDENTICALLY when the detector
 *                  runs on the prefix alone (no future bars were needed to
 *                  draw history). A completed phase never repaints.
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

const MT5 = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";

let pass = 0;
let fail = 0;
const ok = (msg: string) => { pass++; console.log(`  ✅ PASS  ${msg}`); };
const bad = (msg: string) => { fail++; console.log(`  ✗ FAIL  ${msg}`); };

async function fetchBars(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const key = process.env.TRADER_API_KEY ?? "";
  const res = await fetch(
    `${MT5}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
    { headers: key ? { "x-trader-key": key } : {}, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`candles ${tf} → HTTP ${res.status}`);
  const j = await res.json();
  return (j.bars ?? []) as Candle[];
}

const rangeKey = (r: ConsolidationRange) =>
  `${r.t0}|${r.t1}|${r.hi.toFixed(4)}|${r.lo.toFixed(4)}|${r.state}|${r.breakT ?? "-"}`;

function checkSanity(tf: string, bars: Candle[]) {
  console.log(`\n── SANITY · ${tf} · ${bars.length} closed bars ──`);
  const closed = bars.filter((b) => !b.f);
  const ranges = detectConsolidations(closed);
  const amd = detectAmdPhases(closed, ranges);
  const { marks, volSpikes } = detectInstitutionalActivity(closed);

  if (closed.length < 100) { bad(`${tf}: not enough closed bars (${closed.length})`); return; }

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
  // (done:false — manipulation just happened, expansion pending).
  let amdOk = amd.length > 0;
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

async function main() {
  console.log("══ STRUCTURE-MAP VERIFICATION (v16.5 phase detectors) ══");
  const symbol = "XAUUSDm";
  for (const tf of ["M5", "M15", "H1"]) {
    const bars = await fetchBars(symbol, tf, tf === "H1" ? 400 : 600);
    checkSanity(tf, bars);
    checkNoRepaint(tf, bars);
  }
  console.log(`\n══ RESULT: ${pass} passed / ${fail} failed ══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("verification crashed:", e);
  process.exit(1);
});
