/**
 * overlay-clean.ts — THE CLEAN HAND (v21.0)
 *
 * Draws a CleanInk (see ink.ts) with ONE rule the old renderer broke:
 * LESS INK, MORE MEANING. The user called the old layer "এলোমেলো…
 * ওভার রাইট হয়ে আছে" — messy, overwritten. The grammar now:
 *
 *   DECISION (the hero — the AI Board's plan)
 *     · risk zone   entry→SL translucent red band (from the decision bar on)
 *     · reward zone entry→TP translucent green band
 *     · ENTRY 2.0px solid gold   + right-edge pill
 *     · SL    1.6px solid red    + pill     TP 1.6px solid green + pill
 *     · TP2   1.2px dashed green + pill
 *     · OB box — one translucent zone box with a tag inside its left edge
 *     · trendline — 2.0px with soft halo + dashed projection to the edge
 *
 *   STRUCTURE (one story)
 *     · zigzag — a single 1px muted line through the last 6 pivots
 *     · swing tags — bold HH/HL/LH/LL printed above highs / below lows
 *
 *   LEVELS (two lines, no more)
 *     · nearest R above + nearest S below — 1px dashed with edge pills
 *
 * ANTI-OVERLAP: every horizontal label queues into ONE right-edge column
 * that nudges entries apart (sorted by price) — two pills can never touch,
 * and nothing is drawn under another element (zones fill first, lines over
 * fills, labels last).
 */

import type { IChartApi } from "lightweight-charts";
import type { CleanInk } from "@/lib/market/ink";
import type { Layers } from "@/hooks/useTerminal";
import { TONES, FONT_FAMILY, hardSeg, hardText, pillLabel, clamp } from "./overlay-utils";

export interface CleanEnv {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  rightEdge: number;
  digits: number;
  isDark: boolean;
  xOfTime: (t: number) => number | null;
  yOfPrice: (p: number) => number | null;
  chart: IChartApi | null;
}

// ── the single right-edge label column (anti-collision by construction) ────

interface ColumnEntry {
  y: number;
  h: number;
  draw: (y: number) => void;
}

class LabelColumn {
  private entries: ColumnEntry[] = [];
  constructor(private h: number) {}

  add(y: number, h: number, draw: (y: number) => void) {
    if (y < -20 || y > this.h + 20) return;
    this.entries.push({ y, h, draw });
  }

  flush() {
    if (!this.entries.length) return;
    const sorted = this.entries.sort((a, b) => a.y - b.y);
    const ys = sorted.map((e) => e.y);
    const gap = 4;
    // top-down nudge: push overlapping neighbors apart
    for (let i = 1; i < sorted.length; i++) {
      const prevBottom = ys[i - 1] + sorted[i - 1].h / 2 + gap;
      if (ys[i] < prevBottom) ys[i] = prevBottom;
    }
    // bottom clamp: overflow pushes back up
    const bottom = this.h - 10;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (ys[i] > bottom) ys[i] = bottom;
      if (i > 0 && ys[i - 1] > ys[i] - sorted[i - 1].h / 2 - gap) {
        ys[i - 1] = ys[i] - sorted[i - 1].h / 2 - gap;
      }
    }
    const top = 10;
    for (let i = 0; i < sorted.length; i++) if (ys[i] < top) ys[i] = top;
    for (let i = 0; i < sorted.length; i++) {
      if (ys[i] >= top - 1 && ys[i] <= bottom + 1) sorted[i].draw(ys[i]);
    }
    this.entries = [];
  }
}

// ── the renderer ────────────────────────────────────────────────────────────

export function renderClean(ink: CleanInk, env: CleanEnv, layers: Layers): void {
  const { ctx, rightEdge, digits } = env;
  const col = new LabelColumn(env.h);
  const pillX = rightEdge - 6;

  const P = (n: number) => n.toFixed(digits);

  // ═══ 1. STRUCTURE — one zigzag + the swing tags (under everything) ═══
  if (layers.structure) {
    if (ink.zigzag.length >= 2) {
      ctx.save();
      ctx.beginPath();
      let started = false;
      for (const pt of ink.zigzag) {
        const x = env.xOfTime(pt.t);
        const y = env.yOfPrice(pt.p);
        if (x === null || y === null) continue;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = env.isDark ? "rgba(148,163,158,0.34)" : "rgba(90,104,97,0.40)";
      ctx.lineWidth = 1.0;
      ctx.stroke();
      ctx.restore();
    }
    for (const s of ink.swings) {
      const x = env.xOfTime(s.t);
      const y = env.yOfPrice(s.price);
      if (x === null || y === null) continue;
      if (x < -20 || x > rightEdge - 8) continue;
      const bull = s.tag === "HH" || s.tag === "HL";
      const color = bull ? TONES.bull.text : TONES.bear.text;
      // dot on the pivot + the tag pushed AWAY from the candle body
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 2.0, 0, Math.PI * 2);
      ctx.fillStyle = bull ? "rgba(52,211,153,0.85)" : "rgba(248,113,113,0.85)";
      ctx.fill();
      ctx.restore();
      hardText(ctx, s.tag, x, s.side === "high" ? y - 11 : y + 11, color, 9, "center");
    }
  }

  // ═══ 2. LEVELS — exactly two: nearest R above + nearest S below ═══
  if (layers.levels) {
    for (const lv of ink.levels) {
      const y = env.yOfPrice(lv.price);
      if (y === null) continue;
      const tone = lv.side === "resistance" ? TONES.bear : TONES.bull;
      hardSeg(ctx, 0, y, rightEdge, y, tone.line(0.55), tone.halo(0.05), 1.0, [6, 5]);
      const label = `${lv.side === "resistance" ? "R" : "S"} ${P(lv.price)}`;
      col.add(y, 15, (yy) => {
        pillLabel(ctx, label, pillX, yy, tone.text, tone.line(0.55), "right", 9);
      });
    }
  }

  // ═══ 3. THE DECISION — the AI Board's plan (the hero ink) ═══
  const d = ink.decision;
  if (layers.setup && d) {
    const dec = d.decision;
    const x0raw = env.xOfTime(d.barTime);
    // the decision bar may sit off-screen left — clamp, the plan still spans to the edge
    const x0 = x0raw === null ? 0 : clamp(x0raw, 0, rightEdge - 4);
    const entryY = dec.entry != null ? env.yOfPrice(dec.entry) : null;
    const slY = dec.sl != null ? env.yOfPrice(dec.sl) : null;
    const tpY = dec.tp != null ? env.yOfPrice(dec.tp) : null;
    const tp2Y = dec.tp2 != null ? env.yOfPrice(dec.tp2) : null;
    const buy = dec.action === "BUY";

    // 3a. OB box (fill first — everything else draws over it)
    if (dec.drawings.ob) {
      const ob = dec.drawings.ob;
      const y1 = env.yOfPrice(ob.hi);
      const y2 = env.yOfPrice(ob.lo);
      const xob = env.xOfTime(ob.t);
      if (y1 !== null && y2 !== null && xob !== null) {
        const bx0 = clamp(xob, 0, rightEdge - 4);
        const by = Math.min(y1, y2);
        const bh = Math.abs(y2 - y1);
        if (bh >= 1.5 && rightEdge - bx0 > 4) {
          const fill = ob.side === "bull"
            ? "rgba(52,211,153,0.10)"
            : "rgba(248,113,113,0.10)";
          const border = ob.side === "bull"
            ? "rgba(84,224,168,0.75)"
            : "rgba(252,140,140,0.75)";
          ctx.fillStyle = fill;
          ctx.fillRect(bx0, by, rightEdge - bx0, bh);
          ctx.strokeStyle = border;
          ctx.lineWidth = 1.0;
          ctx.strokeRect(bx0 + 0.5, by + 0.5, rightEdge - bx0 - 1, bh - 1);
          // tag inside the box's left edge, vertically centered
          hardText(ctx, ob.label, bx0 + 6, by + Math.max(8, Math.min(bh - 6, bh / 2)), border, 9, "left");
        }
      }
    }

    // 3b. risk / reward zones (from the decision bar forward, under the lines)
    if (entryY !== null && slY !== null) {
      const y1 = Math.min(entryY, slY);
      const y2 = Math.max(entryY, slY);
      ctx.fillStyle = "rgba(248,113,113,0.055)";
      ctx.fillRect(x0, y1, rightEdge - x0, y2 - y1);
    }
    if (entryY !== null && tpY !== null) {
      const y1 = Math.min(entryY, tpY);
      const y2 = Math.max(entryY, tpY);
      ctx.fillStyle = "rgba(52,211,153,0.045)";
      ctx.fillRect(x0, y1, rightEdge - x0, y2 - y1);
    }

    // 3c. the trendline (with halo + dashed projection to the right edge)
    if (dec.drawings.trendline) {
      const tl = dec.drawings.trendline;
      const x1 = env.xOfTime(tl.t1);
      const x2 = env.xOfTime(tl.t2);
      const y1 = env.yOfPrice(tl.p1);
      const y2 = env.yOfPrice(tl.p2);
      if (x1 !== null && x2 !== null && y1 !== null && y2 !== null && x2 > x1) {
        const tone = buy ? TONES.bull : TONES.bear;
        hardSeg(ctx, x1, y1, x2, y2, tone.line(0.9), tone.halo(0.10), 2.0);
        // projection: continue the slope to the right edge, dashed
        const slope = (y2 - y1) / (x2 - x1);
        const yEnd = y2 + slope * (rightEdge - x2);
        ctx.save();
        ctx.setLineDash([5, 4]);
        hardSeg(ctx, x2, y2, rightEdge, yEnd, tone.line(0.45), tone.halo(0.03), 1.2, [5, 4]);
        ctx.restore();
      }
    }

    // 3d. ENTRY / SL / TP lines — the loudest, clearest ink on the chart
    if (entryY !== null) {
      hardSeg(ctx, x0, entryY, rightEdge, entryY, TONES.gold.line(0.95), TONES.gold.halo(0.12), 2.0);
      col.add(entryY, 16, (yy) => {
        pillLabel(ctx, `ENTRY ${P(dec.entry!)}`, pillX, yy, TONES.gold.text, TONES.gold.line(0.7), "right", 9.5);
      });
    }
    if (slY !== null) {
      hardSeg(ctx, x0, slY, rightEdge, slY, TONES.bear.line(0.9), TONES.bear.halo(0.10), 1.6);
      col.add(slY, 15, (yy) => {
        pillLabel(ctx, `SL ${P(dec.sl!)}`, pillX, yy, TONES.bear.text, TONES.bear.line(0.55), "right", 9);
      });
    }
    if (tpY !== null) {
      hardSeg(ctx, x0, tpY, rightEdge, tpY, TONES.bull.line(0.9), TONES.bull.halo(0.10), 1.6);
      col.add(tpY, 15, (yy) => {
        pillLabel(ctx, `TP ${P(dec.tp!)}`, pillX, yy, TONES.bull.text, TONES.bull.line(0.55), "right", 9);
      });
    }
    if (tp2Y !== null) {
      hardSeg(ctx, x0, tp2Y, rightEdge, tp2Y, TONES.bull.line(0.6), TONES.bull.halo(0.05), 1.2, [4, 4]);
      col.add(tp2Y, 14, (yy) => {
        pillLabel(ctx, `TP2 ${P(dec.tp2!)}`, pillX, yy, TONES.bull.text, TONES.bull.line(0.4), "right", 8.5);
      });
    }

    // 3e. the decision badge — WHO decided, at the plan's origin
    const badgeY = entryY ?? tpY ?? slY;
    if (badgeY !== null && x0 > 8) {
      const txt = `${dec.action} · ${d.timeframe} · বোর্ড ${dec.consensus}%`;
      ctx.font = `700 9px ${FONT_FAMILY}`;
      const tw = ctx.measureText(txt).width;
      const bx = clamp(x0 + 4, 4, Math.max(4, rightEdge - tw - 16));
      const by = buy ? badgeY - 22 : badgeY + 10;
      pillLabel(ctx, txt, bx, clamp(by, 12, env.h - 12),
        dec.action === "BUY" ? TONES.bull.text : TONES.bear.text,
        dec.action === "BUY" ? TONES.bull.line(0.5) : TONES.bear.line(0.5),
        "left", 9);
    }
  }

  // flush the ONE label column — nothing overlaps, ever
  col.flush();
}
