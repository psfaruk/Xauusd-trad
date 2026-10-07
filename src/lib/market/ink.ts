/**
 * ink.ts — THE CLEAN INK BUILDER (v21.0 chart rewrite)
 *
 * User spec (বাংলা): "যখন যেই ড্রয়িং টি chart এ দরকার সেই ড্রয়িং টি থাকবে" —
 * ONLY what the chart needs, nothing else. The old layer minted ~96
 * candidates across 19 kinds and even the budget pass left the chart
 * "এলোমেলো" (messy, overlapping, overwritten).
 *
 * The new grammar is deliberately tiny and computed CLIENT-SIDE from the
 * bars already on the chart (no server round-trip, no staleness):
 *
 *   swings   — the last 6 major swing pivots, tagged HH/HL/LH/LL
 *   zigzag   — one thin line through exactly those pivots (ONE structure story)
 *   levels   — the 2 levels that matter NOW: nearest swing high above the
 *              price (R) and nearest swing low below it (S)
 *   decision — the AI Board's latest decision (entry/SL/TP + OB + trendline),
 *              passed through — fresh only (≤ 6 bars old), else null
 */

import type { BoardSessionPayload, Candle } from "./types";
import { swings } from "./indicators";

export interface SwingTag {
  t: number;
  price: number;
  tag: "HH" | "HL" | "LH" | "LL";
  side: "high" | "low";
}

export interface CleanLevel {
  price: number;
  side: "resistance" | "support";
}

export interface CleanInk {
  swings: SwingTag[];
  zigzag: { t: number; p: number }[];
  levels: CleanLevel[];
  decision: BoardSessionPayload | null;
}

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/** how many bars a decision stays on the chart (the plan's shelf life) */
export const DECISION_MAX_BARS = 6;

export function buildCleanInk(
  bars: Candle[],
  timeframe: string,
  decision: BoardSessionPayload | null,
): CleanInk {
  const closed = bars.filter((b) => !b.f);
  const out: CleanInk = { swings: [], zigzag: [], levels: [], decision: null };
  if (closed.length < 40) return out;

  const win = closed.slice(-220);
  const price = closed[closed.length - 1].c;

  // ── major swings (3/3 fractals) tagged by the previous same-kind pivot ──
  const sw = swings(win, 3, 3);
  const tagged: SwingTag[] = [];
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  for (const s of sw) {
    if (s.kind === "high") {
      const tag = lastHigh == null ? "HH" : s.price > lastHigh ? "HH" : "LH";
      tagged.push({ t: s.t, price: s.price, tag, side: "high" });
      lastHigh = s.price;
    } else {
      const tag = lastLow == null ? "LL" : s.price > lastLow ? "HL" : "LL";
      tagged.push({ t: s.t, price: s.price, tag, side: "low" });
      lastLow = s.price;
    }
  }
  // the LAST 6 pivots, oldest → newest (the recent structure story)
  out.swings = tagged.slice(-6);
  // zigzag threads exactly those pivots — one line, one story
  out.zigzag = out.swings.map((s) => ({ t: s.t, p: s.price }));

  // ── the 2 levels that matter: nearest unbroken swing high/low ──
  const r = sw.filter((s) => s.kind === "high" && s.price > price)
    .sort((a, b) => a.price - b.price)[0];
  const s2 = sw.filter((s) => s.kind === "low" && s.price < price)
    .sort((a, b) => b.price - a.price)[0];
  if (r) out.levels.push({ price: r.price, side: "resistance" });
  if (s2) out.levels.push({ price: s2.price, side: "support" });

  // ── the AI Board decision — fresh only, same market ──
  if (decision) {
    const tfSec = TF_SEC[timeframe] ?? 900;
    const lastT = closed[closed.length - 1].t;
    const ageBars = Math.max(0, Math.round((lastT - decision.barTime) / tfSec));
    const tradable =
      decision.decision.action !== "HOLD" &&
      decision.decision.entry != null &&
      decision.decision.sl != null &&
      decision.decision.tp != null;
    if (ageBars <= DECISION_MAX_BARS && tradable) {
      out.decision = decision;
    }
  }

  return out;
}
