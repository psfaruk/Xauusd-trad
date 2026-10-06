/**
 * inkSelect.ts — THE CONTEXT GATE (v20.0 rewrite of the chart-drawing layer)
 *
 * User spec (বাংলা): "যখন যেই ড্রয়িং টি chart এ দরকার সেই ড্রয়িং টি থাকবে" —
 * ONLY the drawing the chart needs RIGHT NOW stays; everything else is noise.
 * The old renderer drew every candidate the engine produced (up to ~96 items
 * across 19 kinds) and the chart read as "এলোমেলো" — overlapping lines,
 * stacked labels, dead ink painted over the live price area.
 *
 * This module is the SELECTION brain (pure, deterministic, testable): every
 * auto-drawing candidate earns its ink through a relevance score in the
 * CURRENT market context, then competes for a strict per-slot budget. The
 * renderer (overlay-render.ts) just draws what survives — it never decides.
 *
 * Relevance axes:
 *   · proximity  — distance from the live price in ATR units (the market
 *                  position NOW; a level 6 ATR away is not tradeable ink)
 *   · recency    — bars since the drawing was minted (fresh structure beats
 *                  ancient history)
 *   · state      — active/unbroken/untouched ink outranks swept/broken/mitigated
 *   · importance — per-slot weights: structure spine > levels > zones >
 *                  trendlines > pattern annotations
 */

import type { AutoDrawing, Candle } from "./types";
import { TF_ORDER } from "./cluster";

// ── the plan: one entry per slot, strict budgets ───────────────────────────

export type LevelD = Extract<AutoDrawing, { kind: "hline" }> | Extract<AutoDrawing, { kind: "liq" }> | Extract<AutoDrawing, { kind: "magnet" }>;
export type ZoneD = Extract<AutoDrawing, { kind: "zone" }>;
export type TrendD = Extract<AutoDrawing, { kind: "trendline" }> | Extract<AutoDrawing, { kind: "channel" }>;
export type CandleD = Extract<AutoDrawing, { kind: "candle" }>;
export type PatternD = Extract<AutoDrawing, { kind: "pattern" }>;
export type SetupD = Extract<AutoDrawing, { kind: "setup" }>;
export type TfSetupD = Extract<AutoDrawing, { kind: "tf_setup" }>;
export type SwingD = Extract<AutoDrawing, { kind: "swing" }>;
export type ZigzagD = Extract<AutoDrawing, { kind: "zigzag" }>;
export type EventD = Extract<AutoDrawing, { kind: "structure" }>;
export type SweepD = Extract<AutoDrawing, { kind: "sweep" }>;
export type FibD = Extract<AutoDrawing, { kind: "fib" }>;
export type MomentumD = Extract<AutoDrawing, { kind: "momentum" }>;
export type NarrativeD =
  | Extract<AutoDrawing, { kind: "amd" }>
  | Extract<AutoDrawing, { kind: "range" }>
  | Extract<AutoDrawing, { kind: "instit" }>
  | Extract<AutoDrawing, { kind: "forecast" }>
  | Extract<AutoDrawing, { kind: "path" }>;

export interface InkPlan {
  /** the structural spine — most recent swings, oldest→newest */
  swings: SwingD[];
  zigzag: ZigzagD | null;
  /** ≤ budget horizontal levels: nearest ACTIVE above + below price */
  levels: LevelD[];
  /** the two zones that matter: nearest fresh supply above + demand below */
  zones: ZoneD[];
  /** ≤2 unbroken trendlines/channels */
  trend: TrendD[];
  /** ≤3 recent candlestick-pattern boxes (live setups first) */
  candles: CandleD[];
  /** ≤1 classic chart pattern (head&shoulders / triangle / …) */
  pattern: PatternD | null;
  /** THE hero trade plan — one voice only */
  setup: SetupD | null;
  /** ≤1 other-timeframe plan rail (near price only) */
  tfSetup: TfSetupD | null;
  /** ≤2 recent structure breaks (BOS / CHoCH) */
  events: EventD[];
  /** ≤2 recent liquidity sweeps */
  sweeps: SweepD[];
  /** the retracement map — only when no pattern/setup owns the chart */
  fib: FibD | null;
  momentum: MomentumD | null;
  /** narrative layer (default OFF): the CURRENT phase of each story kind */
  narrative: NarrativeD[];
  /** how many candidates were considered → how many kept (for the HUD) */
  stats: { considered: number; kept: number };
}

export interface InkFiltersInput {
  /** max horizontal levels visible (the budget knob, 3..6) */
  maxLevels: number;
  /** allow higher-timeframe-sourced ink */
  htf: boolean;
  /** allow dead ink (swept pools, swept liq) as quiet dashed lines */
  faded: boolean;
  /** show duplicates the clustering absorbed */
  merged: boolean;
}

export interface SelectInput {
  drawings: AutoDrawing[];
  /** the AI chart-read candidates (same grammar, source "AI") */
  aiDrawings?: AutoDrawing[];
  bars: Candle[];
  timeframe: string;
  atr: number;
  filters: InkFiltersInput;
}

/** ATR fallback when the chart has too few bars for a real ATR */
function atrOf(bars: Candle[], n = 14): number {
  if (bars.length < n + 1) {
    if (!bars.length) return 1;
    const rngs = bars.slice(-40).map((b) => b.h - b.l);
    return Math.max(1e-9, rngs.reduce((a, b) => a + b, 0) / rngs.length);
  }
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  }
  return Math.max(1e-9, sum / n);
}

const EMPTY_PLAN: InkPlan = {
  swings: [], zigzag: null, levels: [], zones: [], trend: [],
  candles: [], pattern: null, setup: null, tfSetup: null,
  events: [], sweeps: [], fib: null, momentum: null, narrative: [],
  stats: { considered: 0, kept: 0 },
};

/** min vertical separation between kept level PRICES (in ATR) — two lines
 *  closer than this read as one level; keep the stronger, drop the other */
const LEVEL_SEP_ATR = 0.35;

export function selectInk(input: SelectInput): InkPlan {
  const { drawings, aiDrawings = [], bars, timeframe, filters } = input;
  if (!bars.length) return { ...EMPTY_PLAN };
  const atr = input.atr > 0 ? input.atr : atrOf(bars);
  const lastBar = bars[bars.length - 1];
  const price = lastBar.c;
  const nowT = lastBar.t;
  const tfSec = tfSeconds(timeframe);
  const barsAgo = (t: number) => Math.max(0, Math.round((nowT - t) / tfSec));
  const tfRank = TF_ORDER[timeframe] ?? 3;

  // merged-away duplicates stay hidden unless explicitly asked for
  const alive = (d: AutoDrawing) => filters.merged || !d.mergedInto;
  // HTF filter: ink minted on a HIGHER tf can be silenced
  const tfOk = (d: AutoDrawing) => {
    if (filters.htf) return true;
    const src = (d as { source_tf?: string }).source_tf;
    return !src || (TF_ORDER[src] ?? 0) <= tfRank;
  };

  let considered = 0;
  const byKind = new Map<string, AutoDrawing[]>();
  for (const d of [...drawings, ...aiDrawings]) {
    considered++;
    if (!alive(d) || !tfOk(d)) continue;
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }
  const K = (kind: string) => byKind.get(kind) ?? [];

  const plan: InkPlan = { ...EMPTY_PLAN, stats: { considered, kept: 0 } };

  // ── 1. the spine: zigzag + the most recent swing tags (≤7) ──
  plan.zigzag = (K("zigzag")[0] as ZigzagD) ?? null;
  plan.swings = K("swing")
    .slice()
    .sort((a, b) => (a as SwingD).t - (b as SwingD).t)
    .slice(-7) as SwingD[];

  // ── 0. THE hero voices first — their existence narrows every other slot ──
  // (a live trade plan is the chart's loudest voice; the M5 audit found a
  // setup box + 4 levels + POC stacked into one column — the plan squeezes
  // the levels to 2, silences the magnets, and levels sitting ON the plan's
  // own entry/SL/TP prices are dropped as redundant ink)
  {
    const ss = K("setup") as SetupD[];
    const byPrio = (s: SetupD) =>
      s.status === "active" ? 0 : s.status === "triggered" ? 1 : s.status === "pending" ? 2 : 3;
    plan.setup = ss.slice().sort((a, b) => byPrio(a) - byPrio(b) || b.t0 - a.t0)[0] ?? null;
    const tfs = (K("tf_setup") as TfSetupD[])
      .filter((d) => d.distAtr <= 6)
      .sort((a, b) => a.distAtr - b.distAtr);
    plan.tfSetup = tfs[0] ?? null;
    const ps = K("pattern") as PatternD[];
    // a pattern is live ink only while fresh: forming, or confirmed within
    // the last 120 bars (an ancient pattern is history, not a setup)
    const lastPt = (p: PatternD) => p.points[p.points.length - 1]?.t ?? 0;
    const live = ps.filter((p) => p.state === "forming" || barsAgo(lastPt(p)) <= 120);
    plan.pattern = live.find((d) => d.state === "forming") ?? live[live.length - 1] ?? null;
  }
  // a hero voice = ANY live trade plan (setup box or classic chart pattern
  // with its entry/stop/target) — both squeeze the level budget to one per
  // side, silence the magnets, and absorb coincident levels
  const hasHero = !!(plan.setup || plan.pattern);
  const heroPrices: number[] = [];
  if (plan.setup) {
    heroPrices.push(plan.setup.entry, plan.setup.sl, plan.setup.tp);
    if (typeof plan.setup.tp2 === "number") heroPrices.push(plan.setup.tp2);
  }
  if (plan.pattern) {
    heroPrices.push(plan.pattern.entry.price, plan.pattern.sl, plan.pattern.target);
  }

  // ── 2. levels: nearest ACTIVE above + below, min separation ──
  {
    interface Cand {
      d: LevelD;
      price: number;
      score: number;
      active: boolean;
    }
    const cands: Cand[] = [];
    // v20.1 — CROSS-SOURCE MERGE: when the AI chart-read lands on (≈) the
    // same price as an engine level, they are ONE level. The ENGINE line
    // keeps the identity (its source tf + origin swing); the AI's touches
    // count toward it and the agreement is recorded in the merge story —
    // the column then reads "R 4179.76 ·M15 ×6" (true origin), not two
    // competing pills $0.01 apart.
    const engineHlines = K("hline").filter(
      (d): d is Extract<LevelD, { kind: "hline" }> => (d as { source_tf?: string }).source_tf !== "AI",
    );
    const aiHlines = K("hline").filter(
      (d): d is Extract<LevelD, { kind: "hline" }> => (d as { source_tf?: string }).source_tf === "AI",
    );
    const absorbed = new Set<AutoDrawing>();
    for (const ai of aiHlines) {
      const idx = engineHlines.findIndex(
        (e) => Math.abs(e.price - ai.price) < 0.25 * atr && !absorbed.has(e),
      );
      if (idx >= 0) {
        const twin = engineHlines[idx];
        absorbed.add(ai);
        // clone — selectInk runs every tick and must never accumulate
        // merge notes on the shared prop objects
        engineHlines[idx] = {
          ...twin,
          hits: Math.max(twin.hits ?? 1, ai.hits ?? 1),
          mergedFrom: [...(twin.mergedFrom ?? []), `AI ${ai.side === "resistance" ? "R" : "S"} agrees`],
        };
      }
    }
    for (const d of [...engineHlines, ...aiHlines.filter((a) => !absorbed.has(a)), ...K("liq"), ...K("magnet")] as LevelD[]) {
      const price = d.price;
      if (!Number.isFinite(price)) continue;
      const distAtr = Math.abs(price - lastBar.c) / atr;
      const t = levelT(d);
      const age = t ? barsAgo(t) : 0;
      const active = levelActive(d);
      const hits = (d as { hits?: number }).hits ?? 1;
      const srcTf = (d as { source_tf?: string }).source_tf;
      // proximity dominates; recency, state, test-count and source adjust.
      // v20.1: a level minted on a LOWER timeframe is micro structure — the
      // M1 swings $2 from price are noise on an M15/H1 read (the first VLM
      // audit found ALL four level slots taken by M1 lines). Soft-demote
      // them −6 per rank step below the chart tf: they can still win when
      // genuinely closer/tested, but the chart's own tf + HTF levels lead.
      let score = 100 - Math.min(62, distAtr * 16);
      score -= Math.min(22, age / 14);
      score += active ? 8 : -34;
      score += Math.min(9, (hits - 1) * 3);
      if (srcTf) {
        if (srcTf === "AI") {
          // the AI chart-read is a SECOND OPINION — welcome when the engine's
          // own structure has nothing near price, never the primary ink
          score -= 15;
        } else {
          const srcRank = TF_ORDER[srcTf] ?? 0;
          if (srcRank === tfRank) score += 4;
          else if (srcRank > tfRank) score += 2; // HTF context stays welcome
          else score -= (tfRank - srcRank) * 6;   // micro noise demoted
        }
      }
      // magnets (POC…) are attractors, not tradeable levels — they fill a
      // slot only when real structure is scarce nearby
      if (d.kind === "magnet") score -= 10;
      cands.push({ d, price, score, active });
    }
    // dead ink only when the user asked for it (faded) — and never above
    // budget: it competes with the same score system, heavily demoted.
    // A hero setup narrows the budget to ONE level per side and drops
    // magnets and any level sitting on the plan's own prices (redundant
    // ink — an "ENTRY 4179.76" badge next to an "R 4179.76" pill said one
    // thing twice).
    const pool = cands.filter(
      (c) =>
        (filters.faded || c.active) &&
        (!hasHero || c.d.kind !== "magnet") &&
        !heroPrices.some((p) => Math.abs(p - c.price) < 0.15 * atr),
    );
    const budget = hasHero
      ? Math.min(2, filters.maxLevels)
      : Math.max(2, Math.min(6, filters.maxLevels));
    const perSide = Math.ceil(budget / 2);
    const pick = (above: boolean): Cand[] => {
      const side = pool
        .filter((c) => (above ? c.price > lastBar.c : c.price < lastBar.c))
        .sort((a, b) => a.score - b.score)
        .reverse();
      const kept: Cand[] = [];
      for (const c of side) {
        if (kept.length >= perSide) break;
        // separation: no two kept levels within LEVEL_SEP_ATR (stronger wins)
        if (kept.some((k) => Math.abs(k.price - c.price) < LEVEL_SEP_ATR * atr)) continue;
        kept.push(c);
      }
      return kept;
    };
    plan.levels = [...pick(true), ...pick(false)]
      .sort((a, b) => a.price - b.price)
      .map((c) => c.d);
  }

  // ── 3. zones: nearest FRESH supply above + demand below (state active) ──
  {
    const supply = (z: ZoneD) => z.side === "supply" || z.side === "ob_bear" || z.side === "fvg_bear";
    const demand = (z: ZoneD) => z.side === "demand" || z.side === "ob_bull" || z.side === "fvg_bull";
    const fresh = (z: ZoneD) => z.state !== "faded" && z.mitT == null;
    const zs = K("zone") as ZoneD[];
    const bestAbove = zs
      .filter((z) => supply(z) && fresh(z) && z.lo > lastBar.c - 0.2 * atr)
      .sort((a, b) => a.lo - b.lo)[0] ?? null;
    const bestBelow = zs
      .filter((z) => demand(z) && fresh(z) && z.hi < lastBar.c + 0.2 * atr)
      .sort((a, b) => b.hi - a.hi)[0] ?? null;
    plan.zones = [bestAbove, bestBelow].filter(Boolean) as ZoneD[];
  }

  // ── 4. trend: ≤2 unbroken trendlines (+ channel as one entry) ──
  {
    const tls = (K("trendline") as TrendD[]).filter((d) => d.kind !== "trendline" || (!d.broken && d.state !== "faded"));
    const chans = K("channel") as TrendD[];
    // rank: span (how long the market respected it) then recency
    const span = (d: TrendD) =>
      d.kind === "trendline" ? Math.abs(d.t2 - d.t1) : Math.abs(d.lower.t2 - d.lower.t1);
    const merged = [...tls, ...chans]
      .map((d) => ({ d, span: span(d) }))
      .sort((a, b) => b.span - a.span)
      .slice(0, 2);
    plan.trend = merged.map((m) => m.d);
  }

  // ── 5. candlestick patterns: ≤3 recent, live setups first, no overlap ──
  {
    const cs = K("candle") as CandleD[];
    const relevant = cs.filter((d) => {
      const age = barsAgo(d.t1);
      if (d.status === "expired") return false;
      if (d.status === "fresh") return age <= 40;
      if (d.status === "confirmed") return age <= 70;
      return age <= 14; // failed: recent lessons only
    });
    // dedupe overlapping boxes: same market moment keeps ONE pattern —
    // the higher-confidence one (a hammer inside an engulfing is one story)
    const chosen: CandleD[] = [];
    for (const d of relevant.sort((a, b) => b.confidence - a.confidence)) {
      const overlaps = chosen.some((c) => d.t0 <= c.t1 && c.t0 <= d.t1);
      if (!overlaps) chosen.push(d);
    }
    // freshest first on the chart, cap 3
    plan.candles = chosen.sort((a, b) => b.t1 - a.t1).slice(0, 3);
  }

  // (the classic chart pattern was picked in step 0 — its plan prices join
  //  the hero prices that squeeze the level budget)

  // ── 8. events + sweeps: the last 2 of each, recent window ──
  plan.events = (K("structure") as EventD[])
    .filter((d) => barsAgo(d.t) <= 60)
    .sort((a, b) => b.t - a.t)
    .slice(0, 2)
    .reverse() as EventD[];
  plan.sweeps = (K("sweep") as SweepD[])
    .filter((d) => barsAgo(d.t) <= 60)
    .sort((a, b) => b.t - a.t)
    .slice(0, 2)
    .reverse() as SweepD[];

  // ── 9. fib: only when no hero pattern/setup owns the chart ──
  plan.fib =
    !plan.setup && !plan.pattern
      ? ((K("fib")[0] as FibD) ?? null)
      : null;

  // ── 10. momentum ribbon (single drawing) ──
  plan.momentum = (K("momentum")[0] as MomentumD) ?? null;

  // ── 11. narrative: the CURRENT instance of each story (layer-gated) ──
  {
    const out: NarrativeD[] = [];
    const lastOf = (kind: string): NarrativeD | null => {
      const list = K(kind) as NarrativeD[];
      for (const d of list) {
        const t = (d as { t?: number; t0?: number }).t ?? (d as { t0?: number }).t0 ?? 0;
        if (t && barsAgo(t) > 120) continue;
        return d;
      }
      return null;
    };
    // the LIVE amd phase, the latest consolidation, the freshest instit mark,
    // the current forecast — one of each, never history
    const amd = (K("amd") as NarrativeD[]).find((d) => !(d as { done: boolean }).done) ?? null;
    if (amd) out.push(amd);
    const range = lastOf("range");
    if (range) out.push(range);
    const instit = (K("instit") as NarrativeD[]).sort((a, b) => (b as { t: number }).t - (a as { t: number }).t)[0];
    if (instit && barsAgo((instit as { t: number }).t) <= 40) out.push(instit);
    const forecast = lastOf("forecast");
    if (forecast) out.push(forecast);
    const path = lastOf("path");
    if (path) out.push(path);
    plan.narrative = out;
  }

  plan.stats.kept =
    plan.swings.length + (plan.zigzag ? 1 : 0) + plan.levels.length + plan.zones.length +
    plan.trend.length + plan.candles.length + (plan.pattern ? 1 : 0) +
    (plan.setup ? 1 : 0) + (plan.tfSetup ? 1 : 0) + plan.events.length +
    plan.sweeps.length + (plan.fib ? 1 : 0) + (plan.momentum ? 1 : 0) + plan.narrative.length;
  return plan;
}

// ── helpers ────────────────────────────────────────────────────────────────

function tfSeconds(tf: string): number {
  const map: Record<string, number> = {
    M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
  };
  return map[tf] ?? 900;
}

function levelT(d: LevelD): number | null {
  if (d.kind === "hline") return d.t ?? null;
  if (d.kind === "liq") return d.t;
  return null; // magnets carry no origin time
}

function levelActive(d: LevelD): boolean {
  if (d.kind === "liq") return d.state === "untouched";
  return true; // hlines/magnets have no lifecycle
}
