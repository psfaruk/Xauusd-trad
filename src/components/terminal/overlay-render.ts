/**
 * overlay-render.ts — THE CLEAN HAND (v20.0 rewrite of the chart-drawing layer)
 *
 * This module DRAWS an InkPlan (see inkSelect.ts — the brain that decides
 * what deserves ink). The old renderer decided-and-drew in one 1500-line
 * switch: every engine candidate painted, labels stacked over labels, dead
 * ink over the live price area — the user read it as "এলোমেলো… ওভার রাইট
 * হয়ে আছে" (messy, overwritten).
 *
 * The new grammar is deliberate:
 *
 *   ONE VOICE PER CONCEPT   the plan already capped every slot — the renderer
 *                           never adds ink of its own
 *   ONE LABEL COLUMN        every horizontal-level label lives in the single
 *                           right-edge column, vertically NUDGED apart — two
 *                           labels can never overlap, and none is ever
 *                           dropped for losing a collision race
 *   CLEAR LINE WEIGHTS      structure spine 1.0px · levels 0.9px · trendlines
 *                           1.05px core + dashed projection · zone borders
 *                           0.6px — the eye ranks them without thinking
 *   NOTHING DEAD OVER PRICE swept pools/broken lines draw quiet-dashed at
 *                           ≤40% alpha, and only when the user allows faded
 *                           ink; mitigated zones never paint forward
 */

import type { IChartApi } from "lightweight-charts";
import type { InkPlan, LevelD } from "@/lib/market/inkSelect";
import type { Layers } from "@/hooks/useTerminal";
import type { AutoDrawing } from "@/lib/market/types";
import {
  TONES,
  ZONE_STYLE,
  FONT_FAMILY,
  hardSeg,
  hardText,
  pillLabel,
  arrow,
  diamond,
  xMark,
  clamp,
} from "./overlay-utils";

type SetupD = Extract<AutoDrawing, { kind: "setup" }>;
type TfSetupD = Extract<AutoDrawing, { kind: "tf_setup" }>;
type PatternD = Extract<AutoDrawing, { kind: "pattern" }>;
type MomentumD = Extract<AutoDrawing, { kind: "momentum" }>;

/** positional tones: ink above the live price reads bear/red (resistance),
 *  ink below reads bull/green (support) — same coding as the zones */
const upTone = TONES.bull;
const dnTone = TONES.bear;

// ── environment: everything the renderer needs from the host chart ─────────

export interface RenderEnv {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  rightEdge: number;
  barSpacing: number;
  digits: number;
  isDark: boolean;
  narrow: boolean;
  timeframe: string;
  tfSec: number;
  lastBarT: number;
  lastPrice: number;
  xOfTime: (t: number) => number | null;
  yOfPrice: (p: number) => number | null;
  chart: IChartApi | null;
}

export interface LevelTipBand {
  x1: number; y1: number; x2: number; y2: number;
  title: string; price: string; sourceTf?: string; mergedFrom?: string[];
}

export interface RenderOut {
  tips: LevelTipBand[];
}

// ── the right-edge label column ────────────────────────────────────────────

interface ColumnEntry {
  y: number;            // desired y (the line's y)
  h: number;            // label height
  draw: (y: number) => void;
}

/**
 * The single right-edge column. All horizontal-ink labels (levels, setup
 * contract badges, fib golden ratios) queue here; `flush()` sorts by y and
 * NUDGES entries apart so no two labels ever touch — TradingView-style.
 */
class RightColumn {
  private entries: ColumnEntry[] = [];
  constructor(private w: number, private h: number) {}

  add(y: number, h: number, draw: (y: number) => void) {
    if (y < -20 || y > this.h + 20) return;
    this.entries.push({ y, h, draw });
  }

  flush() {
    if (!this.entries.length) return;
    const sorted = this.entries.sort((a, b) => a.y - b.y);
    // nudge pass: push apart overlapping neighbors (top-down)
    const ys = sorted.map((e) => e.y);
    const gap = 5;
    for (let i = 1; i < sorted.length; i++) {
      const prevBottom = ys[i - 1] + sorted[i - 1].h / 2 + gap;
      if (ys[i] < prevBottom) ys[i] = prevBottom;
    }
    // clamp pass: if the column overflowed the bottom, push back up
    const bottom = this.h - 12;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (ys[i] > bottom) ys[i] = bottom;
      if (i > 0 && ys[i - 1] > ys[i] - sorted[i - 1].h / 2 - gap) {
        ys[i - 1] = ys[i] - sorted[i - 1].h / 2 - gap;
      }
    }
    const top = 12;
    for (let i = 0; i < sorted.length; i++) {
      if (ys[i] < top) ys[i] = top;
    }
    // draw — entries that still don't fit the viewport are simply skipped
    for (let i = 0; i < sorted.length; i++) {
      if (ys[i] >= top - 1 && ys[i] <= bottom + 1) sorted[i].draw(ys[i]);
    }
    this.entries = [];
  }
}

/** floating-label registry — pattern tags / swing words / zone labels.
 *  Unlike the old system (labels silently DROPPED on collision), a label
 *  first tries to nudge ±12px vertically before giving up. The RIGHT STRIP
 *  (where the label column lives) is reserved: a floating label that would
 *  enter it shifts LEFT, staying beside its own pattern instead of landing
 *  on top of a level pill (v20.1 audit: "MARUBOZU ▼79" printed over "S 4167"). */
class FloatingLabels {
  private boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

  place(x: number, y: number, w: number, h: number, priority = false, rightEdge = Infinity): number | null {
    // keep floats out of the right-edge label strip (shift left, clamp to plot)
    const stripW = 110;
    let x0 = x;
    if (Number.isFinite(rightEdge) && x0 + w / 2 > rightEdge - stripW) {
      x0 = Math.max(10 + w / 2, rightEdge - stripW - w / 2);
    }
    const test = (ty: number, tx: number) => {
      const b = { x1: tx - w / 2 - 2, y1: ty - h / 2 - 2, x2: tx + w / 2 + 2, y2: ty + h / 2 + 2 };
      return this.boxes.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1) ? null : b;
    };
    const tries = priority ? [0] : [0, -13, 13, -26, 26];
    for (const dy of tries) {
      const b = test(y + dy, x0);
      if (b) {
        this.boxes.push(b);
        return y + dy;
      }
    }
    return null;
  }

  /** the x the label actually should draw at (after any strip shift) */
  placeX(x: number, w: number, rightEdge = Infinity): number {
    const stripW = 110;
    if (Number.isFinite(rightEdge) && x + w / 2 > rightEdge - stripW) {
      return Math.max(10 + w / 2, rightEdge - stripW - w / 2);
    }
    return x;
  }

  measure(ctx: CanvasRenderingContext2D, text: string, size: number): number {
    ctx.font = `700 ${size}px ${FONT_FAMILY}`;
    return ctx.measureText(text).width;
  }
}

// ── the renderer ───────────────────────────────────────────────────────────

export function renderInk(
  plan: InkPlan,
  env: RenderEnv,
  layers: Layers,
): RenderOut {
  const { ctx, w, h, rightEdge, digits, isDark, narrow } = env;
  const tips: LevelTipBand[] = [];
  const col = new RightColumn(w, h);
  const floats = new FloatingLabels();
  // zone labels place LAST (lowest label priority — see the zones section)
  const zoneLabels: { text: string; cx: number; y: number; w: number; color: string }[] = [];

  // ═══ 1. zones — the two that matter (≤1 above + ≤1 below) ═══
  if (layers.zones) {
    for (const z of plan.zones) {
      const st = ZONE_STYLE[z.side] ?? ZONE_STYLE.supply;
      const y1 = env.yOfPrice(z.hi);
      const y2 = env.yOfPrice(z.lo);
      const x = env.xOfTime(z.t);
      if (y1 === null || y2 === null || x === null) continue;
      const x0 = clamp(x, -2, rightEdge);
      if (x0 >= rightEdge - 4) continue;
      // v20: a fresh zone extends right (it is a LIVE level); it never
      // paints past its mitigation candle (mitigated zones were dropped by
      // the plan anyway — this is belt-and-braces)
      let xEnd = rightEdge;
      if (z.mitT != null) {
        const xm = env.xOfTime(z.mitT);
        if (xm != null) xEnd = clamp(xm, x0, rightEdge);
      }
      if (xEnd - x0 < 3) continue;
      const ry = Math.min(y1, y2);
      const rh = Math.abs(y2 - y1);
      if (rh < 1.5) continue;
      ctx.fillStyle = st.fill;
      ctx.fillRect(x0, ry, xEnd - x0, rh);
      // crisp thin borders — top & bottom only (the sides are open, the
      // zone reads as a BAND, not a box)
      hardSeg(ctx, x0, ry, xEnd, ry, st.border, st.halo, 0.6);
      hardSeg(ctx, x0, ry + rh, xEnd, ry + rh, st.border, st.halo, 0.6);
      // label — inside the zone's left edge, vertically centered. v20.1:
      // DEFERRED — zone labels place LAST (after pattern/candle/event tags):
      // a zone is a self-evident band, its pill is optional chrome and must
      // never steal space from a trade-signal tag (the audit caught "FVG+
      // ·M15" printed under "MARUBOZU ▲79" in the recent-price cluster)
      const sideName: Record<string, string> = {
        supply: "SUPPLY", demand: "DEMAND", ob_bull: "OB+", ob_bear: "OB−",
        fvg_bull: "FVG+", fvg_bear: "FVG−",
      };
      const l = `${sideName[z.side] ?? z.side}${z.source_tf ? " · " + z.source_tf : ""}${z.institutional ? " · INST" : ""}`;
      if (!narrow) {
        const lw = floats.measure(ctx, l, 8);
        zoneLabels.push({ text: l, cx: x0 + 8 + (lw + PILL_PAD) / 2, y: ry + Math.max(8, Math.min(rh - 4, 10)), w: lw + PILL_PAD, color: st.border });
      }
      if (z.mergedFrom?.length) {
        tips.push({
          x1: x0, y1: ry, x2: xEnd, y2: ry + rh,
          title: l, price: `${z.lo.toFixed(digits)}–${z.hi.toFixed(digits)}`,
          sourceTf: z.source_tf, mergedFrom: z.mergedFrom,
        });
      }
    }
  }

  // ═══ 2. fib — the retracement map (only when no hero owns the chart) ═══
  if (layers.structure && plan.fib) {
    const d = plan.fib;
    const x0 = env.xOfTime(d.t0);
    const xA = env.xOfTime(d.t1);
    const y0 = env.yOfPrice(d.p0);
    const yA = env.yOfPrice(d.p1);
    if (x0 !== null && xA !== null && y0 !== null && yA !== null) {
      hardSeg(ctx, x0, y0, xA, yA, TONES.gold.line(0.45), TONES.gold.halo(0.04), 0.5);
      const goldenYs: number[] = [];
      for (const lv of d.levels) {
        const isGolden = lv.ratio === 0.618 || lv.ratio === 0.786;
        if (!isGolden && narrow) continue; // phone: golden pocket only
        const y = y0 + (yA - y0) * lv.ratio;
        hardSeg(
          ctx, Math.max(x0, xA), y, rightEdge, y,
          TONES.gold.line(isGolden ? 0.7 : 0.34),
          TONES.gold.halo(isGolden ? 0.06 : 0.03), isGolden ? 0.55 : 0.45,
          isGolden ? [] : [3, 4],
        );
        if (isGolden) {
          goldenYs.push(y);
          const fl = `${lv.ratio.toFixed(3)} ${lv.price.toFixed(digits)}`;
          col.add(y, 12, (yy) => {
            hardText(ctx, fl, rightEdge - 4, yy, TONES.gold.text, 8, "right");
          });
        }
      }
      if (goldenYs.length === 2 && d.ote) {
        ctx.fillStyle = "rgba(245,158,11,0.04)";
        ctx.fillRect(Math.max(x0, xA), Math.min(...goldenYs), rightEdge - Math.max(x0, xA), Math.abs(goldenYs[1] - goldenYs[0]));
      }
    }
  }

  // ═══ 3. trend — ≤2 unbroken lines, the loudest diagonal ink ═══
  if (layers.structure) {
    for (const d of plan.trend) {
      if (d.kind === "trendline") {
        const x1 = env.xOfTime(d.t1);
        const x2 = env.xOfTime(d.t2);
        const y1 = env.yOfPrice(d.p1);
        const y2 = env.yOfPrice(d.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const tone = TONES[d.tone] ?? TONES.neutral;
        hardSeg(ctx, x1, y1, x2, y2, tone.line(0.9), tone.halo(0.10), 1.05);
        // dashed projection — the path ahead the market has been respecting
        const slope = (y2 - y1) / Math.max(1, x2 - x1);
        const ye = y2 + slope * (rightEdge - x2);
        hardSeg(ctx, x2, y2, rightEdge, ye, tone.line(0.55), "transparent", 0.7, [6, 4]);
      } else {
        // channel: whisper-filled corridor + two sides + median
        const ctone = TONES[d.tone ?? (d.dir === "up" ? "bull" : "bear")] ?? TONES.neutral;
        const seg = (l: { t1: number; p1: number; t2: number; p2: number }) => {
          const x1 = env.xOfTime(l.t1), x2 = env.xOfTime(l.t2);
          const y1 = env.yOfPrice(l.p1), y2 = env.yOfPrice(l.p2);
          if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
          return { x1, x2, y1, y2 };
        };
        const up = seg(d.upper), lo = seg(d.lower);
        if (up && lo) {
          // corridor fill to the right edge along both projections
          const sU = (up.y2 - up.y1) / Math.max(1e-6, up.x2 - up.x1);
          const sL = (lo.y2 - lo.y1) / Math.max(1e-6, lo.x2 - lo.x1);
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(clamp(up.x1, -2, rightEdge), up.y1);
          ctx.lineTo(clamp(up.x2, -2, rightEdge), up.y2);
          ctx.lineTo(rightEdge, up.y2 + sU * (rightEdge - up.x2));
          ctx.lineTo(rightEdge, lo.y2 + sL * (rightEdge - lo.x2));
          ctx.lineTo(clamp(lo.x2, -2, rightEdge), lo.y2);
          ctx.lineTo(clamp(lo.x1, -2, rightEdge), lo.y1);
          ctx.closePath();
          ctx.fillStyle = ctone.fill(0.045);
          ctx.fill();
          ctx.restore();
        }
        for (const [l, isMed] of [[d.upper, false], [d.lower, false], [d.median, true]] as const) {
          if (!l) continue;
          const s = seg(l);
          if (!s) continue;
          hardSeg(ctx, s.x1, s.y1, s.x2, s.y2,
            isMed ? TONES.neutral.line(0.36) : ctone.line(0.8),
            isMed ? "transparent" : ctone.halo(0.05),
            isMed ? 0.45 : 0.7);
          const slope = (s.y2 - s.y1) / Math.max(1, s.x2 - s.x1);
          hardSeg(ctx, s.x2, s.y2, rightEdge, s.y2 + slope * (rightEdge - s.x2),
            isMed ? TONES.neutral.line(0.28) : ctone.line(0.5), "transparent", 0.5, [4, 4]);
        }
      }
    }
  }

  // ═══ 4. the spine — zigzag + swing words (structure layer) ═══
  if (layers.structure) {
    const zz = plan.zigzag;
    if (zz) {
      const pts = zz.points
        .map((pt) => ({ x: env.xOfTime(pt.t), y: env.yOfPrice(pt.p) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null && p.x >= -4 && p.x <= rightEdge + 6);
      if (pts.length >= 2) {
        ctx.save();
        ctx.strokeStyle = isDark ? "rgba(196,208,218,0.42)" : "rgba(90,102,96,0.45)";
        ctx.lineWidth = 1.0;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
      }
    }
    // swing tags — tick + dot + word, ABOVE highs / BELOW lows. These are
    // the spine: they pre-register their label boxes FIRST so no other ink
    // ever displaces them.
    for (const d of plan.swings) {
      const x = env.xOfTime(d.t);
      const y = env.yOfPrice(d.price);
      if (x === null || y === null || x < -6 || x > rightEdge + 6) continue;
      const high = d.side === "high";
      const dir = high ? -1 : 1;
      const color = high ? "rgba(252,165,165,0.95)" : "rgba(110,231,183,0.95)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + dir * 7);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
      const ty = y + dir * 16;
      const lw = floats.measure(ctx, d.tag, 8);
      const placed = floats.place(x, ty, lw, 10, true, rightEdge);
      if (placed !== null) hardText(ctx, d.tag, floats.placeX(x, lw, rightEdge), placed, color, 8, "center");
    }
  }

  // ═══ 5. events — BOS / CHoCH diamonds + sweep marks (≤2 each) ═══
  if (layers.structure) {
    for (const d of plan.events) {
      const x = env.xOfTime(d.t);
      const y = env.yOfPrice(d.price);
      if (x === null || y === null || x < -6 || x > rightEdge + 6) continue;
      const isBos = d.label.startsWith("BOS");
      const color = isBos ? "rgba(52,211,153,0.92)" : "rgba(245,158,11,0.92)";
      // the break line: swing origin → breaking candle
      if (d.fromT != null) {
        const x0 = env.xOfTime(d.fromT);
        if (x0 !== null) {
          const xa = clamp(x0, -2, rightEdge);
          const xb = clamp(x + 6, xa, rightEdge);
          if (xb > xa) {
            const bc = isBos ? "52,211,153" : "245,158,11";
            hardSeg(ctx, xa, y, xb, y, `rgba(${bc},0.5)`, `rgba(${bc},0.04)`, 0.5, [4, 3]);
          }
        }
      }
      diamond(ctx, x, y, color, 4.2, color.replace("0.9", "0.25"), true);
      const tag = d.source_tf ? `${d.label}·${d.source_tf}` : d.label;
      const lw = floats.measure(ctx, tag, 7.5);
      const ty = floats.place(x, y + (d.dir === "up" ? 13 : -13), lw, 9, false, rightEdge);
      if (ty !== null) hardText(ctx, tag, floats.placeX(x, lw, rightEdge), ty, color, 7.5, "center");
    }
    for (const d of plan.sweeps) {
      const x = env.xOfTime(d.t);
      const y = env.yOfPrice(d.price);
      if (x === null || y === null || x < -6 || x > rightEdge + 6) continue;
      xMark(ctx, x, y, "rgba(248,113,113,0.9)", 4.5);
      if (!narrow) {
        const lw = floats.measure(ctx, "SWEEP", 7);
        const ty = floats.place(x, y + (d.side === "high" ? -12 : 12), lw, 9, false, rightEdge);
        if (ty !== null) hardText(ctx, "SWEEP", floats.placeX(x, lw, rightEdge), ty, "rgba(252,165,165,0.85)", 7, "center");
      }
    }
  }

  // ═══ 6. candlestick-pattern boxes (≤3, live setups first) ═══
  if (layers.structure) {
    for (const d of plan.candles) {
      const x0c = env.xOfTime(d.t0);
      const x1c = env.xOfTime(d.t1);
      const y0c = env.yOfPrice(d.hi);
      const y1c = env.yOfPrice(d.lo);
      if (x0c === null || x1c === null || y0c === null || y1c === null) continue;
      const padX = Math.max(2, env.barSpacing * 0.4);
      const bx0 = clamp(x0c - padX, -2, rightEdge);
      const bx1 = clamp(x1c + padX, -2, rightEdge);
      if (bx1 - bx0 < 2.5 || bx0 > rightEdge) continue;
      const bw = bx1 - bx0;
      const bh = Math.abs(y1c - y0c);
      if (bh < 2) continue;
      const by0 = Math.min(y0c, y1c);
      const tone = d.side === "bull" ? upTone : dnTone;
      const live = d.status === "fresh" || d.status === "confirmed";
      ctx.fillStyle = d.status === "failed" ? tone.fill(0.02) : tone.fill(0.06);
      ctx.fillRect(bx0, by0, bw, bh);
      if (d.status === "failed") {
        const failEdge = isDark ? "rgba(148,163,158,0.35)" : "rgba(120,128,124,0.4)";
        for (const [ex0, ey0, ex1, ey1] of [
          [bx0, by0, bx1, by0], [bx0, by0 + bh, bx1, by0 + bh],
          [bx0, by0, bx0, by0 + bh], [bx1, by0, bx1, by0 + bh],
        ] as const) {
          hardSeg(ctx, ex0, ey0, ex1, ey1, failEdge, "transparent", 0.8, [3, 3]);
        }
      } else {
        const boxEdge =
          d.status === "confirmed" ? tone.line(0.9)
          : isDark ? "rgba(232,238,236,0.95)" : "rgba(34,40,37,0.9)";
        const lw = d.status === "confirmed" ? 1.35 : 1.1;
        hardSeg(ctx, bx0, by0, bx1, by0, boxEdge, "transparent", lw);
        hardSeg(ctx, bx0, by0 + bh, bx1, by0 + bh, boxEdge, "transparent", lw);
        hardSeg(ctx, bx0, by0, bx0, by0 + bh, boxEdge, "transparent", lw);
        hardSeg(ctx, bx1, by0, bx1, by0 + bh, boxEdge, "transparent", lw);
      }
      // the name tag — below bull boxes, above bear boxes
      const glyph =
        d.status === "fresh" ? " •" :
        d.status === "confirmed" ? (d.outcome === "lost" ? " ✗" : " ✓") : "";
      const ar = d.direction === "up" ? "▲" : "▼";
      const tag = `${d.name} ${ar}${d.confidence}${glyph}`;
      const cx = (bx0 + bx1) / 2;
      const ly = d.side === "bull" ? by0 + bh + 11 : by0 - 11;
      const tlw = floats.measure(ctx, tag, 8);
      const pillW = tlw + PILL_PAD;
      const placed = floats.place(cx, ly, pillW, 12, false, rightEdge);
      if (placed !== null) {
        pillLabel(
          ctx, tag, floats.placeX(cx, pillW, rightEdge), placed,
          d.status === "failed" ? "rgba(148,163,158,0.75)" : tone.text,
          d.status === "fresh" ? "rgba(245,158,11,0.55)" : tone.line(0.5),
          "center", 8,
        );
      }
    }
  }

  // ═══ 7. the classic chart pattern (≤1) ═══
  if (layers.structure && plan.pattern) {
    drawChartPattern(plan.pattern, env, col, floats, tips);
  }

  // ═══ 8. levels — the horizontal lines that matter (≤4) ═══
  if (layers.levels) {
    for (const d of plan.levels) {
      drawLevel(d, env, col, tips);
    }
  }

  // ═══ 9. THE hero setup + the one other-tf rail ═══
  if (layers.setup) {
    if (plan.setup) drawSetup(plan.setup, env, col, floats);
    if (plan.tfSetup) drawTfSetup(plan.tfSetup, env);
  }

  // ═══ 10. momentum — the lane + the two state pills ═══
  if (layers.momentum && plan.momentum) {
    drawMomentum(plan.momentum, env);
  }

  // ═══ 11. narrative layer (default OFF) ═══
  if (layers.narrative) {
    for (const d of plan.narrative) {
      try { drawNarrative(d, env, floats); } catch { /* one bad story must not blank the chart */ }
    }
  }

  // ═══ LAST: the zone labels (lowest priority — they yield to every other
  // tag), then the label column — on top of every line, never overlapping ═══
  for (const zl of zoneLabels) {
    const ly = floats.place(zl.cx, zl.y, zl.w, 12, false, rightEdge);
    if (ly !== null) {
      const dx = floats.placeX(zl.cx, zl.w, rightEdge) - zl.w / 2;
      pillLabel(ctx, zl.text, dx, ly, zl.color, zl.color, "left", 8);
    }
  }
  col.flush();

  return { tips };
}

/** pill-label collision width — pillLabel adds ~9px of padding + border
 *  around the text; the old place() calls measured BARE text width, so
 *  adjacent pills could still clip each other by half a padding. */
const PILL_PAD = 10;

// ── per-kind renderers ─────────────────────────────────────────────────────

/** one horizontal level — S/R line, liquidity pool or magnet */
function drawLevel(
  d: LevelD,
  env: RenderEnv,
  col: RightColumn,
  tips: LevelTipBand[],
) {
  const { ctx, rightEdge, digits } = env;
  const y = env.yOfPrice(d.price);
  if (y === null || y < -8 || y > env.h + 8) return;
  const above = d.price > env.lastPrice;

  if (d.kind === "liq") {
    // liquidity pool — where stop clusters sit (the magnet the market hunts)
    const untouched = d.state === "untouched";
    const color = d.side === "BSL" ? "rgba(255,120,132," : "rgba(52,211,153,";
    const x0 = d.t != null ? (env.xOfTime(d.t) ?? 0) : 0;
    hardSeg(
      ctx, Math.max(0, x0), y, rightEdge, y,
      color + (untouched ? "0.72)" : "0.30)"),
      color + "0.05)", 0.75,
      untouched ? [] : [3, 4],
    );
    const state = d.state === "untouched" ? "" : d.state === "swept" ? " · SWEPT" : " · RUN";
    const mc = d.mergedFrom?.length ?? 0;
    const label = `${d.side} ${d.price.toFixed(digits)}${state}${mc ? ` ×${mc + 1}` : ""}`;
    if (mc) {
      tips.push({
        x1: Math.max(0, x0), y1: y - 9, x2: rightEdge, y2: y + 9,
        title: `${d.side} LIQUIDITY${mc ? ` ×${mc + 1}` : ""}`,
        price: d.price.toFixed(digits), mergedFrom: d.mergedFrom,
      });
    }
    col.add(y, 13, (yy) => {
      pillLabel(ctx, label, rightEdge - 4, yy,
        color + (untouched ? "0.95)" : "0.55)"),
        color + "0.5)", "right", 8.5);
    });
    return;
  }

  if (d.kind === "magnet") {
    // magnet — a price the tape keeps pulling toward (POC…). The label
    // carries its PRICE ("POC 4174.4") — a bare "MAGNET · POC" forced the
    // eye to the axis to learn where it was.
    hardSeg(ctx, Math.max(0, rightEdge - 200), y, rightEdge, y,
      "rgba(251,191,36,0.5)", "rgba(245,158,11,0.05)", 0.6, [2, 4]);
    const mc = d.mergedFrom?.length ?? 0;
    const label = `${d.source} ${d.price.toFixed(digits)}${mc ? ` ×${mc + 1}` : ""}`;
    col.add(y, 13, (yy) => {
      pillLabel(ctx, label, rightEdge - 4, yy, "rgba(251,191,36,0.9)", "rgba(251,191,36,0.45)", "right", 8);
    });
    return;
  }

  // S/R key level — the workhorse. Drawn FROM its origin swing (TradingView
  // style), extended right, labeled in the shared column. A PLAIN hline (EQ,
  // day-open…) keeps its own label — it is not an S/R side.
  const isSr = d.side != null && d.source_tf != null;
  const x0 = isSr && d.t != null ? (env.xOfTime(d.t) ?? 0) : 0;
  const hits = d.hits ?? 1;
  const multiHit = hits >= 2;
  const tone = isSr ? (above ? dnTone : upTone) : TONES.neutral; // resistance reads red, support green
  hardSeg(
    ctx, Math.max(0, x0), y, rightEdge, y,
    tone.line(isSr ? (multiHit ? 0.9 : 0.62) : 0.55), tone.halo(0.07), 0.9,
    multiHit ? [] : [5, 4],
  );
  const mc = d.mergedFrom?.length ?? 0;
  const label = isSr
    ? levelLabel(d, env.lastPrice, digits, env.narrow)
    : `${d.label || "LEVEL"} ${d.price.toFixed(digits)}`;
  if (mc) {
    tips.push({
      x1: Math.max(0, x0), y1: y - 9, x2: rightEdge, y2: y + 9,
      title: `${above ? "RESISTANCE" : "SUPPORT"}${isSr ? ` · ${d.source_tf}` : ""}${mc ? ` ×${mc + 1}` : ""}`,
      price: d.price.toFixed(digits), sourceTf: d.source_tf, mergedFrom: d.mergedFrom,
    });
  }
  col.add(y, 13, (yy) => {
    pillLabel(ctx, label, rightEdge - 4, yy, tone.text, tone.line(0.5), "right", 8.5);
  });
}

/** S/R label — POSITIONAL truth: a line above the live price reads "R",
 *  below reads "S" (the engine's own side tag is its source-tf perspective;
 *  a broken H4 resistance sitting under price IS support now). Source tf and
 *  test-count ride along: "R 4179.76 ·M1 ×6". */
function levelLabel(d: Extract<LevelD, { kind: "hline" }>, lastPrice: number, digits: number, narrow: boolean): string {
  const above = d.price > lastPrice;
  const sideCh = above ? "R" : "S";
  const hits = d.hits ?? 1;
  if (narrow) return `${sideCh} ${d.price.toFixed(digits)}`;
  const src = d.source_tf && d.source_tf !== "" ? `·${d.source_tf}` : "";
  const hitCh = hits > 1 ? ` ×${hits}` : "";
  return `${sideCh} ${d.price.toFixed(digits)} ${src}${hitCh}`.trim();
}

/** THE hero trade plan — entry / SL / TP contract (one voice) */
function drawSetup(
  d: SetupD,
  env: RenderEnv,
  col: RightColumn,
  floats: FloatingLabels,
) {
  const { ctx, h, rightEdge, digits } = env;
  const yE = env.yOfPrice(d.entry);
  const yS = env.yOfPrice(d.sl);
  const yT = env.yOfPrice(d.tp);
  if (yE === null || yS === null || yT === null) return;
  const isBuy = d.dir === "BUY";
  const projected = d.status === "projected";
  const waiting = d.status === "pending" || projected;
  const xEntry = env.xOfTime(d.t0);
  const offscreen = xEntry === null || xEntry > rightEdge;
  let xs = xEntry ?? rightEdge - 24;
  xs = clamp(xs, -2, rightEdge - 24);

  // risk shading (red entry↔SL, green entry↔TP) — LIVE/pending only
  if (!projected) {
    ctx.fillStyle = "rgba(248,113,113,0.10)";
    ctx.fillRect(xs, Math.min(yE, yS), rightEdge - xs, Math.abs(yS - yE));
    ctx.fillStyle = "rgba(52,211,153,0.10)";
    ctx.fillRect(xs, Math.min(yE, yT), rightEdge - xs, Math.abs(yT - yE));
  }
  // dotted birth line
  if (xs > 2) {
    hardSeg(ctx, Math.round(xs) + 0.5, 0, Math.round(xs) + 0.5, h, "rgba(154,160,170,0.4)", "transparent", 0.7, [2, 4]);
  }
  const inkM = projected ? 0.55 : 1;
  // ENTRY — gold, glowing
  ctx.save();
  ctx.shadowColor = "rgba(212,175,55,0.55)";
  ctx.shadowBlur = 5;
  hardSeg(ctx, xs, yE, rightEdge, yE, `rgba(230,190,70,${(0.98 * inkM).toFixed(2)})`, "rgba(212,175,55,0.1)", 0.9, waiting ? [2, 3] : []);
  ctx.restore();
  hardSeg(ctx, xs, yS, rightEdge, yS, `rgba(255,120,132,${(0.92 * inkM).toFixed(2)})`, "rgba(248,113,113,0.07)", 0.7, [5, 4]);
  hardSeg(ctx, xs, yT, rightEdge, yT, `rgba(52,211,153,${(0.92 * inkM).toFixed(2)})`, "rgba(52,211,153,0.07)", 0.7, [5, 4]);
  const tp2 = d.tp2 != null && d.tp2 !== d.tp ? d.tp2 : null;
  const yT2 = tp2 != null ? env.yOfPrice(tp2) : null;
  if (tp2 != null && yT2 !== null) {
    hardSeg(ctx, xs, yT2, rightEdge, yT2, `rgba(20,184,166,${(0.85 * inkM).toFixed(2)})`, "rgba(20,184,166,0.06)", 0.6, [5, 4]);
  }

  // contract badges — the RIGHT COLUMN (nudged, never stacked)
  const verb = projected ? "PLAN" : waiting ? "WAIT" : "ENTRY";
  const lE = `${d.dir} ${verb} ${d.entry.toFixed(digits)}`;
  const lS = `SL ${d.sl.toFixed(digits)}`;
  const lT = `TP ${d.tp.toFixed(digits)} · ${d.rr.toFixed(1)}R`;
  const badge = (text: string, fg: string, bg: string, border: string, dashed: boolean, size = 10) => (yy: number) => {
    ctx.font = `700 ${size}px ${FONT_FAMILY}`;
    const tw = ctx.measureText(text).width;
    const padX = 5, padY = 3, r = 3.5;
    const bw = tw + padX * 2;
    const bh = size + padY * 2;
    const bx = rightEdge - bw;
    const by = yy - bh / 2;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.arcTo(bx + bw, by + bh, bx + bw, by + bh, r);
    ctx.lineTo(bx + r, by + bh);
    ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
    ctx.lineTo(bx, by + r);
    ctx.arcTo(bx, by, bx + r, by, r);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    if (dashed) ctx.setLineDash([2, 2]);
    ctx.strokeStyle = border;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.setLineDash([]);
    hardText(ctx, text, rightEdge - padX, yy + 0.5, fg, size, "right");
  };
  col.add(yE, 20, badge(lE, "#fbbf24", "rgba(94,63,10,0.92)", "rgba(251,191,36,0.6)", projected));
  col.add(yS, 18, badge(lS, "#fecaca", "rgba(96,28,33,0.92)", "rgba(255,120,132,0.6)", projected, 9));
  col.add(yT, 18, badge(lT, "#a7f3d0", "rgba(12,64,44,0.92)", "rgba(52,211,153,0.6)", projected, 9));
  if (tp2 != null && yT2 !== null) {
    col.add(yT2, 16, badge(`TP2 ${tp2.toFixed(digits)}`, "#99f6e4", "rgba(4,47,46,0.92)", "rgba(20,184,166,0.55)", projected, 8.5));
  }

  // off-screen entry — pinned chevron keeps the signal visible
  if (offscreen && yE > -4 && yE < h + 4) {
    ctx.save();
    ctx.strokeStyle = `rgba(230,190,70,${(0.9 * inkM).toFixed(2)})`;
    ctx.lineWidth = 1.1;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(rightEdge - 16, yE - 5);
    ctx.lineTo(rightEdge - 11, yE);
    ctx.lineTo(rightEdge - 16, yE + 5);
    ctx.moveTo(rightEdge - 9, yE - 5);
    ctx.lineTo(rightEdge - 4, yE);
    ctx.lineTo(rightEdge - 9, yE + 5);
    ctx.stroke();
    ctx.restore();
    hardText(ctx, d.entry.toFixed(digits), rightEdge - 4, yE + 13, `rgba(230,190,70,${(0.85 * inkM).toFixed(2)})`, 8, "right");
  }

  // the trade words — head block at the setup's birth
  const headX = Math.max(8, xs + 6);
  const headY = clamp((yE + yT) / 2 - 34, 20, h - 64);
  const stateTxt = projected ? "NEXT SETUP" : waiting ? "WAIT" : "LIVE";
  const liveTxt = `${isBuy ? "▲" : "▼"} ${d.dir} ${stateTxt} · ${verb} ${d.entry.toFixed(digits)} · RR ${d.rr.toFixed(1)}`;
  hardText(ctx, liveTxt, headX, headY, projected || waiting ? "#e7cd6f" : isBuy ? "rgba(110,231,183,0.95)" : "rgba(252,165,165,0.95)", 10);
  if (d.note) hardText(ctx, d.note, headX, headY + 14, "rgba(190,196,206,0.9)", 8.5, "left", 500);
  if (projected) {
    hardText(ctx, "planned entry — no live signal yet", headX, headY + 26, "rgba(231,205,111,0.7)", 8.5, "left", 500);
  } else {
    const ageMin = d.createdAt ? Math.max(0, Math.round((Date.now() - new Date(d.createdAt).getTime()) / 60000)) : null;
    const holding = d.status === "active";
    const meta = [
      d.entryType === "limit" ? "limit order" : "market entry",
      ageMin !== null ? `${ageMin}m ago` : null,
      d.trigger ? d.trigger.toUpperCase() : null,
      holding ? "holding · stays until TP/SL close" : null,
    ].filter(Boolean).join(" · ");
    hardText(ctx, meta, headX, headY + 26, "rgba(164,172,182,0.85)", 8.5, "left", 500);
  }
}

/** the one other-timeframe plan rail — whisper thin, never the hero */
function drawTfSetup(
  d: TfSetupD,
  env: RenderEnv,
) {
  const { ctx, rightEdge, digits, barSpacing } = env;
  const yE = env.yOfPrice(d.entry);
  if (yE === null || yE < -8 || yE > env.h + 8) return;
  const TF_INK: Record<string, [number, number, number]> = {
    M1: [244, 114, 182], M5: [251, 191, 36], M15: [52, 211, 153],
    M30: [251, 146, 60], H1: [45, 212, 191], H4: [251, 113, 133],
  };
  const [ir, ig, ib] = TF_INK[d.tf] ?? [226, 232, 230];
  const ink = (a: number) => `rgba(${ir},${ig},${ib},${a})`;
  const live = d.status === "signal";
  const x0 = Math.max(2, rightEdge - Math.max(140, barSpacing * 24));
  hardSeg(ctx, x0, yE, rightEdge, yE, ink(live ? 0.8 : 0.5), ink(0.05), 0.8, live ? [] : [2, 3]);
  // the TF tick at the rail's start carries the identity — the rail NEVER
  // competes for right-column space (v20.1: the column is the scarcest
  // resource; a fifth stacked pill near price read as the old clutter. The
  // full numbers live in the Analysis panel.)
  hardText(ctx, d.tf, x0 + 2, yE - 5, ink(live ? 0.9 : 0.62), 7, "left", 700);
}

/** the classic chart pattern — numbered pivots, boundary lines, trade plan */
function drawChartPattern(
  d: PatternD,
  env: RenderEnv,
  col: RightColumn,
  floats: FloatingLabels,
  tips: LevelTipBand[],
) {
  const { ctx, rightEdge, digits, isDark } = env;
  const pt = d.tone === "bull" ? upTone : dnTone;
  const gold = TONES.gold;
  const boundaryFam = d.family === "boundary";

  // whisper shading between boundary lines to the apex (triangles read as shapes)
  if (
    (d.name.includes("TRIANGLE") || d.name.includes("WEDGE") || d.name.includes("PENNANT") || d.name.includes("RECTANGLE")) &&
    (d.lines ?? []).length >= 2
  ) {
    const [gA, gB] = d.lines;
    const ax1 = env.xOfTime(gA.t1), ax2 = env.xOfTime(gA.t2);
    const ay1 = env.yOfPrice(gA.p1), ay2 = env.yOfPrice(gA.p2);
    const bx1 = env.xOfTime(gB.t1), bx2 = env.xOfTime(gB.t2);
    const by1 = env.yOfPrice(gB.p1), by2 = env.yOfPrice(gB.p2);
    if ([ax1, ax2, ay1, ay2, bx1, bx2, by1, by2].every((v) => v !== null)) {
      const cax2 = clamp(ax2!, -2, rightEdge);
      const cbx2 = clamp(bx2!, -2, rightEdge);
      const maxX2 = Math.max(cax2, cbx2);
      const sA = (ay2! - ay1!) / Math.max(1e-6, ax2! - ax1!);
      const sB = (by2! - by1!) / Math.max(1e-6, bx2! - bx1!);
      let endX = clamp(maxX2 + 0.3 * Math.max(30, rightEdge - maxX2), maxX2, rightEdge);
      if (Math.abs(sA - sB) > 1e-6) {
        const apexX = (by2! - ay2! + sA * cax2 - sB * cbx2) / (sA - sB);
        if (apexX > maxX2) endX = clamp(apexX, maxX2, rightEdge);
      }
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(clamp(ax1!, -2, rightEdge), ay1!);
      ctx.lineTo(cax2, ay2!);
      ctx.lineTo(endX, ay2! + sA * (endX - cax2));
      ctx.lineTo(endX, by2! + sB * (endX - cbx2));
      ctx.lineTo(cbx2, by2!);
      ctx.lineTo(clamp(bx1!, -2, rightEdge), by1!);
      ctx.closePath();
      ctx.fillStyle = pt.fill(0.06);
      ctx.fill();
      ctx.restore();
    }
  }

  // geometry lines — thin hard cores; boundaries project as rays
  for (const g of d.lines ?? []) {
    const gx1 = env.xOfTime(g.t1), gx2 = env.xOfTime(g.t2);
    const gy1 = env.yOfPrice(g.p1), gy2 = env.yOfPrice(g.p2);
    if (gx1 === null || gx2 === null || gy1 === null || gy2 === null) continue;
    if (gx1 > rightEdge || gx2 < -2) continue;
    hardSeg(ctx, clamp(gx1, -2, rightEdge), gy1, clamp(gx2, -2, rightEdge), gy2,
      pt.line(0.85), pt.halo(0.06), 0.8, g.dash ? [4, 3] : []);
    const slope = (gy2 - gy1) / Math.max(1, gx2 - gx1);
    const gye = gy2 + slope * (rightEdge - gx2);
    if (g.dash && gx2 <= rightEdge) {
      hardSeg(ctx, gx2, gy2, rightEdge, gye, pt.line(0.4), "transparent", 0.5, [4, 3]);
    }
    if (boundaryFam && !g.dash && gx2 > 0 && gx2 <= rightEdge) {
      hardSeg(ctx, gx2, gy2, rightEdge, gye, pt.line(0.5), "transparent", 0.6);
    }
  }

  // numbered pivots 1..N
  for (const p of d.points) {
    const x = env.xOfTime(p.t);
    const y = env.yOfPrice(p.price);
    if (x === null || y === null || x < -6 || x > rightEdge + 6) continue;
    const cy = p.kind === "high" ? y - 10 : y + 10;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, cy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? "rgba(13,17,23,0.85)" : "rgba(250,249,246,0.9)";
    ctx.fill();
    ctx.strokeStyle = pt.line(0.9);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
    hardText(ctx, String(p.n), x, cy + 0.5, pt.text, 8, "center");
  }

  const confirmed = d.state === "confirmed";
  const firstPx = d.points[0] ? env.xOfTime(d.points[0].t) : null;
  const planX0 = clamp(firstPx ?? rightEdge - 60, 2, rightEdge - 10);

  // ENTRY — gold dashed level + ring at the trigger
  const yE = env.yOfPrice(d.entry.price);
  if (yE !== null && yE > -5 && yE < env.h + 5) {
    const xE0 = d.entry.t != null ? env.xOfTime(d.entry.t) : null;
    hardSeg(ctx, Math.max(0, xE0 ?? 0), Math.round(yE) + 0.5, rightEdge, Math.round(yE) + 0.5,
      gold.line(confirmed ? 0.75 : 0.5), gold.halo(0.06), confirmed ? 0.65 : 0.5, confirmed ? [4, 3] : [2, 3]);
    if (confirmed && xE0 != null && xE0 >= -4 && xE0 <= rightEdge) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(xE0 + 2, yE, 5, 0, Math.PI * 2);
      ctx.strokeStyle = gold.line(0.95);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.restore();
    }
    col.add(yE, 14, (yy) => {
      pillLabel(ctx, `ENTRY ${d.entry.price.toFixed(digits)}`, rightEdge - 4, yy,
        confirmed ? gold.text : "rgba(230,190,70,0.75)", gold.line(confirmed ? 0.5 : 0.3), "right", 8);
    });
  }
  // STOP — red dashed
  const yS = env.yOfPrice(d.sl);
  if (yS !== null && yS > -5 && yS < env.h + 5) {
    hardSeg(ctx, planX0, Math.round(yS) + 0.5, rightEdge, Math.round(yS) + 0.5,
      confirmed ? "rgba(248,113,113,0.72)" : "rgba(248,113,113,0.45)", "rgba(248,113,113,0.05)", confirmed ? 0.55 : 0.45, [2.5, 3.5]);
    col.add(yS, 13, (yy) => {
      pillLabel(ctx, `SL ${d.sl.toFixed(digits)}`, rightEdge - 4, yy,
        confirmed ? "rgba(252,165,165,0.95)" : "rgba(252,165,165,0.7)", "rgba(248,113,113,0.5)", "right", 8);
    });
  }
  // TARGET — green dashed + whisper band
  const yT1 = env.yOfPrice(d.target_zone.lo);
  const yT2 = env.yOfPrice(d.target_zone.hi);
  if (yT1 !== null && yT2 !== null && Math.abs(yT2 - yT1) > 0.5) {
    ctx.fillStyle = confirmed ? "rgba(52,211,153,0.05)" : "rgba(52,211,153,0.03)";
    ctx.fillRect(rightEdge - 64, Math.min(yT1, yT2), 64, Math.abs(yT2 - yT1));
  }
  const yT = env.yOfPrice(d.target);
  if (yT !== null && yT > -5 && yT < env.h + 5) {
    hardSeg(ctx, planX0, Math.round(yT) + 0.5, rightEdge, Math.round(yT) + 0.5,
      confirmed ? "rgba(52,211,153,0.8)" : "rgba(52,211,153,0.45)", "transparent", confirmed ? 0.6 : 0.45, [2, 3]);
    const rrTxt = d.rr != null ? ` · RR ${d.rr.toFixed(1)}` : "";
    col.add(yT, 13, (yy) => {
      pillLabel(ctx, `TARGET ${d.target.toFixed(digits)}${rrTxt}`, rightEdge - 4, yy,
        confirmed ? "rgba(167,243,208,0.95)" : "rgba(167,243,208,0.7)", "rgba(52,211,153,0.5)", "right", 8);
    });
  }
  // measured-move vertical — sky-cyan bracket (contrasts with candles)
  if (yE !== null && yT !== null && Math.abs(yT - yE) > 6) {
    const xV0 = d.entry.t != null ? env.xOfTime(d.entry.t) : null;
    const onScreen = xV0 != null && xV0 >= 8 && xV0 <= rightEdge - 8;
    const headP = d.points[d.points.length - 1];
    const xH = headP ? env.xOfTime(headP.t) : null;
    const xV = clamp(onScreen ? xV0! : ((xH ?? rightEdge - 40) + env.barSpacing * 2), 4, rightEdge - 4);
    const mvA = confirmed ? 0.85 : 0.5;
    const mvCol = `rgba(56,189,248,${mvA})`;
    hardSeg(ctx, xV, yE, xV, yT, mvCol, "transparent", 0.7, [4, 3]);
    hardSeg(ctx, xV - 4, yE, xV + 4, yE, mvCol, "transparent", 0.7);
    hardSeg(ctx, xV - 4, yT, xV + 4, yT, mvCol, "transparent", 0.7);
    arrow(ctx, xV, yT, d.dir, mvCol, "rgba(56,189,248,0.15)", 5);
  }
  // breakout arrow
  if (confirmed && d.breakout_t != null) {
    const xb = env.xOfTime(d.breakout_t);
    if (xb != null && xb >= 0 && xb <= rightEdge) {
      const yb = env.yOfPrice(d.entry.price);
      if (yb !== null) {
        arrow(ctx, Math.min(xb + 10, rightEdge - 14), d.dir === "up" ? yb - 18 : yb + 18, d.dir,
          d.dir === "up" ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)",
          d.dir === "up" ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)", 6);
      }
    }
  }
  // name pill at the first pivot
  const firstP = d.points[0];
  if (firstP) {
    const x0 = env.xOfTime(firstP.t);
    const y0 = env.yOfPrice(firstP.price);
    if (x0 !== null && y0 !== null && x0 >= -4 && x0 <= rightEdge) {
      const fam = d.family === "reversal" ? "REVERSAL" : d.family === "continuation" ? "CONTINUATION" : "BOUNDARY";
      const nm = env.narrow
        ? `${d.name} · ${confirmed ? "✓" : "FORMING"}`
        : `${d.name} · ${fam} · ${confirmed ? "✓ CONFIRMED" : "FORMING"}${d.source_tf ? " · " + d.source_tf : ""}`;
      const ty = firstP.kind === "high" ? y0 - 24 : y0 + 24;
      const lw = floats.measure(ctx, nm, 8.5);
      const pillW = lw + PILL_PAD;
      const placed = floats.place(x0 + pillW / 2, ty, pillW, 13, true, rightEdge);
      if (placed !== null) {
        pillLabel(ctx, nm, floats.placeX(x0 + pillW / 2, pillW, rightEdge) - pillW / 2, placed,
          confirmed ? pt.text : "rgba(226,232,230,0.9)",
          confirmed ? pt.line(0.55) : "rgba(148,163,158,0.4)", "left", 8.5);
      }
    }
  }
}

/** momentum — the per-bar velocity lane + the two state pills */
function drawMomentum(
  d: MomentumD,
  env: RenderEnv,
) {
  const { ctx, w, h, rightEdge, isDark, barSpacing } = env;
  let axisH = 26;
  try {
    axisH = env.chart ? ((env.chart.timeScale() as unknown as { height?: () => number }).height?.() ?? 26) : 26;
  } catch { /* older builds — the 26px default stands */ }
  const laneH = 7;
  const y0 = h - axisH - laneH - 2;
  if (y0 > 40) {
    ctx.fillStyle = isDark ? "rgba(8,12,10,0.62)" : "rgba(250,249,246,0.72)";
    ctx.fillRect(0, y0, rightEdge, laneH);
    hardSeg(ctx, 0, y0 + laneH + 0.5, rightEdge, y0 + laneH + 0.5,
      isDark ? "rgba(34,48,41,0.9)" : "rgba(220,216,205,0.9)", "transparent", 0.5);
    const cellW = Math.max(1.5, Math.min(barSpacing, 10));
    for (const b of d.bars) {
      const x = env.xOfTime(b.t);
      if (x === null || x < -cellW || x > rightEdge) continue;
      const v = Math.abs(b.m);
      const strong = v >= 0.55;
      const mild = v >= 0.18;
      ctx.fillStyle = b.m >= 0
        ? strong ? "rgba(52,211,153,0.95)" : mild ? "rgba(52,211,153,0.42)" : "rgba(148,163,158,0.22)"
        : strong ? "rgba(248,113,113,0.95)" : mild ? "rgba(248,113,113,0.42)" : "rgba(148,163,158,0.22)";
      ctx.fillRect(Math.max(0, x - cellW / 2), y0 + 1, cellW, laneH - 2);
    }
  }
  // the two state pills — under the legend strip, clear of the running badge
  const py = 44;
  const sTxt = `STRUCTURE ${d.trend === "bullish" ? "▲ BULLISH" : d.trend === "bearish" ? "▼ BEARISH" : "◆ RANGING"}`;
  const sCol = d.trend === "bullish"
    ? "rgba(110,231,183,0.95)"
    : d.trend === "bearish" ? "rgba(252,165,165,0.95)" : "rgba(178,190,185,0.9)";
  pillLabel(ctx, sTxt, 8, py, sCol, sCol.replace("0.95", "0.45").replace("0.9", "0.4"), "left", 8);
  const mTxt = `MOMENTUM ${d.m >= 0 ? "▲" : "▼"} ${
    d.state === "strong_bull" ? "STRONG +" : d.state === "bull" ? "+" :
    d.state === "strong_bear" ? "STRONG −" : d.state === "bear" ? "−" : "·"
  }${Math.abs(d.m).toFixed(2)}`;
  const mCol = d.m >= 0.18
    ? "rgba(110,231,183,0.95)"
    : d.m <= -0.18 ? "rgba(252,165,165,0.95)" : "rgba(178,190,185,0.9)";
  ctx.font = `700 8px ${FONT_FAMILY}`;
  const sW = ctx.measureText(sTxt).width + 13;
  pillLabel(ctx, mTxt, 8 + sW + 4, py, mCol, mCol.replace("0.95", "0.45").replace("0.9", "0.4"), "left", 8);
}

/** narrative ink (layer-gated, default off) — the CURRENT story only */
function drawNarrative(
  d: AutoDrawing,
  env: RenderEnv,
  floats: FloatingLabels,
) {
  const { ctx, rightEdge, digits } = env;
  if (d.kind === "amd") {
    const y1 = env.yOfPrice(d.hi);
    const y2 = env.yOfPrice(d.lo);
    const x1 = env.xOfTime(d.t0);
    if (y1 === null || y2 === null || x1 === null) return;
    const x2raw = d.done ? env.xOfTime(d.t1) : rightEdge;
    const xa = clamp(x1, -2, rightEdge);
    const xb = clamp(Math.max(x1 + 3, x2raw ?? rightEdge), xa, rightEdge);
    if (xb - xa < 2) return;
    const AMD_STYLE: Record<string, { stroke: (a: number) => string; fill: string; text: string }> = {
      accumulation: { stroke: (a) => `rgba(45,212,191,${a})`, fill: "rgba(45,212,191,0.03)", text: "rgba(153,246,228,0.95)" },
      manipulation: { stroke: (a) => `rgba(167,139,250,${a})`, fill: "rgba(167,139,250,0.045)", text: "rgba(196,181,253,0.95)" },
      distribution: { stroke: (a) => `rgba(245,158,11,${a})`, fill: "rgba(245,158,11,0.03)", text: "rgba(251,191,36,0.95)" },
    };
    const st = AMD_STYLE[d.phase];
    const ry = Math.min(y1, y2);
    const rh = Math.max(Math.abs(y2 - y1), 3);
    ctx.save();
    ctx.setLineDash(d.phase === "manipulation" ? [2, 3] : [4, 3]);
    ctx.strokeStyle = st.stroke(d.done ? 0.38 : 0.85);
    ctx.lineWidth = 0.55;
    ctx.fillStyle = st.fill;
    ctx.fillRect(xa, ry, xb - xa, rh);
    ctx.strokeRect(xa + 0.25, ry + 0.25, xb - xa - 0.5, rh - 0.5);
    ctx.restore();
    const arrowTxt = d.dir === "up" ? "↑" : "↓";
    const label =
      d.phase === "accumulation" ? `ACCUMULATION ${arrowTxt}${d.done ? "" : " · LIVE"}`
      : d.phase === "manipulation" ? `MANIPULATION — hunt ${d.dir === "up" ? "SSL ↓" : "BSL ↑"}${d.done ? "" : " · LIVE"}`
      : `DISTRIBUTION ${arrowTxt}${d.done ? "" : " · LIVE"}`;
    const lw = floats.measure(ctx, label, 8);
    const ly = floats.place(xa + 8 + (lw + PILL_PAD) / 2, ry - 8, lw + PILL_PAD, 12, false, env.rightEdge);
    if (ly !== null) {
      const dx = floats.placeX(xa + 8 + (lw + PILL_PAD) / 2, lw + PILL_PAD, env.rightEdge) - (lw + PILL_PAD) / 2;
      pillLabel(ctx, label, dx, ly, st.text, st.stroke(0.5), "left", 8);
    }
    return;
  }
  if (d.kind === "range") {
    const y1 = env.yOfPrice(d.hi);
    const y2 = env.yOfPrice(d.lo);
    const x1 = env.xOfTime(d.t0);
    if (y1 === null || y2 === null || x1 === null) return;
    const x2raw = d.state === "forming" ? rightEdge : env.xOfTime(d.t1);
    const rx = clamp(x1, -2, rightEdge);
    const x2 = clamp(x2raw ?? rightEdge, rx, rightEdge);
    if (x2 - rx < 3) return;
    const broken = d.state !== "forming";
    const ry = Math.min(y1, y2);
    const rh = Math.max(Math.abs(y2 - y1), 2);
    ctx.save();
    if (broken) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = broken ? "rgba(148,163,158,0.35)" : "rgba(178,190,185,0.8)";
    ctx.lineWidth = 0.6;
    ctx.fillStyle = "rgba(148,163,158,0.025)";
    ctx.fillRect(rx, ry, x2 - rx, rh);
    ctx.strokeRect(rx + 0.25, ry + 0.25, x2 - rx - 0.5, rh - 0.5);
    ctx.restore();
    return;
  }
  if (d.kind === "instit") {
    const x = env.xOfTime(d.t);
    const y = env.yOfPrice(d.price);
    if (x === null || y === null) return;
    const bull = d.side === "buy";
    const ay = y + (bull ? 17 : -17);
    arrow(ctx, x, ay, bull ? "up" : "down", bull ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)", "transparent", 5);
    const il = `${bull ? "BIG BUYERS" : "BIG SELLERS"} · z${d.volZ.toFixed(1)}`;
    const lw = floats.measure(ctx, il, 7.5);
    const ly = floats.place(x, ay + (bull ? 13 : -13), lw, 9, false, env.rightEdge);
    if (ly !== null) hardText(ctx, il, floats.placeX(x, lw, env.rightEdge), ly, bull ? "rgba(110,231,183,0.95)" : "rgba(252,165,165,0.95)", 7.5, "center");
    return;
  }
  if (d.kind === "forecast") {
    const xNow = env.xOfTime(env.lastBarT) ?? rightEdge - 10;
    const yFrom = env.yOfPrice(d.from);
    if (yFrom === null) return;
    const drawScenario = (legs: { price: number; label: string }[], primary: boolean) => {
      if (!legs.length) return;
      const step = Math.max(16, env.barSpacing * 7);
      let px = xNow;
      let py = yFrom;
      legs.forEach((leg, i) => {
        const ty = env.yOfPrice(leg.price);
        if (ty === null) return;
        const tx = Math.min(rightEdge - 2, xNow + step * (i + 1));
        if (tx <= px + 2 || Math.abs(ty - py) < 2) return;
        hardSeg(ctx, px, py, tx, ty,
          primary ? "rgba(251,191,36,0.85)" : "rgba(148,163,158,0.4)",
          "transparent", primary ? 0.7 : 0.5, [4, 3]);
        arrow(ctx, tx, ty, ty < py ? "up" : "down", primary ? "rgba(251,191,36,0.95)" : "rgba(178,190,185,0.6)", "transparent", 4.5);
        px = tx;
        py = ty;
      });
    };
    drawScenario(d.primary.legs, true);
    drawScenario(d.alternate?.legs ?? [], false);
    return;
  }
  if (d.kind === "path") {
    const yA = env.yOfPrice(d.from_price);
    const yB = env.yOfPrice(d.to_price);
    if (yA === null || yB === null) return;
    const xA = rightEdge - 110;
    const xB = rightEdge - 46;
    hardSeg(ctx, xA, yA, xB, yB, "rgba(245,158,11,0.7)", "rgba(245,158,11,0.06)", 1, [1.5, 3.5]);
    arrow(ctx, xB, yB, d.to_price > d.from_price ? "up" : "down", "rgba(245,158,11,0.85)", "rgba(245,158,11,0.2)", 6);
    return;
  }
}

// cache-buster v20.1a
