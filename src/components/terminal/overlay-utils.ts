/** Canvas overlay helpers — the visual grammar ported from the reference engine. */

export type Rgba = (alpha: number) => string;

export const TONES: Record<string, { line: Rgba; text: string; fill: Rgba; halo: Rgba }> = {
  bull: {
    line: (a) => `rgba(52, 211, 153, ${a})`,
    text: "rgba(110, 231, 183, 0.95)",
    fill: (a) => `rgba(52, 211, 153, ${a})`,
    halo: (a) => `rgba(52, 211, 153, ${a})`,
  },
  bear: {
    line: (a) => `rgba(248, 113, 113, ${a})`,
    text: "rgba(252, 165, 165, 0.95)",
    fill: (a) => `rgba(248, 113, 113, ${a})`,
    halo: (a) => `rgba(248, 113, 113, ${a})`,
  },
  gold: {
    line: (a) => `rgba(245, 158, 11, ${a})`,
    text: "rgba(251, 191, 36, 0.95)",
    fill: (a) => `rgba(245, 158, 11, ${a})`,
    halo: (a) => `rgba(245, 158, 11, ${a})`,
  },
  violet: {
    line: (a) => `rgba(167, 139, 250, ${a})`,
    text: "rgba(196, 181, 253, 0.95)",
    fill: (a) => `rgba(167, 139, 250, ${a})`,
    halo: (a) => `rgba(167, 139, 250, ${a})`,
  },
  neutral: {
    line: (a) => `rgba(148, 163, 158, ${a})`,
    text: "rgba(178, 190, 185, 0.95)",
    fill: (a) => `rgba(148, 163, 158, ${a})`,
    halo: (a) => `rgba(148, 163, 158, ${a})`,
  },
};

export const ZONE_STYLE: Record<string, { fill: string; border: string; halo: string }> = {
  supply: { fill: "rgba(248,113,113,0.028)", border: "rgba(252,140,140,0.78)", halo: "rgba(248,113,113,0.06)" },
  demand: { fill: "rgba(52,211,153,0.028)", border: "rgba(84,224,168,0.78)", halo: "rgba(52,211,153,0.06)" },
  ob_bull: { fill: "rgba(45,212,191,0.026)", border: "rgba(94,224,205,0.72)", halo: "rgba(45,212,191,0.055)" },
  ob_bear: { fill: "rgba(217,119,6,0.026)", border: "rgba(240,165,60,0.72)", halo: "rgba(217,119,6,0.055)" },
  fvg_bull: { fill: "rgba(139,92,246,0.028)", border: "rgba(172,132,250,0.72)", halo: "rgba(139,92,246,0.055)" },
  fvg_bear: { fill: "rgba(236,72,153,0.028)", border: "rgba(248,120,180,0.72)", halo: "rgba(236,72,153,0.055)" },
};

export const FONT_FAMILY = "var(--font-geist-mono), ui-monospace, monospace";

/** Hard thin line: halo underlay then crisp core stroke. */
export function hardSeg(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  color: string, halo: string, width = 0.7, dash: number[] = [],
) {
  ctx.save();
  // halo
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = halo;
  ctx.lineWidth = width + 0.9;
  if (dash.length) ctx.setLineDash([]); // halo always solid
  ctx.stroke();
  // core
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();
}

/** Small hard text directly on canvas, no box, soft shadow. */
export function hardText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number,
  color: string, size = 8, align: CanvasTextAlign = "left", weight = 700,
) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 3;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Pill label — readable over ANY background: rounded dark capsule + crisp
 * colored text + subtle colored border. The go-to for zone/liq/level tags
 * (user: drawings must be স্পষ্ট ও সুন্দর — clear & beautiful).
 */
export function pillLabel(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number,
  fg: string, borderColor: string, align: CanvasTextAlign = "left", size = 8.5,
) {
  ctx.save();
  ctx.font = `700 ${size}px ${FONT_FAMILY}`;
  const w = ctx.measureText(text).width;
  const padX = 4.5, padY = 2.5, r = 3;
  let bx = x;
  if (align === "right") bx = x - w - padX * 2;
  else if (align === "center") bx = x - (w + padX * 2) / 2;
  const by = y - size / 2 - padY;
  const bw = w + padX * 2;
  const bh = size + padY * 2;
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
  ctx.lineTo(bx + r, by + bh);
  ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
  ctx.lineTo(bx, by + r);
  ctx.arcTo(bx, by, bx + r, by, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(8,12,10,0.82)";
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = borderColor;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fg;
  ctx.fillText(text, bx + padX, y + 0.5);
  ctx.restore();
}

/** Filled triangle arrow. */
export function arrow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, dir: "up" | "down",
  color: string, halo: string, r = 7,
) {
  const s = dir === "up" ? -1 : 1;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y + s * r);
  ctx.lineTo(x - r * 0.62, y + s * -r * 0.5);
  ctx.lineTo(x + r * 0.62, y + s * -r * 0.5);
  ctx.closePath();
  ctx.fillStyle = halo;
  ctx.save();
  ctx.shadowColor = halo;
  ctx.shadowBlur = 5;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** Hollow diamond (BOS / CHoCH marks). */
export function diamond(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, color: string, r = 5, halo: string, filled = true,
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.restore();
}

/** X mark for liquidity sweeps. */
export function xMark(
  ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r = 5,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
  ctx.restore();
}

/** Distance from point to segment (for hit-testing). */
export function distToSeg(
  px: number, py: number, x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function fmtPrice(p: number, digits: number): string {
  if (!Number.isFinite(p)) return "—";
  return p.toFixed(digits);
}

export function fmtCompact(v: number): string {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
