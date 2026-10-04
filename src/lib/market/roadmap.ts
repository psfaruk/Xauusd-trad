/**
 * Market roadmap — the forward plan: honest direction verdict, structure
 * ladder (run / phase / reversal probability), magnet levels, liquidity
 * targets, projected draw-path and both-side scenario ladders.
 * Ported from the reference D-064/D-071 logic.
 */

import type { Candle, RoadmapData, Tone } from "./types";
import { atr, ema } from "./indicators";
import {
  detectStructure, detectLiquidity, premiumDiscount, type LiquidityPool, type StructureRead, type Zone,
} from "./smc";

const LEGS_EXHAUST = 3;

export function buildRoadmap(
  bars: Candle[],
  tf: string,
  ctx: {
    structure: StructureRead;
    pools: LiquidityPool[];
    zones: Zone[];
    biasDir: "BUY" | "SELL" | "NEUTRAL";
    biasScore: number;
  },
): RoadmapData {
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;
  const a = lastAtr(bars) || 1;
  const closes = bars.map((b) => b.c);
  const e21 = lastNum(ema(closes, 21)) ?? price;
  const e50 = lastNum(ema(closes, 50)) ?? price;

  // ── structure ladder: consecutive same-direction break events ──
  const events = ctx.structure.events;
  let run = 0;
  let runDir: "up" | "down" | "flat" = "flat";
  for (let i = events.length - 1; i >= 0; i--) {
    if (run === 0) { runDir = events[i].dir; run = 1; continue; }
    if (events[i].dir === runDir) run++;
    else break;
  }
  const freshChoch = events.length
    ? events[events.length - 1].label === "CHoCH" &&
      lastBar.t - events[events.length - 1].t < 12 * 60 * (tfSec(tf) / 60)
    : false;
  let phase: string;
  if (freshChoch) phase = "reversal-confirmed";
  else if (run >= LEGS_EXHAUST) phase = "extended";
  else phase = "leg";

  let pReversal = Math.min(0.46 + Math.min(0.05 * (run - 1), 0.15), 0.85);
  // momentum decay modifier
  const win = bars.slice(-Math.max(run * 6, 10));
  const avgBody = win.reduce((s, b) => s + Math.abs(b.c - b.o), 0) / (win.length || 1);
  if (avgBody < 0.6 * a) pReversal += 0.1;
  // stretch modifier
  if (Math.abs(price - e21) > 2 * a) pReversal += 0.1;
  if (freshChoch) pReversal = Math.max(pReversal, 0.72);
  pReversal = Math.max(0.35, Math.min(0.85, pReversal));

  // ── direction verdict (fresh liquidity event > draw-on-liquidity > regime/bias) ──
  const swept = ctx.pools.find((p) => p.state === "swept");
  let direction: RoadmapData["direction"];
  let directionWhy: string;
  // v16.8 (user audit): the draw-on-liquidity target is the NEAREST
  // untouched pool by DISTANCE — pools arrive as [BSL..., SSL...] so the old
  // find() hit the first BSL almost by construction and the roadmap read
  // BULL regardless of where price actually sat. Near-tie (≤ 0.35 ATR):
  // prefer the side the bias/structure already faces.
  const untouchedRanked = ctx.pools
    .filter((p) => p.state === "untouched")
    .map((p) => ({ p, d: Math.abs(p.price - price) }))
    .sort((x, y) => x.d - y.d);
  let nearestUntouched: LiquidityPool | null = untouchedRanked[0]?.p ?? null;
  if (untouchedRanked.length >= 2) {
    const [n1, n2] = untouchedRanked;
    if (n2.d - n1.d <= 0.35 * a) {
      const bullFace = ctx.biasDir === "BUY" || (ctx.biasDir === "NEUTRAL" && ctx.structure.trend === "bullish");
      const bearFace = ctx.biasDir === "SELL" || (ctx.biasDir === "NEUTRAL" && ctx.structure.trend === "bearish");
      if (bullFace && n2.p.side === "BSL") nearestUntouched = n2.p;
      else if (bearFace && n2.p.side === "SSL") nearestUntouched = n2.p;
    }
  }
  if (swept) {
    direction = swept.side === "SSL" ? "BULL" : "BEAR";
    directionWhy = `${swept.side} swept at ${swept.price.toFixed(2)} — expect draw back inside`;
  } else if (nearestUntouched) {
    direction = nearestUntouched.side === "BSL" ? "BULL" : "BEAR";
    directionWhy = `draw on liquidity — nearest untouched ${nearestUntouched.side} at ${nearestUntouched.price.toFixed(2)} (${(Math.abs(nearestUntouched.price - price) / a).toFixed(1)} ATR away)`;
  } else if (ctx.biasDir === "BUY") {
    direction = "BULL";
    directionWhy = `multi-source bias ${(ctx.biasScore).toFixed(2)} (H1/H4 structure + EMA)`;
  } else if (ctx.biasDir === "SELL") {
    direction = "BEAR";
    directionWhy = `multi-source bias ${(ctx.biasScore).toFixed(2)} (H1/H4 structure + EMA)`;
  } else {
    direction = "NEUTRAL";
    directionWhy = "mixed reads — wait for a liquidity event";
  }

  // ── magnets (counter-side pull levels, ≤3 ATR) ──
  const pd = premiumDiscount(bars, 60, price);
  const magnetCands: { label: string; price: number }[] = [
    { label: "EMA 21", price: e21 },
    { label: "EMA 50", price: e50 },
    { label: "Equilibrium", price: pd.eq },
    { label: "OTE mid", price: (pd.ote[0] + pd.ote[1]) / 2 },
  ];
  for (const z of ctx.zones) {
    if (z.side.startsWith("fvg") && !z.filled) {
      magnetCands.push({ label: `FVG ${z.side === "fvg_bull" ? "support" : "resistance"}`, price: (z.lo + z.hi) / 2 });
    }
  }
  const magnets = magnetCands
    .filter((m) => Math.abs(m.price - price) <= 3 * a && Math.abs(m.price - price) > 0.05 * a)
    .map((m) => ({ ...m, distAtr: Math.abs(m.price - price) / a }))
    .sort((x, y) => x.distAtr - y.distAtr)
    .slice(0, 3);

  // ── liquidity targets ──
  const liquidity = ctx.pools
    .filter((p) => p.price > 0)
    .map((p) => ({
      side: p.side,
      price: p.price,
      state: p.state,
      distAtr: Math.abs(p.price - price) / a,
    }))
    .sort((x, y) => x.distAtr - y.distAtr)
    .slice(0, 4);

  // ── projected path ──
  // v16.8: same nearest-untouched pick as the direction verdict (the old
  // find() drew the path to the first BSL in the array — up, always up).
  const path = nearestUntouched
    ? {
        dir: (nearestUntouched.side === "BSL" ? "up" : "down") as "up" | "down",
        target: nearestUntouched.price,
        note: `path to ${nearestUntouched.side} ${nearestUntouched.price.toFixed(2)}`,
      }
    : null;

  // ── scenario ladders ──
  const bullTargets = [
    ...ctx.pools.filter((p) => p.side === "BSL").map((p) => p.price),
    ...ctx.zones.filter((z) => ["supply", "ob_bear"].includes(z.side)).map((z) => z.lo),
  ].filter((v) => v > price).sort((x, y) => x - y).slice(0, 3);
  const bearTargets = [
    ...ctx.pools.filter((p) => p.side === "SSL").map((p) => p.price),
    ...ctx.zones.filter((z) => ["demand", "ob_bull"].includes(z.side)).map((z) => z.hi),
  ].filter((v) => v < price).sort((x, y) => y - x).slice(0, 3);

  const bullScenario = {
    entry: magnets[0]?.price ?? pd.eq,
    targets: bullTargets.length ? bullTargets : [price + 2 * a, price + 3.5 * a],
    note: `buy-side interest into discount${pd.state === "discount" ? " (price IS in discount)" : ""}`,
  };
  const bearScenario = {
    entry: magnets[0]?.price ?? pd.eq,
    targets: bearTargets.length ? bearTargets : [price - 2 * a, price - 3.5 * a],
    note: `sell-side interest into premium${pd.state === "premium" ? " (price IS in premium)" : ""}`,
  };

  // ── key levels ladder ──
  const keyLevels: { label: string; price: number; tone: Tone }[] = [
    { label: "Range high", price: pd.hi, tone: "bear" },
    { label: "Equilibrium", price: pd.eq, tone: "neutral" },
    { label: "Range low", price: pd.lo, tone: "bull" },
    ...liquidity.map((l) => ({
      label: `${l.side} ${l.state}`,
      price: l.price,
      tone: (l.side === "BSL" ? "bear" : "bull") as Tone,
    })),
  ];

  return {
    direction,
    directionWhy,
    run,
    runDir,
    phase,
    pReversal,
    magnets,
    liquidity,
    path,
    bullScenario,
    bearScenario,
    keyLevels,
  };
}

function lastAtr(bars: Candle[]): number {
  const arr = atr(bars, 14);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return 0;
}
function lastNum(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}
function tfSec(tf: string): number {
  const m: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
  return m[tf] ?? 900;
}
