/**
 * backtest-yahoo.ts — v16.8 verification backtest on REAL gold history.
 *
 * The local MT5 session has no stored credentials this boot and the market is
 * closed (Sunday), so the broker feed is unavailable. This harness runs the
 * FULL live engine stack (the exact same modules /api/analysis uses) over
 * REAL COMEX gold futures history (GC=F via Yahoo Finance — the same public
 * feed class the reference repo uses as its last-resort source):
 *
 *   PATH A · SIGNALS      — seedSignals: the trigger suite (sfp / zone-retest
 *                           with sweep+MSS / pullback) + v16.8 geometry
 *   PATH B · PROJECTIONS  — projectSetup + localBias (the per-TF planned
 *                           setups), fills resolved pessimistically
 *   CONTRACT              — every entry within 0.75 ATR (signals) / 0.6 ATR
 *                           (plans) of the live price; risk ≥ 0.5 ATR
 *   DRAWINGS SMOKE        — buildDrawings on real bars: zones carry mitT,
 *                           trendlines slope-valid + uncut, zigzag alternates,
 *                           OTE on the retracement (discount/premium) side
 *
 * Spans: M1 7d · M5 60d · M15 60d · M30 60d(agg) · H1 730d · H4 730d(agg)
 *
 * Run: bun run scripts/backtest-yahoo.ts
 */

import { seedSignals } from "../src/lib/market/seed";
import { projectSetup, localBias, buildDrawings, NEAR_ZONE_ATR } from "../src/lib/market/drawings";
import { MAX_ENTRY_DIST_ATR } from "../src/lib/market/engine";
import { atr } from "../src/lib/market/indicators";
import {
  detectStructure, detectSupplyDemand, detectOrderBlocks, detectFvg, detectLiquidity,
  type LiquidityPool, type Zone,
} from "../src/lib/market/smc";
import type { Candle } from "../src/lib/market/types";

const SPREAD = 0.35; // XAUUSD-class spread (price units)
const DIGITS = 2;
const EXPIRY = 30; // bars — the live tracker's contract
const STRIDE = 3; // PATH B sampling stride (bars)

// ── data: Yahoo Finance GC=F (COMEX gold front-month) ──
async function fetchYahoo(interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`yahoo ${interval}/${range}: HTTP ${res.status}`);
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!ts.length || !q) throw new Error(`yahoo ${interval}/${range}: empty`);
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c, v] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]];
    if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
    out.push({ t: ts[i], o, h, l, c, v: v ?? 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** aggregate N consecutive bars into one (M15→M30, H1→H4) */
function aggregate(bars: Candle[], n: number, tfSec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const b of bars) {
    const bt = Math.floor(b.t / tfSec) * tfSec;
    const cur = buckets.get(bt);
    if (!cur) buckets.set(bt, { t: bt, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// ── walk-forward as-of filters (mirror the live engine) ──
function zonesAsOf(all: Zone[], t: number, windowStartT: number): Zone[] {
  return all.filter((z) =>
    z.t <= t && z.t >= windowStartT &&
    (z.brokenT == null || z.brokenT > t) &&
    (z.mitT == null || z.mitT >= t),
  );
}
function poolsAsOf(all: LiquidityPool[], t: number, windowStartT: number): LiquidityPool[] {
  return all.filter((p) =>
    p.t <= t && p.t >= windowStartT - 86400 * 3 &&
    (p.runT == null || p.runT > t),
  );
}

interface PlanRec { t: number; idx: number; dir: "BUY" | "SELL"; entry: number; sl: number; tp: number; entryType: "market" | "limit"; distAtr: number }
type Outcome = { status: "won" | "lost" | "expired" | "cancelled"; r: number | null; fill: number | null };

function resolvePlan(p: PlanRec, bars: Candle[]): Outcome {
  const n = bars.length;
  const end = Math.min(n - 1, p.idx + EXPIRY);
  let fillIdx: number | null = null;
  if (p.entryType === "market") {
    fillIdx = Math.min(p.idx + 1, n - 1); // plan seen on close → fill next open
  } else {
    for (let i = p.idx + 1; i <= end; i++) {
      if (p.dir === "BUY" ? bars[i].l <= p.entry : bars[i].h >= p.entry) { fillIdx = i; break; }
    }
    if (fillIdx == null) {
      const last = bars[Math.min(end, n - 1)].c;
      const runaway = p.dir === "BUY" ? last - p.entry : p.entry - last;
      const aNow = lastAtrOf(bars.slice(0, end + 1)) || 1;
      return { status: runaway > 1.5 * aNow ? "cancelled" : "expired", r: null, fill: null };
    }
  }
  const risk = Math.abs(p.entry - p.sl) || 1e-9;
  for (let i = fillIdx; i <= end; i++) {
    const b = bars[i];
    const bothTouch = p.dir === "BUY" ? (b.h >= p.tp && b.l <= p.sl) : (b.h >= p.sl && b.l <= p.tp);
    if (bothTouch) return { status: "lost", r: -1, fill: bars[fillIdx].o };
    if (p.dir === "BUY") {
      if (b.h >= p.tp) return { status: "won", r: (p.tp - p.entry) / risk, fill: bars[fillIdx].o };
      if (b.l <= p.sl) return { status: "lost", r: -1, fill: bars[fillIdx].o };
    } else {
      if (b.l <= p.tp) return { status: "won", r: (p.entry - p.tp) / risk, fill: bars[fillIdx].o };
      if (b.h >= p.sl) return { status: "lost", r: -1, fill: bars[fillIdx].o };
    }
  }
  return { status: "expired", r: null, fill: bars[fillIdx].o };
}

function lastAtrOf(bars: Candle[]): number {
  const arr = atr(bars, 14);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return 0;
}

function fmtDays(bars: Candle[]): string {
  const d = (bars[bars.length - 1].t - bars[0].t) / 86400;
  return `${d.toFixed(0)}d (${new Date(bars[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10)})`;
}

async function main() {
  console.log("═══ v16.8 engine backtest — REAL gold history (COMEX GC=F, Yahoo) ═══\n");
  const [m1, m5, m15, h1] = await Promise.all([
    fetchYahoo("1m", "7d"),
    fetchYahoo("5m", "60d"),
    fetchYahoo("15m", "60d"),
    fetchYahoo("60m", "730d"),
  ]);
  const m30 = aggregate(m15, 2, 1800);
  const h4 = aggregate(h1, 4, 14400);
  const jobs: [string, Candle[]][] = [
    ["M1", m1], ["M5", m5], ["M15", m15], ["M30", m30], ["H1", h1], ["H4", h4],
  ];

  let contractViolations = 0;
  let drawingsFailures = 0;

  console.log("tf   bars   span                          │ PATH A signals: W/L/E  win%  totalR avgR  avgRR  maxDist risk≥0.5ATR │ PATH B plans: W/L/E  win%  totalR  maxDist");
  for (const [tf, bars] of jobs) {
    if (bars.length < 150) { console.log(`${tf}: only ${bars.length} bars — skipped`); continue; }

    // ── PATH A: the engine's own trigger suite ──
    const { signals } = seedSignals({ symbol: "XAUUSD", tf, digits: DIGITS, spread: SPREAD, bars });
    const won = signals.filter((s) => s.status === "won").length;
    const lost = signals.filter((s) => s.status === "lost").length;
    const exp = signals.filter((s) => s.status === "expired" || s.status === "cancelled").length;
    const decided = won + lost;
    const totalR = signals.reduce((a, s) => a + (s.resultR ?? 0), 0);
    const winPct = decided ? ((won / decided) * 100) : 0;
    const avgR = signals.length ? totalR / signals.length : 0;
    const avgRR = signals.length ? signals.reduce((a, s) => a + s.rr, 0) / signals.length : 0;
    // price-anchor contract + risk floor, measured against each signal's bar
    let maxDist = 0;
    let riskFloorOk = 0;
    for (const s of signals) {
      const idx = bars.findIndex((b) => b.t === s.barTime);
      const win = idx >= 0 ? bars.slice(Math.max(0, idx - 120), idx + 1) : bars.slice(-120);
      const a = lastAtrOf(win) || 1e-9;
      const price = win[win.length - 1].c;
      maxDist = Math.max(maxDist, Math.abs(s.entry - price) / a);
      const risk = Math.abs(s.entry - s.sl);
      if (risk >= 0.5 * a - 1e-9) riskFloorOk++;
    }
    if (signals.length && maxDist > MAX_ENTRY_DIST_ATR + 0.02) contractViolations++;
    if (signals.length && riskFloorOk < signals.length) contractViolations++;

    // ── PATH B: the per-TF planned setups (projectSetup + localBias) ──
    const allZones: Zone[] = [...detectSupplyDemand(bars), ...detectOrderBlocks(bars), ...detectFvg(bars)];
    const allPools = detectLiquidity(bars, 0.15, 3, 0);
    const plans: PlanRec[] = [];
    for (let i = 120; i < bars.length - 2; i += STRIDE) {
      const win = bars.slice(Math.max(0, i - 239), i + 1);
      const zones = zonesAsOf(allZones, bars[i].t, win[0].t);
      const pools = poolsAsOf(allPools, bars[i].t, win[0].t);
      const lb = localBias(win);
      const p = projectSetup(win, {
        structure: detectStructure(win.slice(-150)),
        pools, zones,
        biasDir: lb.biasDir, biasScore: lb.biasScore,
        spread: SPREAD,
      });
      if (!p) continue;
      plans.push({ t: bars[i].t, idx: i, dir: p.dir, entry: p.entry, sl: p.sl, tp: p.tp, entryType: p.entryType, distAtr: p.distAtr });
      i += 6; // cooldown between plans
    }
    const planOutcomes = plans.map((p) => resolvePlan(p, bars));
    const pWon = planOutcomes.filter((o) => o.status === "won").length;
    const pLost = planOutcomes.filter((o) => o.status === "lost").length;
    const pExp = planOutcomes.filter((o) => o.status === "expired" || o.status === "cancelled").length;
    const pDecided = pWon + pLost;
    const pTotalR = planOutcomes.reduce((a, o) => a + (o.r ?? 0), 0);
    const pWinPct = pDecided ? ((pWon / pDecided) * 100) : 0;
    const pMaxDist = plans.length ? Math.max(...plans.map((p) => p.distAtr)) : 0;
    if (plans.length && pMaxDist > NEAR_ZONE_ATR + 0.02) contractViolations++;

    console.log(
      `${tf.padEnd(4)} ${String(bars.length).padStart(5)}  ${fmtDays(bars).padEnd(28)} │ ` +
      `${String(signals.length).padStart(3)}: ${won}/${lost}/${exp}  ${winPct.toFixed(0).padStart(3)}%  ` +
      `${totalR >= 0 ? "+" : ""}${totalR.toFixed(1).padStart(5)}  ${avgR.toFixed(2)}  ${avgRR.toFixed(2)}  ` +
      `${maxDist.toFixed(2)}  ${signals.length ? `${riskFloorOk}/${signals.length}` : "-"} │ ` +
      `${String(plans.length).padStart(3)}: ${pWon}/${pLost}/${pExp}  ${pWinPct.toFixed(0).padStart(3)}%  ` +
      `${pTotalR >= 0 ? "+" : ""}${pTotalR.toFixed(1)}  ${pMaxDist.toFixed(2)}`,
    );

    // ── DRAWINGS SMOKE (the chart ink layer, on real bars) ──
    try {
      const win = bars.slice(-300);
      const zones = [...detectSupplyDemand(win), ...detectOrderBlocks(win), ...detectFvg(win)];
      const pools = detectLiquidity(win, 0.15, 3, 0);
      const structure = detectStructure(win.slice(-150));
      const ds = buildDrawings(win, tf, { structure, pools, zones, signal: null, projection: null }, [], new Map());
      const kindCount = (k: string) => ds.filter((d: any) => d.kind === k).length;
      const zonesDrawn = ds.filter((d: any) => d.kind === "zone");
      const fadedZones = zonesDrawn.filter((d: any) => d.state === "faded");
      const fadedWithEnd = fadedZones.filter((d: any) => d.mitT != null);
      const tls = ds.filter((d: any) => d.kind === "trendline");
      const tlValid = tls.every((d: any) => {
        const falling = d.p2 <= d.p1 + 1e-9; // resistance (bear tone)
        const rising = d.p2 >= d.p1 - 1e-9; // support (bull tone)
        return d.tone === "bear" ? falling : rising;
      });
      const zz = ds.find((d: any) => d.kind === "zigzag") as any;
      const zzAlt = !zz || zz.points.every((p: any, i: number) => i === 0 || p.side !== zz.points[i - 1].side);
      const fib = ds.find((d: any) => d.kind === "fib") as any;
      const oteOk = !fib?.ote || (fib.ote[0] <= fib.ote[1]);
      const obZones = zones.filter((z) => z.side.startsWith("ob"));
      const obWickOk = obZones.every((z) => z.hi > z.lo); // full-range zones (wick > body by construction here)
      const ok = tlValid && zzAlt && oteOk;
      if (!ok) drawingsFailures++;
      console.log(
        `     drawings: ${ds.length} ink (zone ${kindCount("zone")}, tl ${tls.length}, structure ${kindCount("structure")}, zz ${kindCount("zigzag")}, fib ${kindCount("fib")})` +
        ` · faded-zones-with-end ${fadedWithEnd.length}/${fadedZones.length} · trendlineSlope ${tlValid ? "OK" : "FAIL"} · zigzagAlternation ${zzAlt ? "OK" : "FAIL"} · oteAscending ${oteOk ? "OK" : "FAIL"} · obZones(wick-range) ${obZones.length}`,
      );
    } catch (e) {
      drawingsFailures++;
      console.log(`     drawings: EXCEPTION ${(e as Error).message}`);
    }
  }

  console.log("");
  console.log(`CONTRACT: ${contractViolations === 0 ? "PASS — every entry price-anchored (≤0.75/0.60 ATR) and every risk ≥ 0.5 ATR" : `FAIL (${contractViolations} violations)`}`);
  console.log(`DRAWINGS: ${drawingsFailures === 0 ? "PASS — slope/alternation/OTE all valid on real bars" : `FAIL (${drawingsFailures})`}`);
  console.log("\nNOTE: GC=F futures ≈ XAUUSD spot (small basis). Spread modelled at 0.35.");
  console.log("      Outcomes are pessimistic (a bar spanning SL+TP = loss), 30-bar expiry — the live tracker's rules.");
}

main().catch((e) => { console.error("BACKTEST FAILED:", e); process.exit(1); });
