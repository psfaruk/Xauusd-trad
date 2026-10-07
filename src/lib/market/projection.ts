/**
 * projection.ts — price-anchored entry plans + a timeframe's own bias vote.
 *
 * v21.0: these two helpers used to live in drawings.ts (the auto-ink
 * pipeline). That pipeline is DELETED — the chart now draws the AI Board's
 * decision (see board.ts + overlay-clean.ts) — but the Signals panel still
 * shows the engine's projected next setup and per-timeframe setups, so the
 * plan builders live on here, ink-free.
 */

import type { Candle } from "./types";
import { atr, ema } from "./indicators";
import {
  detectStructure, premiumDiscount,
  type LiquidityPool, type StructureRead, type Zone,
} from "./smc";

/**
 * Projected next-entry setup — v16.7 PRICE-ANCHORED rewrite.
 *
 * The user contract (verbatim intent): "প্রাইস যেই কারেন্ট প্রাইসে আছে, সেই
 * প্রাইস লেভেল থেকে কনফার্মেশন অনুযায়ী এন্ট্রি বসাতে হবে" — the entry must
 * be reachable from WHERE THE MARKET IS. The old version placed limit orders
 * at zone edges up to 3.5 ATR away (market 4170 → "4100 গেলে buy নাও") and
 * OTE pockets far below price — those are gone. Now exactly two entry types:
 *
 *   1. NEAR-ZONE LIMIT — a fresh zone edge within NEAR_ZONE_ATR (0.6 ATR)
 *      of price: a retest the market can actually complete.
 *   2. CONFIRMATION MARKET ENTRY — entry = current price; SL anchored to the
 *      structural stack (micro swing → EMA21 → fresh zone → leg low) with a
 *      noise floor so the stop isn't wick-food, liquidity-protected.
 *
 * Both keep the same TP ladder (real opposing pools/zone edges/leg extreme,
 * floored 1.2R, capped 2.5R). An over-extended market (price > 2.5 ATR from
 * EMA21) returns null — no setup is the honest answer when chasing is the
 * only option.
 */
function lastAtrOf(bars: Candle[], n = 14): number {
  const arr = atr(bars, n);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return 0;
}

export const NEAR_ZONE_ATR = 0.6;

export interface ProjectedSetup {
  dir: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  reason: string;
  source: string;
  /** v16.7: the market price this setup was computed FROM — the anchor the
   *  entry distance is measured against (so the UI can always say how far
   *  the entry sits from the live price). */
  price: number;
  /** |entry − price| / ATR — guaranteed ≤ NEAR_ZONE_ATR by construction. */
  distAtr: number;
  entryType: "market" | "limit";
  /** ATR of the source series at computation time (risk context). */
  atr: number;
}

export function projectSetup(
  bars: Candle[],
  ctx: {
    structure: StructureRead;
    pools: LiquidityPool[];
    zones: Zone[];
    biasDir: "BUY" | "SELL" | "NEUTRAL";
    biasScore: number;
    /** live spread (price units) — the risk floor is 4×spread like the engine */
    spread?: number;
  },
): ProjectedSetup | null {
  if (bars.length < 30) return null;
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;
  const a = lastAtrOf(bars) || price * 0.001;
  const spread = ctx.spread ?? 0;
  const e21 = lastEma(bars, 21) ?? price;

  // ── direction: bias → fresh sweep → structure trend → premium/discount ──
  let dir: "BUY" | "SELL";
  let reason: string;
  /** v16.7.1: where the direction came from — a CONFIRMATION entry at the
   *  market price is the most demanding trade in the book (nothing is
   *  caught at a discount edge; you pay spread and momentum risk), so it
   *  must be earned by a clear directional BIAS. Swept-pool / structure /
   *  range fallbacks may only power NEAR-ZONE LIMIT plans, where the zone
   *  itself is the confluence. Backtested: without this gate the plan path
   *  ran 31–36% win on the mid TFs (chop food). */
  let dirSource: "bias" | "fallback";
  const swept = ctx.pools.find((p) => p.state === "swept");
  if (ctx.biasDir === "BUY" || ctx.biasDir === "SELL") {
    dir = ctx.biasDir;
    reason = `bias ${ctx.biasScore.toFixed(2)}`;
    dirSource = "bias";
  } else if (swept) {
    dir = swept.side === "SSL" ? "BUY" : "SELL";
    reason = `${swept.side} swept @ ${swept.price.toFixed(2)}`;
    dirSource = "fallback";
  } else if (ctx.structure.trend === "bullish") {
    dir = "BUY";
    reason = "structure bullish (HH/HL)";
    dirSource = "fallback";
  } else if (ctx.structure.trend === "bearish") {
    dir = "SELL";
    reason = "structure bearish (LH/LL)";
    dirSource = "fallback";
  } else {
    // ranging: only a premium/discount answer is honest — else NO setup
    const pd0 = premiumDiscount(bars, 60, price);
    if (pd0.state === "discount") {
      dir = "BUY";
      reason = "range — bid from discount";
    } else if (pd0.state === "premium") {
      dir = "SELL";
      reason = "range — offer from premium";
    } else {
      return null; // no honest direction — show nothing rather than a guess
    }
    dirSource = "fallback";
  }

  // over-extension guard: chasing a market > 2.5 ATR from its EMA21 is not
  // a setup, it's a donation — return null (the nearMiss panel explains)
  if (Math.abs(price - e21) > 2.5 * a) return null;

  const pd = premiumDiscount(bars, 60, price);
  const fresh = (z: Zone) => !z.mitT && !z.brokenT;
  const minRisk = Math.max(0.28 * a, 4 * spread, 0.0004 * price);

  // v16.7.1: a confirmation entry AT PRICE must be earned by a clear BIAS —
  // fallback directions (sweep/structure/range) only power NEAR-ZONE LIMIT
  // plans, where the zone itself is the confluence. Without this gate the
  // backtest measured the plan path at 31–36% win on the mid TFs (chop).
  if (dirSource === "fallback") {
    const nearOk = dir === "BUY"
      ? ctx.zones.some((z) => ["demand", "ob_bull"].includes(z.side) && fresh(z) && z.hi <= price && price - z.hi <= NEAR_ZONE_ATR * a)
      : ctx.zones.some((z) => ["supply", "ob_bear"].includes(z.side) && fresh(z) && z.lo >= price && z.lo - price <= NEAR_ZONE_ATR * a);
    if (!nearOk) return null; // fallback direction with no near zone = no plan
  }
  // v16.7.1: market entries also need a SECOND independent vote beyond the
  // EMA bias — structure agreeing OR a freshly swept pool in the direction
  // (two-vote rule; zone limits are exempt — the zone is the second vote)
  const secondVote =
    ctx.structure.trend === (dir === "BUY" ? "bullish" : "bearish") ||
    (swept != null && (swept.side === "SSL") === (dir === "BUY"));

  if (dir === "BUY") {
    // ── entry 1: NEAR-ZONE LIMIT — fresh bull zone edge within 0.6 ATR
    //    (a TRUE limit: the edge sits at/below the current price) ──
    const zs = ctx.zones
      .filter((z) => ["demand", "ob_bull"].includes(z.side) && fresh(z) && z.hi <= price)
      .sort((x, y) => y.hi - x.hi);
    let entry: number;
    let sl: number;
    let source: string;
    let entryType: "market" | "limit";
    if (zs.length && price - zs[0].hi <= NEAR_ZONE_ATR * a) {
      const z = zs[0];
      entry = z.hi; // retest limit the market can actually reach
      sl = z.lo - 0.35 * a;
      source = z.side === "demand" ? "NEAR DEMAND" : "NEAR BULL OB";
      entryType = "limit";
    } else {
      // ── entry 2: CONFIRMATION MARKET ENTRY at the current price ──
      if (!secondVote) return null; // bias alone doesn't buy at market
      const win = bars.slice(-3);
      const microLo = Math.min(...win.map((b) => b.l));
      const nearZoneLo = ctx.zones
        .filter((z) => ["demand", "ob_bull"].includes(z.side) && fresh(z) && z.lo < price && price - z.lo <= 1.5 * a)
        .map((z) => z.lo)
        .sort((x, y) => y - x)[0];
      // structural stack — deepest protection that is still tight (noise
      // floor 0.5 ATR: stops closer than that are wick-food; cap 1.8 ATR)
      const stack = [microLo - 0.25 * a, e21 - 0.15 * a, nearZoneLo != null ? nearZoneLo - 0.25 * a : null, pd.lo - 0.15 * a]
        .filter((v): v is number => v != null)
        .filter((v) => price - v >= Math.max(minRisk, 0.5 * a) && price - v <= 1.8 * a)
        .sort((x, y) => y - x); // closest valid level first
      entry = price;
      sl = stack[0] ?? price - Math.max(minRisk, 0.9 * a);
      source = "CONFIRM ENTRY";
      entryType = "market";
    }
    // liquidity protection: an SSL pool just below must sit behind the SL
    const ssl = ctx.pools
      .filter((p) => p.side === "SSL" && p.price < entry && entry - p.price < 2.2 * a)
      .sort((x, y) => y.price - x.price)[0];
    if (ssl) sl = Math.min(sl, ssl.price - 0.15 * a);
    // geometry sanity
    if (entry - sl < minRisk) sl = entry - minRisk;
    if (entry - sl > 1.8 * a) sl = entry - 1.8 * a;
    const risk = entry - sl;
    if (risk <= 0) return null;
    // TP: nearest REAL upside target at least 1.2R away (never shoot
    // THROUGH closer liquidity by forcing 1.5R); none within 2.5R → no plan
    const tps = [
      ...ctx.pools.filter((p) => p.side === "BSL" && p.price > entry + 0.5 * risk).map((p) => p.price),
      ...ctx.zones.filter((z) => ["supply", "ob_bear"].includes(z.side) && z.lo > entry).map((z) => z.lo),
      pd.hi,
    ].filter((v) => v > entry).sort((x, y) => x - y);
    const valid = tps.filter((v) => v - entry >= 1.2 * risk && v - entry <= 2.5 * risk);
    if (!valid.length) return null; // no realistic target — no plan
    const tp = valid[0];
    return {
      dir, entry, sl, tp, rr: (tp - entry) / risk, reason, source,
      price, distAtr: Math.abs(entry - price) / a, entryType, atr: a,
    };
  } else {
    const zs = ctx.zones
      .filter((z) => ["supply", "ob_bear"].includes(z.side) && fresh(z) && z.lo >= price)
      .sort((x, y) => x.lo - y.lo);
    let entry: number;
    let sl: number;
    let source: string;
    let entryType: "market" | "limit";
    if (zs.length && zs[0].lo - price <= NEAR_ZONE_ATR * a) {
      const z = zs[0];
      entry = z.lo;
      sl = z.hi + 0.35 * a;
      source = z.side === "supply" ? "NEAR SUPPLY" : "NEAR BEAR OB";
      entryType = "limit";
    } else {
      if (!secondVote) return null; // bias alone doesn't sell at market
      const win = bars.slice(-3);
      const microHi = Math.max(...win.map((b) => b.h));
      const nearZoneHi = ctx.zones
        .filter((z) => ["supply", "ob_bear"].includes(z.side) && fresh(z) && z.hi > price && z.hi - price <= 1.5 * a)
        .map((z) => z.hi)
        .sort((x, y) => x - y)[0];
      const stack = [microHi + 0.25 * a, e21 + 0.15 * a, nearZoneHi != null ? nearZoneHi + 0.25 * a : null, pd.hi + 0.15 * a]
        .filter((v): v is number => v != null)
        .filter((v) => v - price >= Math.max(minRisk, 0.5 * a) && v - price <= 1.8 * a)
        .sort((x, y) => x - y);
      entry = price;
      sl = stack[0] ?? price + Math.max(minRisk, 0.9 * a);
      source = "CONFIRM ENTRY";
      entryType = "market";
    }
    const bsl = ctx.pools
      .filter((p) => p.side === "BSL" && p.price > entry && p.price - entry < 2.2 * a)
      .sort((x, y) => x.price - y.price)[0];
    if (bsl) sl = Math.max(sl, bsl.price + 0.15 * a);
    if (sl - entry < minRisk) sl = entry + minRisk;
    if (sl - entry > 1.8 * a) sl = entry + 1.8 * a;
    const risk = sl - entry;
    if (risk <= 0) return null;
    const tps = [
      ...ctx.pools.filter((p) => p.side === "SSL" && p.price < entry - 0.5 * risk).map((p) => p.price),
      ...ctx.zones.filter((z) => ["demand", "ob_bull"].includes(z.side) && z.hi < entry).map((z) => z.hi),
      pd.lo,
    ].filter((v) => v < entry).sort((x, y) => y - x);
    const valid = tps.filter((v) => entry - v >= 1.2 * risk && entry - v <= 2.5 * risk);
    if (!valid.length) return null; // no realistic target — no plan
    const tp = valid[0];
    return {
      dir, entry, sl, tp, rr: (entry - tp) / risk, reason, source,
      price, distAtr: Math.abs(entry - price) / a, entryType, atr: a,
    };
  }
}

function lastEma(bars: Candle[], period: number): number | null {
  const arr = ema(bars.map((b) => b.c), period);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return null;
}

/**
 * v16.7 — a timeframe's OWN direction vote (EMA50 position + EMA stack +
 * structure trend), used for the per-TF setups: the M1 chart's M1 setup
 * comes from M1's own read, the H1's from H1's — user spec: "এক মিনিটের
 * টাইম ফ্রেম বলছে মার্কেট আপ যাবে → ওই এন্ট্রি সেটাপ শুধু এক মিনিটের"।
 */
export function localBias(bars: Candle[]): { biasDir: "BUY" | "SELL" | "NEUTRAL"; biasScore: number } {
  if (bars.length < 60) return { biasDir: "NEUTRAL", biasScore: 0 };
  const price = bars[bars.length - 1].c;
  const e50 = lastEma(bars, 50) ?? price;
  const e21 = lastEma(bars, 21) ?? price;
  const st = detectStructure(bars.slice(-150)).trend;
  const score =
    0.55 * Math.sign(price - e50) +
    0.25 * Math.sign(e21 - e50) +
    0.2 * (st === "bullish" ? 1 : st === "bearish" ? -1 : 0);
  const biasDir: "BUY" | "SELL" | "NEUTRAL" =
    Math.abs(score) >= 0.3 ? (score > 0 ? "BUY" : "SELL") : "NEUTRAL";
  return { biasDir, biasScore: score };
}
