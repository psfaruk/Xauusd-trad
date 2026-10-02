/**
 * entry-backtest.ts — v16.7 PRICE-ANCHORED ENTRY CONTRACT verification.
 *
 * User spec: "প্রয়োজন হলে কয়েক মাসের ডেটা দিয়ে backtest করে দেখো। সকল
 * টাইম ফ্রেম এর লাইভ রিয়েল ডেটা নিয়ে" — walk BOTH entry paths of the live
 * app over MONTHS of real Exness history per timeframe, straight from the
 * broker (a throw-away websocket session, the same one-shot pattern the
 * service's testCredentials uses — never touching the live session):
 *
 *   PATH A · SIGNALS      — the engine's trigger suite (sfp/zone/pullback)
 *                           through seedSignals → the NEW clamped geometry
 *                           (entry ≤ 0.75 ATR from price, else confirmation
 *                           entry AT price).
 *   PATH B · PROJECTIONS  — the chart's planned setups (projectSetup +
 *                           localBias, the exact code the /api/analysis
 *                           route runs per timeframe): market plans fill at
 *                           the NEXT bar's open (you see the plan on close,
 *                           enter on the next tick), near-zone limits fill
 *                           when price trades through.
 *
 * Resolution is pessimistic everywhere (a bar spanning SL and TP = loss),
 * 30-bar expiry like the live tracker, and the report proves the contract:
 * max |entry − price|/ATR must stay ≤ 0.75 (signals) / 0.60 (plans).
 *
 * Run (from mini-services/mt5-service so the credential store resolves):
 *   cd mini-services/mt5-service && bun run ../../scripts/entry-backtest.ts
 * Falls back to the service REST feed (latest 3000 bars per tf) when no
 * stored credentials are available.
 */

import { seedSignals } from "../src/lib/market/seed";
import { projectSetup, localBias, NEAR_ZONE_ATR } from "../src/lib/market/drawings";
import { MAX_ENTRY_DIST_ATR } from "../src/lib/market/engine";
import { atr } from "../src/lib/market/indicators";
import { detectStructure, detectSupplyDemand, detectOrderBlocks, detectFvg, detectLiquidity, type LiquidityPool, type Zone } from "../src/lib/market/smc";
import type { Candle } from "../src/lib/market/types";
import { Mt5WsClient, TF_CODE } from "../mini-services/mt5-service/src/mt5-client";
import { loadCredentials } from "../mini-services/mt5-service/src/credentials";
import { resolveGateways } from "../mini-services/mt5-service/src/manager";

const SYMBOL = process.argv[2] ?? "XAUUSDm";
const REST = "http://127.0.0.1:3031";
/** deep windows per tf (days) — "a few months" of real data everywhere */
const DEEP_DAYS: Record<string, number> = { M1: 45, M5: 90, M15: 180, M30: 240, H1: 365, H4: 730 };
const TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];
const TF_SEC: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };
const SPREAD = 0.3; // XAUUSDm typical (price units) — same class default as lib/svc
const DIGITS = 3;
const EXPIRY = 30; // bars — the live tracker's contract

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

// ── deep history: throw-away broker session (never touches the live one) ──
async function deepCandles(tf: string): Promise<{ bars: Bar[]; source: string }> {
  const creds = loadCredentials();
  if (!creds) throw new Error("no stored credentials");
  const gateways = creds.gateways?.length ? creds.gateways : await resolveGateways(creds.server);
  let lastErr: Error | null = null;
  for (const gw of gateways.slice(0, 2)) {
    let client: Mt5WsClient | null = null;
    try {
      client = await Mt5WsClient.connect(gw);
      await client.auth();
      await client.login(creds.login, creds.password);
      const days = DEEP_DAYS[tf] ?? 90;
      const to = Math.floor(Date.now() / 1000) + 86400; // generous top (server clock ahead)
      const chunks = days <= 90 ? 1 : days <= 180 ? 2 : 3;
      const per = Math.ceil(days / chunks);
      const seen = new Map<number, Bar>();
      for (let k = chunks - 1; k >= 0; k--) {
        const cTo = to - k * per * 86400;
        const cFrom = cTo - per * 86400;
        const raw = await client.candles(SYMBOL, TF_CODE[tf], cFrom, cTo);
        for (const b of raw) {
          seen.set(b.time, { t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.tickVolume });
        }
      }
      const bars = [...seen.values()].sort((a, b) => a.t - b.t);
      return { bars, source: `broker ws · ${days}d` };
    } catch (e) {
      lastErr = e as Error;
    } finally {
      try { client?.close(); } catch { /* already closed */ }
    }
  }
  throw lastErr ?? new Error("gateways unreachable");
}

async function restCandles(tf: string): Promise<{ bars: Bar[]; source: string }> {
  const r = await fetch(`${REST}/api/candles?symbol=${SYMBOL}&tf=${tf}&limit=3000`);
  if (!r.ok) throw new Error(`${tf}: REST ${r.status}`);
  const d = await r.json();
  return { bars: (d.bars ?? []) as Bar[], source: `service rest · 3000 bars` };
}

// ── walk-forward helpers (mirror the live as-of filters from seed.ts) ──
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

interface PlanRec {
  t: number; dir: "BUY" | "SELL"; entry: number; sl: number; tp: number;
  entryType: "market" | "limit"; distAtr: number; idx: number;
}
type Outcome = { status: "won" | "lost" | "expired" | "cancelled"; r: number | null; fill: number | null };

function resolvePlan(p: PlanRec, bars: Bar[]): Outcome {
  const n = bars.length;
  const end = Math.min(n - 1, p.idx + EXPIRY);
  let fillIdx: number;
  let fill: number;
  if (p.entryType === "market") {
    if (p.idx + 1 > end) return { status: "expired", r: null, fill: null };
    fillIdx = p.idx + 1;
    fill = bars[fillIdx].o; // the plan appears on close → you enter next open
  } else {
    let found = -1;
    for (let j = p.idx + 1; j <= end; j++) {
      if (p.dir === "BUY" ? bars[j].l <= p.entry : bars[j].h >= p.entry) { found = j; break; }
    }
    if (found === -1) return { status: "cancelled", r: null, fill: null };
    fillIdx = found;
    fill = p.entry;
  }
  const risk = Math.abs(fill - p.sl) || 1e-9;
  for (let j = fillIdx; j <= end; j++) {
    const b = bars[j];
    const both = p.dir === "BUY" ? (b.h >= p.tp && b.l <= p.sl) : (b.h >= p.sl && b.l <= p.tp);
    if (both) return { status: "lost", r: -1, fill };
    if (p.dir === "BUY") {
      if (b.h >= p.tp) return { status: "won", r: (p.tp - fill) / risk, fill };
      if (b.l <= p.sl) return { status: "lost", r: -1, fill };
    } else {
      if (b.l <= p.tp) return { status: "won", r: (fill - p.tp) / risk, fill };
      if (b.h >= p.sl) return { status: "lost", r: -1, fill };
    }
  }
  const bEnd = bars[end];
  const r = (p.dir === "BUY" ? bEnd.c - fill : fill - bEnd.c) / risk;
  return { status: "expired", r: Math.max(-1, Math.min(3, r)), fill };
}

function stats(outcomes: Outcome[]) {
  const filled = outcomes.filter((o) => o.status !== "cancelled");
  const won = outcomes.filter((o) => o.status === "won");
  const lost = outcomes.filter((o) => o.status === "lost");
  const exp = outcomes.filter((o) => o.status === "expired");
  const can = outcomes.filter((o) => o.status === "cancelled");
  const decided = won.length + lost.length;
  const totalR = filled.reduce((a, o) => a + (o.r ?? 0), 0);
  return {
    n: outcomes.length, filled: filled.length,
    fillPct: outcomes.length ? (filled.length / outcomes.length) * 100 : 0,
    won: won.length, lost: lost.length, exp: exp.length, can: can.length,
    winPct: decided ? (won.length / decided) * 100 : 0,
    totalR, expR: filled.length ? totalR / filled.length : 0,
  };
}

async function main() {
  console.log(`══ ${SYMBOL} · v16.7 price-anchored entry backtest — REAL broker history ══`);
  console.log(`   signals: entry ≤ ${MAX_ENTRY_DIST_ATR} ATR from price · plans: ≤ ${NEAR_ZONE_ATR} ATR · expiry ${EXPIRY} bars · pessimistic both-touch\n`);

  const head =
    "tf    bars    span        │ A·SIGNALS n  fill%  W  L  E  C  win%   totalR  expR  │ B·PLANS  n  fill%  W  L  E  C  win%   totalR  expR  │ distATR sig-max plan-max";
  console.log(head);
  let contractViolation = false;

  for (const tf of TFS) {
    let bars: Bar[];
    let source: string;
    try {
      ({ bars, source } = await deepCandles(tf));
    } catch (e) {
      try {
        ({ bars, source } = await restCandles(tf));
      } catch (e2) {
        console.log(`${tf.padEnd(5)} FAILED: deep(${(e as Error).message}) rest(${(e2 as Error).message})`);
        continue;
      }
    }
    // drop the forming tail bar
    const nowSec = Math.floor(Date.now() / 1000);
    while (bars.length && bars[bars.length - 1].t + TF_SEC[tf] > nowSec + 86400) bars.pop();
    if (bars.length > 1) bars.pop(); // newest may still be forming on the server
    const candles: Candle[] = bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    const spanDays = Math.round((bars[bars.length - 1].t - bars[0].t) / 86400);

    // ── PATH A · engine signals (the trigger suite through the new geometry) ──
    const seed = seedSignals({ symbol: SYMBOL, tf, digits: DIGITS, spread: SPREAD, bars: candles, brokerOffsetSec: 0 });
    const atrAll = atr(candles, 14);
    const byT = new Map<number, { close: number; atr: number }>();
    candles.forEach((b, i) => byT.set(b.t, { close: b.c, atr: (atrAll[i] as number) || 0 }));
    let sigMaxDist = 0;
    for (const s of seed.signals) {
      const ref = byT.get(s.barTime);
      if (ref && ref.atr > 0) sigMaxDist = Math.max(sigMaxDist, Math.abs(s.entry - ref.close) / ref.atr);
    }
    if (sigMaxDist > MAX_ENTRY_DIST_ATR + 0.02) contractViolation = true;
    const a = stats(seed.signals.map((s) => ({
      status: (s.status === "pending" || s.status === "active") ? "expired" : (s.status as "won" | "lost" | "expired" | "cancelled"),
      r: s.resultR, fill: s.entry,
    })));

    // ── PATH B · projected plans (projectSetup + localBias — the chart ink) ──
    const allZones: Zone[] = [
      ...detectSupplyDemand(candles),
      ...detectOrderBlocks(candles),
      ...detectFvg(candles),
    ];
    const allPools = detectLiquidity(candles, 0.15, 3, 0);
    const plans: PlanRec[] = [];
    let lastT = -Infinity;
    for (let i = 120; i < candles.length - 1; i++) {
      const bar = candles[i];
      if (bar.t - lastT < 6 * TF_SEC[tf]) continue;
      const win = candles.slice(Math.max(0, i - 239), i + 1);
      if (win.length < 60) continue;
      const zones = zonesAsOf(allZones, bar.t, win[0].t);
      const pools = poolsAsOf(allPools, bar.t, win[0].t);
      const lb = localBias(win);
      const p = projectSetup(win, {
        structure: detectStructure(win.slice(-150)),
        pools, zones,
        biasDir: lb.biasDir, biasScore: lb.biasScore,
        spread: SPREAD,
      });
      if (!p) continue;
      plans.push({
        t: bar.t, dir: p.dir, entry: p.entry, sl: p.sl, tp: p.tp,
        entryType: p.entryType, distAtr: p.distAtr, idx: i,
      });
      lastT = bar.t;
    }
    let planMaxDist = 0;
    for (const p of plans) planMaxDist = Math.max(planMaxDist, p.distAtr);
    if (planMaxDist > NEAR_ZONE_ATR + 0.02) contractViolation = true;
    const b = stats(plans.map((p) => resolvePlan(p, bars)));

    const fmt = (s: ReturnType<typeof stats>) =>
      `${String(s.n).padStart(4)} ${s.fillPct.toFixed(0).padStart(4)}% ${String(s.won).padStart(3)} ${String(s.lost).padStart(3)} ${String(s.exp).padStart(3)} ${String(s.can).padStart(3)} ${s.winPct.toFixed(0).padStart(4)}% ${s.totalR.toFixed(1).padStart(7)} ${s.expR.toFixed(2).padStart(6)}`;
    console.log(
      `${tf.padEnd(5)} ${String(bars.length).padStart(6)} ${String(spanDays).padStart(4)}d ${source.includes("ws") ? "ws " : "rst"}    │ ${fmt(a)} │ ${fmt(b)} │ ${sigMaxDist.toFixed(2).padStart(7)} ${planMaxDist.toFixed(2).padStart(8)}`,
    );
  }

  console.log(
    `\ncontract: signals ≤ ${MAX_ENTRY_DIST_ATR} ATR · plans ≤ ${NEAR_ZONE_ATR} ATR — ${contractViolation ? "❌ VIOLATED (see max columns)" : "✅ HELD on every timeframe"}`,
  );
  console.log(`notes: market plans fill at next bar open; limits fill when traded through; both-touch bar = loss;`);
  console.log(`       expired plans settle at the window close (clamped ±3R). Broker-clock sessions (no offset).`);
}

main().catch((e) => {
  console.error("backtest failed:", e);
  process.exit(1);
});
