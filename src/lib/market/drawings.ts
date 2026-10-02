/**
 * Auto-drawings builder — converts engine reads into the chart ink layer
 * (same drawing grammar as the reference: setup box → key levels → zones →
 * trendlines → fib → structure → swings → liquidity → magnets → path).
 */

import type { AutoDrawing, Candle, RoadmapData, Tone } from "./types";
import { atr, ema, swings } from "./indicators";
import {
  detectStructure, detectOrderBlocks, detectFvg, detectLiquidity, detectSupplyDemand,
  premiumDiscount, type LiquidityPool, type StructureRead, type Zone,
} from "./smc";
import type { SignalPayload } from "./types";
import type { AmdPhase, ConsolidationRange, InstitutionalMark } from "./phases";
import { detectChannel } from "./patterns";

const MAX_DRAWINGS = 96;

export function buildDrawings(
  bars: Candle[],
  tf: string,
  ctx: {
    structure: StructureRead;
    pools: LiquidityPool[];
    zones: Zone[];
    signal: SignalPayload | null;
    projection?: ProjectedSetup | null;
  },
  /** v16.5: HTF zones arrive as {tf, zones} groups so EVERY group is labeled
   * with its true source timeframe (H1 + H4 — audit §2.6). */
  htfZoneGroups: { tf: string; zones: Zone[] }[] = [],
  /** v16.5: bar-time → tick-volume z (≥1.5) — zone origin bars with a spike
   * get the INST (institutional) tag on their label. */
  volSpikes: Map<number, number> = new Map(),
): AutoDrawing[] {
  const out: AutoDrawing[] = [];
  if (bars.length < 30) return out;
  const win = bars.slice(-150);
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;
  const a = lastAtrOf(bars) || 1;

  // 1. setup box (the LIVE signal — D-074: the signal IS the drawing)
  if (ctx.signal) {
    const s = ctx.signal;
    const dir = s.direction;
    out.push({
      kind: "setup",
      dir,
      zone: [Math.min(s.entry, s.sl), Math.max(s.entry, s.sl)],
      entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr,
      t0: s.barTime,
      status: s.status === "pending" ? "pending" : s.status === "active" ? "active" : "triggered",
      note: s.entryNote,
      entryType: s.entryType,
      createdAt: s.createdAt,
      symbol: s.symbol,
      tf: s.timeframe,
      trigger: s.trigger,
    });
  } else if (ctx.projection) {
    // no live signal → the planned next entry (dotted projection ink)
    const p = ctx.projection;
    out.push({
      kind: "setup",
      dir: p.dir,
      zone: [Math.min(p.entry, p.sl), Math.max(p.entry, p.sl)],
      entry: p.entry, sl: p.sl, tp: p.tp, rr: p.rr,
      t0: lastBar.t,
      status: "projected",
      note: `${p.source} · ${p.reason}`,
      entryType: p.entryType,
    });
  }

  // 2. key levels: EQ + PDH/PDL style hlines from liquidity pools
  const pd = premiumDiscount(bars, 60, price);
  out.push({ kind: "hline", price: pd.eq, label: "EQ", tone: "neutral", style: "dash" });
  for (const p of ctx.pools) {
    out.push({
      kind: "liq",
      side: p.side,
      price: p.price,
      t: p.t,
      state: p.state,
    });
  }

  // 3. zones (this TF + HTF context groups, capped) — only ALIVE zones
  // (the detectors now keep broken zones in the universe for as-of use)
  const alive = (z: Zone) => z.brokenT == null;
  const inst = (t: number) => (volSpikes.get(t) ?? 0) >= 1.5;
  const zoneKinds: { z: Zone; src: string }[] = [
    ...ctx.zones.filter((z) => alive(z) && ["demand", "supply"].includes(z.side)).slice(-4).map((z) => ({ z, src: tf })),
    ...ctx.zones.filter((z) => alive(z) && z.side.startsWith("ob")).slice(-3).map((z) => ({ z, src: tf })),
    ...ctx.zones.filter((z) => alive(z) && z.side.startsWith("fvg") && !z.filled && (z.gapAtr ?? 0) >= 0.3).slice(-3).map((z) => ({ z, src: tf })),
    ...htfZoneGroups.flatMap((g) =>
      g.zones.filter((z) => alive(z) && ["demand", "supply"].includes(z.side)).slice(-2).map((z) => ({ z, src: g.tf })),
    ),
  ];
  for (const { z, src } of zoneKinds) {
    out.push({
      kind: "zone",
      side: z.side as any,
      lo: z.lo, hi: z.hi, t: z.t,
      // v16.4 (audit §2.6/§6): zones carry their TRUE source timeframe —
      // HTF groups are labeled H1/H4, local zones get the active tf.
      // v16.5: a ≥1.5σ volume-spiked origin ⇒ INST (institutional) tag.
      source_tf: src,
      institutional: inst(z.t),
      state: z.mitT ? "faded" : "active",
    });
  }

  // 4. trendlines from last two swings (projected; broken → faded).
  //    v16.6: the break test is against the PROJECTED line value at the
  //    last bar (the ref engine's rule) — on a descending supply line the
  //    projection sits BELOW the older swing high, so a close through the
  //    *line* (not the swing max) is the honest "market left the trendline"
  //    read. This is why the drawn line looks like the market follows it.
  const sw = swings(win, 2, 2);
  const highs = sw.filter((s) => s.kind === "high");
  const lows = sw.filter((s) => s.kind === "low");
  const projAt = (p1: { t: number; price: number }, p2: { t: number; price: number }, atT: number) => {
    const dt = p2.t - p1.t;
    if (dt <= 0) return p2.price;
    return p2.price + ((p2.price - p1.price) / dt) * (atT - p2.t);
  };
  if (highs.length >= 2) {
    const [s1, s2] = highs.slice(-2);
    const projNow = projAt(s1, s2, lastBar.t);
    const broken = lastBar.c > projNow + 0.25 * a;
    out.push({
      kind: "trendline",
      t1: s1.t, p1: s1.price, t2: s2.t, p2: s2.price,
      tone: "bear", broken, state: broken ? "faded" : "active", source_tf: tf,
    });
  }
  if (lows.length >= 2) {
    const [s1, s2] = lows.slice(-2);
    const projNow = projAt(s1, s2, lastBar.t);
    const broken = lastBar.c < projNow - 0.25 * a;
    out.push({
      kind: "trendline",
      t1: s1.t, p1: s1.price, t2: s2.t, p2: s2.price,
      tone: "bull", broken, state: broken ? "faded" : "active", source_tf: tf,
    });
  }

  // 4b. v16.6 — the channel (ref _channel): upper + lower parallels + the
  //     dashed median from the last 2 swing highs/lows (k=3 fractals).
  //     Only prints when both sides agree on the slope — the corridor the
  //     market has been walking between. Projected forward by the renderer.
  const channel = detectChannel(bars);
  if (channel) out.push({ ...channel, source_tf: tf });

  // 5. fib of the current leg with OTE
  const legFrom = pd.legDir === "up" ? pd.lo : pd.hi;
  const legTo = pd.legDir === "up" ? pd.hi : pd.lo;
  const fibT0 = win.find((b) => (pd.legDir === "up" ? b.l === legFrom : b.h === legTo))?.t ?? win[0].t;
  const fibT1 = win.find((b) => (pd.legDir === "up" ? b.h === legTo : b.l === legFrom))?.t ?? lastBar.t;
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((r) => ({
    ratio: r,
    price: legFrom + (legTo - legFrom) * r,
  }));
  out.push({
    kind: "fib",
    t0: fibT0, p0: legFrom, t1: fibT1, p1: legTo,
    dir: pd.legDir, levels,
    ote: pd.ote,
  });

  // 6. structure events (BOS/CHoCH break lines + diamonds)
  for (const ev of ctx.structure.events.slice(-4)) {
    out.push({ kind: "structure", t: ev.t, price: ev.price, dir: ev.dir, label: ev.label, fromT: ev.fromT, source_tf: tf });
  }

  // 6b. market-structure zigzag — the swing map, connected
  const swPath = sw.slice(-9);
  if (swPath.length >= 2) {
    out.push({
      kind: "zigzag",
      points: swPath.map((s) => ({ t: s.t, p: s.price, side: s.kind })),
    });
  }

  // 7. swing labels (last 6)
  for (const l of ctx.structure.labels.slice(-6)) {
    out.push({ kind: "swing", t: l.t, price: l.price, tag: l.tag, side: l.side });
  }

  // 8. sweeps (pools with swept state) — X marks
  for (const p of ctx.pools.filter((x) => x.state === "swept")) {
    out.push({ kind: "sweep", t: lastBar.t, price: p.price, side: p.side === "BSL" ? "high" : "low" });
  }

  return out.slice(0, MAX_DRAWINGS);
}

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

/** Roadmap magnets as drawings (dashed gold lines). */
export function magnetsToDrawings(
  magnets: { label: string; price: number; distAtr: number }[],
): AutoDrawing[] {
  return magnets.map((m) => ({
    kind: "magnet",
    price: m.price,
    source: m.label,
    dist_atr: m.distAtr,
  }));
}

export function pathToDrawing(path: { dir: "up" | "down"; target: number } | null, price: number): AutoDrawing | null {
  if (!path) return null;
  return { kind: "path", dir: path.dir, from_price: price, to_price: path.target };
}

// ═══════════════ v16.5 — the market-structure narrative builders ═══════════════

export interface PhaseRead {
  ranges: ConsolidationRange[];
  amd: AmdPhase[];
  instit: InstitutionalMark[];
}

/**
 * Phase ink — consolidation ranges (active tf + the freshest H1/H4 ranges
 * for the multi-timeframe story), AMD sequences and big-player footprints.
 * Every item carries its source timeframe (audit §2.6 identity contract).
 */
export function buildPhaseDrawings(
  tf: string,
  ph: PhaseRead,
  htfRanges: { tf: string; range: ConsolidationRange | null }[] = [],
): AutoDrawing[] {
  const out: AutoDrawing[] = [];
  // ranges whose t0 collides with an AMD accumulation are skipped — the AMD
  // label already tells that story (no double boxes)
  const amdT0 = new Set(ph.amd.filter((p) => p.phase === "accumulation").map((p) => p.t0));
  const local = ph.ranges.slice(-2).filter((r) => !amdT0.has(r.t0));
  for (const r of local) {
    out.push({ kind: "range", t0: r.t0, t1: r.t1, hi: r.hi, lo: r.lo, state: r.state, source_tf: tf });
  }
  for (const g of htfRanges) {
    if (g.range && !amdT0.has(g.range.t0)) {
      out.push({ kind: "range", t0: g.range.t0, t1: g.range.t1, hi: g.range.hi, lo: g.range.lo, state: g.range.state, source_tf: g.tf });
    }
  }
  for (const p of ph.amd) {
    out.push({ kind: "amd", phase: p.phase, t0: p.t0, t1: p.t1, hi: p.hi, lo: p.lo, dir: p.dir, done: p.done, source_tf: tf });
  }
  for (const m of ph.instit) {
    out.push({ kind: "instit", t: m.t, price: m.price, side: m.side, volZ: m.volZ, source_tf: tf });
  }
  return out;
}

/** HTF structure events (H1/H4 BOS/CHoCH) drawn on the active chart,
 *  source-labeled — the MTF continuation/reversal context. */
export function buildMtfStructureDrawings(mtf: {
  h1: StructureRead | null;
  h4: StructureRead | null;
}): AutoDrawing[] {
  const out: AutoDrawing[] = [];
  const groups: [string, StructureRead | null][] = [["H1", mtf.h1], ["H4", mtf.h4]];
  for (const [tf, read] of groups) {
    if (!read) continue;
    for (const ev of read.events.slice(-2)) {
      out.push({ kind: "structure", t: ev.t, price: ev.price, dir: ev.dir, label: ev.label, fromT: ev.fromT, source_tf: tf });
    }
  }
  return out;
}

/**
 * The forward map — WHERE the market can go next: the roadmap's primary
 * scenario (direction verdict) as projected legs to its real targets
 * (liquidity pools / zone edges), plus the alternate scenario dimmed.
 * Labels carry prices so the map answers "কোথায় যেতে পারে" at a glance.
 */
export function buildForecastDrawing(
  rm: RoadmapData,
  price: number,
  digits: number,
): AutoDrawing | null {
  if (!rm || rm.direction === "NEUTRAL") {
    // neutral: both sides equally live — show both, neither primary
    if (!rm) return null;
    const fmt = (p: number) => p.toFixed(digits);
    return {
      kind: "forecast",
      from: price,
      primary: { dir: "up", legs: rm.bullScenario.targets.slice(0, 2).map((tp, i) => ({ price: tp, label: `BULL T${i + 1} ${fmt(tp)}` })), note: rm.bullScenario.note },
      alternate: { dir: "down", legs: rm.bearScenario.targets.slice(0, 2).map((tp, i) => ({ price: tp, label: `BEAR T${i + 1} ${fmt(tp)}` })), note: rm.bearScenario.note },
    };
  }
  const bull = rm.direction === "BULL";
  const primary = bull ? rm.bullScenario : rm.bearScenario;
  const alternate = bull ? rm.bearScenario : rm.bullScenario;
  const fmt = (p: number) => p.toFixed(digits);
  return {
    kind: "forecast",
    from: price,
    primary: {
      dir: bull ? "up" : "down",
      legs: primary.targets.slice(0, 3).map((tp, i) => ({ price: tp, label: `T${i + 1} ${fmt(tp)}` })),
      note: rm.directionWhy,
    },
    alternate: {
      dir: bull ? "down" : "up",
      legs: alternate.targets.slice(0, 2).map((tp, i) => ({ price: tp, label: `ALT T${i + 1} ${fmt(tp)}` })),
      note: alternate.note,
    },
  };
}

function lastAtrOf(bars: Candle[]): number {
  const arr = atr(bars, 14);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return 0;
}
