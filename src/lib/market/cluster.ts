/**
 * v17.0 — cross-source level clustering & priority policy (user audit).
 *
 * The problem this module solves: the chart's level ink comes from MANY
 * independent detectors — HTF supply/demand, local zones, order blocks,
 * FVGs, liquidity pools, roadmap magnets, the EQ line — and they routinely
 * agree: "4162 is a level" gets painted as an H4 supply, an M15 bull OB, a
 * BSL pool AND a PDH magnet → four lines in one place, labels stacked,
 * none of them readable.
 *
 * Policy (the audit's exact hierarchy):
 *
 *   tier 1 — HTF key level   (H1/H4-sourced supply/demand zone)
 *   tier 2 — fresh OB/FVG    (unmitigated order block / fair-value gap)
 *   tier 3 — local S/R       (active-tf supply/demand, liquidity pool,
 *                             magnet, EQ)
 *   tier 4 — pattern         (chart-pattern confluence — NOT removed, only
 *                             credited in the winner's merge rationale)
 *
 * Levels within CLUSTER_ATR of each other form ONE cluster; the best-tier
 * (freshest on ties) member keeps the ink and its `mergedFrom` lists every
 * duplicate it absorbed. Absorbed items stay in the array carrying
 * `mergedInto` (the winner's id) — the renderer hides them by default and
 * the "show merged duplicates" filter can bring them back.
 *
 * Everything also gets a deterministic stable `id` (same input data → same
 * id across polls) and level winners get a visibility `rank` (1 = nearest
 * to the live price) so the UI can cap how many levels show by default.
 */

import type { AutoDrawing } from "./types";

/** two levels within this many ATRs are the SAME level */
export const CLUSTER_ATR = 0.22;
/** the default visible-level budget (the ink filter's slider default) */
export const DEFAULT_MAX_LEVELS = 8;

/** timeframe seniority — used both for tier-1 detection and the UI's
 *  "hide HTF-sourced ink" filter */
export const TF_ORDER: Record<string, number> = {
  M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7, W1: 8, MN1: 9,
};

export interface ClusterOptions {
  /** ATR of the active timeframe (price units) — the clustering ruler */
  atr: number;
  /** live price — the visibility rank is distance-ordered from here */
  price: number;
  /** the chart's own timeframe (its zones/pools are "local") */
  activeTf: string;
  /** last closed bar time (sec) — freshness ruler */
  lastBarT: number;
  /** seconds per active-tf bar */
  tfSec: number;
}

interface Candidate {
  i: number;              // index into the drawings array
  price: number;          // the action price of this level
  label: string;          // human rationale: "H4 supply", "M15 bull OB"
  tier: 1 | 2 | 3;
  ageBars: number;        // smaller = fresher (0 = timeless)
  /** v17.1: within-tier strength — the S/R hit count. A 9-touch support
   *  beats a plain EQ midpoint sitting at the same price (same tier,
   *  more evidence wins before freshness is consulted). */
  strength: number;
}

const ZONE_EDGE_NAME: Record<string, string> = {
  supply: "supply", demand: "demand", ob_bull: "bull OB", ob_bear: "bear OB",
  fvg_bull: "bull FVG", fvg_bear: "bear FVG",
};

/** deterministic identity for any drawing kind — stable across polls as
 *  long as the underlying data is stable (the acceptance-criteria contract:
 *  "every auto-drawing has a stable ID"). */
function assignId(d: AutoDrawing, tf: string): string {
  const p2 = (n: number) => n.toFixed(2);
  switch (d.kind) {
    case "hline":
      // v17.1: an MTF S/R level's identity includes its source tf + side —
      // "H1 resistance at 4162" stays H1 resistance at 4162 across polls
      return d.source_tf != null && d.side != null
        ? `hline|${d.source_tf}|${d.side}|${p2(d.price)}`
        : `hline|${d.label}|${p2(d.price)}`;
    case "zone": return `zone|${d.source_tf ?? tf}|${d.side}|${d.t}`;
    case "liq": return `liq|${d.side}|${d.t}`;
    case "magnet": return `magnet|${d.source}|${p2(d.price)}`;
    case "setup": return `setup|${d.tf ?? tf}|${d.t0}|${d.dir}`;
    case "trendline": return `trendline|${d.source_tf ?? tf}|${d.t1}|${d.t2}`;
    case "channel": return `channel|${d.source_tf ?? tf}|${d.upper.t1}|${d.upper.t2}`;
    case "fib": return `fib|${d.t0}|${d.t1}`;
    case "structure": return `structure|${d.source_tf ?? tf}|${d.label}|${d.t}`;
    case "zigzag": return `zigzag|${d.points[0]?.t ?? 0}|${d.points[d.points.length - 1]?.t ?? 0}`;
    case "swing": return `swing|${d.tag}|${d.t}`;
    case "sweep": return `sweep|${d.t}|${d.side}`;
    case "arrow": return `arrow|${d.t}|${d.dir}`;
    case "range": return `range|${d.source_tf ?? tf}|${d.t0}`;
    case "amd": return `amd|${d.phase}|${d.t0}`;
    case "instit": return `instit|${d.t}`;
    case "forecast": return `forecast|${p2(d.from)}`;
    case "path": return `path|${d.dir}|${p2(d.to_price)}`;
    case "pattern": return `pattern|${d.source_tf ?? tf}|${d.name}|${d.points[0]?.t ?? 0}`;
    case "tf_setup": return `tf_setup|${d.tf}|${p2(d.entry)}`;
    case "momentum": return `momentum|${d.source_tf ?? tf}|${d.bars[d.bars.length - 1]?.t ?? 0}`;
    default: return `unk|${(d as { kind?: string }).kind ?? "?"}`;
  }
}

/** Annotate, cluster, prioritize, rank. Returns the SAME array (mutated
 *  in place with id / rank / mergedFrom / mergedInto). */
export function clusterLevels(drawings: AutoDrawing[], opts: ClusterOptions): AutoDrawing[] {
  const { atr, price, activeTf, lastBarT, tfSec } = opts;
  const barsAge = (t: number) => Math.max(0, Math.round((lastBarT - t) / Math.max(1, tfSec)));

  // 1. stable ids for everything (cheap, order-independent)
  for (const d of drawings) d.id = assignId(d, activeTf);

  if (!(atr > 0)) return drawings; // no ruler → identity only, no clustering

  // 2. collect level candidates
  const cands: Candidate[] = [];
  for (let i = 0; i < drawings.length; i++) {
    const d = drawings[i];
    if (d.kind === "hline") {
      // v17.1 — MTF S/R key levels: an H1/H4-sourced level is a TIER-1
      // "HTF key level" (the audit's top of the hierarchy); an active-tf
      // level is tier-3 local S/R. The plain EQ line stays tier-3 timeless.
      const isSr = d.side != null;
      if (isSr) {
        const htf = d.source_tf != null && (TF_ORDER[d.source_tf] ?? 0) > (TF_ORDER[activeTf] ?? 0);
        cands.push({
          i,
          price: d.price,
          label: `${d.source_tf ?? activeTf} ${d.side === "resistance" ? "resistance" : "support"}${(d.hits ?? 1) > 1 ? ` ×${d.hits}` : ""}`,
          tier: htf ? 1 : 3,
          ageBars: barsAge(d.t ?? lastBarT),
          strength: d.hits ?? 1,
        });
      } else {
        cands.push({ i, price: d.price, label: `${d.label} (equilibrium)`, tier: 3, ageBars: 0, strength: 0 });
      }
      continue;
    }
    if (d.kind === "liq") {
      // only LIVE pools cluster — swept/run pools are history (X marks)
      if (d.state !== "untouched") continue;
      cands.push({ i, price: d.price, label: `${d.side} pool ${d.price.toFixed(2)}`, tier: 3, ageBars: barsAge(d.t), strength: 0 });
      continue;
    }
    if (d.kind === "magnet") {
      cands.push({ i, price: d.price, label: `magnet ${d.source}`, tier: 3, ageBars: 0, strength: 0 });
      continue;
    }
    if (d.kind === "zone") {
      // the ACTION edge: where price actually meets the zone — a supply/
      // bear zone is tested from below (its `lo`), a demand/bull zone from
      // above (its `hi`)
      const bear = d.side === "supply" || d.side === "ob_bear" || d.side === "fvg_bear";
      const edge = bear ? d.lo : d.hi;
      const htf = d.source_tf != null && (TF_ORDER[d.source_tf] ?? 0) > (TF_ORDER[activeTf] ?? 0);
      const freshOB = (d.side.startsWith("ob") || d.side.startsWith("fvg")) && d.state === "active" && d.mitT == null;
      const tier: 1 | 2 | 3 = htf ? 1 : freshOB ? 2 : 3;
      cands.push({
        i,
        price: edge,
        label: `${d.source_tf ?? activeTf} ${ZONE_EDGE_NAME[d.side] ?? d.side}${d.institutional ? " · INST" : ""}`,
        tier,
        ageBars: barsAge(d.t),
        strength: 0,
      });
    }
  }
  if (cands.length < 2) return drawings;

  // 3. cluster by price proximity (sort + sweep; a candidate joins the
  //    cluster while it is within CLUSTER_ATR of the running MEAN — the
  //    mean anchor stops chains from drifting across the whole range)
  cands.sort((a, b) => a.price - b.price);
  const clusters: Candidate[][] = [];
  let cur: Candidate[] = [];
  let curSum = 0;
  for (const c of cands) {
    if (!cur.length) {
      cur = [c];
      curSum = c.price;
      continue;
    }
    const mean = curSum / cur.length;
    if (Math.abs(c.price - mean) <= CLUSTER_ATR * atr) {
      cur.push(c);
      curSum += c.price;
    } else {
      clusters.push(cur);
      cur = [c];
      curSum = c.price;
    }
  }
  if (cur.length) clusters.push(cur);

  // 4. per cluster: pick the winner (tier → freshness), absorb the rest
  const clusterWinners: { lead: Candidate; price: number }[] = [];
  for (const cl of clusters) {
    if (cl.length === 1) {
      clusterWinners.push({ lead: cl[0], price: cl[0].price });
      continue;
    }
    const ranked = [...cl].sort(
      (a, b) => a.tier - b.tier || b.strength - a.strength || a.ageBars - b.ageBars || Math.abs(a.price - price) - Math.abs(b.price - price),
    );
    const win = ranked[0];
    const winD = drawings[win.i];
    const absorbedLabels: string[] = [];
    for (const c of cl) {
      if (c === win) continue;
      const dd = drawings[c.i];
      dd.mergedInto = winD.id;
      absorbedLabels.push(c.label);
    }
    // pattern confluence (tier 4 — never removed, only credited): a
    // CONFIRMED pattern whose entry sits in this cluster's range is part
    // of the merge rationale
    const lo = Math.min(...cl.map((c) => c.price)) - CLUSTER_ATR * atr;
    const hi = Math.max(...cl.map((c) => c.price)) + CLUSTER_ATR * atr;
    for (const d of drawings) {
      if (d.kind !== "pattern" || d.state !== "confirmed") continue;
      if (d.entry.price >= lo && d.entry.price <= hi) {
        absorbedLabels.push(`pattern ${d.name} entry`);
      }
    }
    winD.mergedFrom = absorbedLabels;
    clusterWinners.push({ lead: win, price: win.price });
  }

  // 5. visibility rank — nearest to the live price first (tier breaks
  //    exact ties); the renderer shows only the first maxLevels of these
  //    (single-member clusters rank too: an unduplicated level is still
  //    subject to the visible-count budget)
  clusterWinners
    .map((w, ci) => ({ ...w, ci }))
    .sort(
      (a, b) =>
        Math.abs(a.price - price) - Math.abs(b.price - price) || a.lead.tier - b.lead.tier,
    )
    .forEach((w, idx) => {
      drawings[w.lead.i].rank = idx + 1;
    });

  return drawings;
}
