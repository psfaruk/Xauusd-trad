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
      entryType: "limit",
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

  // 4. trendlines from last two swings (projected; broken → faded)
  const sw = swings(win, 2, 2);
  const highs = sw.filter((s) => s.kind === "high");
  const lows = sw.filter((s) => s.kind === "low");
  if (highs.length >= 2) {
    const [s1, s2] = highs.slice(-2);
    const broken = lastBar.c > Math.max(s1.price, s2.price);
    out.push({
      kind: "trendline",
      t1: s1.t, p1: s1.price, t2: s2.t, p2: s2.price,
      tone: "bear", broken, state: broken ? "faded" : "active",
    });
  }
  if (lows.length >= 2) {
    const [s1, s2] = lows.slice(-2);
    const broken = lastBar.c < Math.min(s1.price, s2.price);
    out.push({
      kind: "trendline",
      t1: s1.t, p1: s1.price, t2: s2.t, p2: s2.price,
      tone: "bull", broken, state: broken ? "faded" : "active",
    });
  }

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
 * Projected next-entry setup — when no live signal exists the chart still
 * answers the trader's three questions (কোন প্রাইসে এন্ট্রি / SL / TARGET):
 * direction from bias→structure→liquidity, entry at the freshest zone's
 * proximal edge (or the OTE pullback pocket), structural SL beyond the
 * zone with liquidity protection, TP at the nearest opposite pool
 * floored to 1.2R. Same geometry contract as the live engine.
 */
export interface ProjectedSetup {
  dir: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  reason: string;
  source: string;
}

export function projectSetup(
  bars: Candle[],
  ctx: {
    structure: StructureRead;
    pools: LiquidityPool[];
    zones: Zone[];
    biasDir: "BUY" | "SELL" | "NEUTRAL";
    biasScore: number;
  },
): ProjectedSetup | null {
  if (bars.length < 30) return null;
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;
  const a = lastAtrOf(bars) || price * 0.001;

  // ── direction: bias → fresh sweep → structure trend ──
  let dir: "BUY" | "SELL";
  let reason: string;
  const swept = ctx.pools.find((p) => p.state === "swept");
  if (ctx.biasDir === "BUY" || ctx.biasDir === "SELL") {
    dir = ctx.biasDir;
    reason = `bias ${ctx.biasScore.toFixed(2)}`;
  } else if (swept) {
    dir = swept.side === "SSL" ? "BUY" : "SELL";
    reason = `${swept.side} swept @ ${swept.price.toFixed(2)}`;
  } else if (ctx.structure.trend === "bullish") {
    dir = "BUY";
    reason = "structure bullish (HH/HL)";
  } else if (ctx.structure.trend === "bearish") {
    dir = "SELL";
    reason = "structure bearish (LH/LL)";
  } else {
    dir = "BUY";
    reason = "range — bid from discount";
  }

  const pd = premiumDiscount(bars, 60, price);
  const fresh = (z: Zone) => !z.mitT && !z.brokenT;

  if (dir === "BUY") {
    // entry candidates: unmitigated bullish zones below (or at) price, closest first
    const zs = ctx.zones
      .filter((z) => ["demand", "ob_bull"].includes(z.side) && fresh(z) && z.hi <= price + 0.25 * a)
      .sort((x, y) => y.hi - x.hi);
    let entry: number;
    let sl: number;
    let source: string;
    if (zs.length && price - zs[0].hi <= 3.5 * a) {
      const z = zs[0];
      entry = z.hi; // proximal edge — limit order at the retest
      sl = z.lo - 0.35 * a; // structural SL beyond the zone
      source = z.side === "demand" ? "DEMAND" : "BULL OB";
    } else {
      // OTE pullback pocket of the up-leg (0.62–0.79 retracement)
      const oteMid = (pd.ote[0] + pd.ote[1]) / 2;
      const e21 = lastEma(bars, 21) ?? price;
      entry = pd.legDir === "up" ? oteMid : Math.min(oteMid, e21);
      sl = pd.lo - 0.35 * a;
      source = "OTE PULLBACK";
    }
    // liquidity protection: an SSL pool just below must sit behind the SL
    const ssl = ctx.pools
      .filter((p) => p.side === "SSL" && p.price < entry && entry - p.price < 2.2 * a)
      .sort((x, y) => y.price - x.price)[0];
    if (ssl) sl = Math.min(sl, ssl.price - 0.15 * a);
    // geometry sanity
    const minRisk = Math.max(0.0004 * price, 0.1 * a);
    if (entry - sl < minRisk) sl = entry - minRisk;
    const risk = entry - sl;
    if (risk <= 0) return null;
    // TP: nearest upside liquidity / supply edge, floored at 1.2R capped 2.5R
    const tps = [
      ...ctx.pools.filter((p) => p.side === "BSL" && p.price > entry + 0.5 * risk).map((p) => p.price),
      ...ctx.zones.filter((z) => ["supply", "ob_bear"].includes(z.side) && z.lo > entry).map((z) => z.lo),
      pd.hi,
    ].filter((v) => v > entry).sort((x, y) => x - y);
    let tp = tps[0] ?? entry + 1.5 * risk;
    if (tp - entry < 1.2 * risk) tp = entry + 1.5 * risk;
    if (tp - entry > 2.5 * risk) tp = entry + 2.5 * risk;
    return { dir, entry, sl, tp, rr: (tp - entry) / risk, reason, source };
  } else {
    const zs = ctx.zones
      .filter((z) => ["supply", "ob_bear"].includes(z.side) && fresh(z) && z.lo >= price - 0.25 * a)
      .sort((x, y) => x.lo - y.lo);
    let entry: number;
    let sl: number;
    let source: string;
    if (zs.length && zs[0].lo - price <= 3.5 * a) {
      const z = zs[0];
      entry = z.lo;
      sl = z.hi + 0.35 * a;
      source = z.side === "supply" ? "SUPPLY" : "BEAR OB";
    } else {
      const oteMid = (pd.ote[0] + pd.ote[1]) / 2;
      const e21 = lastEma(bars, 21) ?? price;
      entry = pd.legDir === "down" ? oteMid : Math.max(oteMid, e21);
      sl = pd.hi + 0.35 * a;
      source = "OTE PULLBACK";
    }
    const bsl = ctx.pools
      .filter((p) => p.side === "BSL" && p.price > entry && p.price - entry < 2.2 * a)
      .sort((x, y) => x.price - y.price)[0];
    if (bsl) sl = Math.max(sl, bsl.price + 0.15 * a);
    const minRisk = Math.max(0.0004 * price, 0.1 * a);
    if (sl - entry < minRisk) sl = entry + minRisk;
    const risk = sl - entry;
    if (risk <= 0) return null;
    const tps = [
      ...ctx.pools.filter((p) => p.side === "SSL" && p.price < entry - 0.5 * risk).map((p) => p.price),
      ...ctx.zones.filter((z) => ["demand", "ob_bull"].includes(z.side) && z.hi < entry).map((z) => z.hi),
      pd.lo,
    ].filter((v) => v < entry).sort((x, y) => y - x);
    let tp = tps[0] ?? entry - 1.5 * risk;
    if (entry - tp < 1.2 * risk) tp = entry - 1.5 * risk;
    if (entry - tp > 2.5 * risk) tp = entry - 2.5 * risk;
    return { dir, entry, sl, tp, rr: (entry - tp) / risk, reason, source };
  }
}

function lastEma(bars: Candle[], period: number): number | null {
  const arr = ema(bars.map((b) => b.c), period);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number;
  return null;
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
