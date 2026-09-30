"use client";

/**
 * DeltaAreaChart — the X-ray panel's small "running candle" area chart,
 * enlarged to full width for the combined three-chart view.
 *
 * What it draws: the CUMULATIVE DELTA (aggressive buyers − sellers) inside
 * the LIVE candle, as a time-proportional area chart — exactly what the
 * tape-reader's sparkline in the X-ray panel shows, but bigger and with its
 * own zoom:
 *   · wheel / pinch / + − buttons select how much of the running candle's
 *     tape is visible (full bar → last 30 s)
 *   · zero line in the middle: buyers push above, sellers below
 *   · live dot + right-axis tag = current delta
 *   · countdown chip = time until the running candle closes
 *
 * Data: useFlow(symbol, tf) — the ≤12.5 Hz order-flow stream (server keeps
 * ≤130 downsampled {t, d} samples across the whole running bar).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useFlow } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/** visible tape window, seconds — 0 = the whole running candle */
const ZOOM_STEPS = [0, 1800, 900, 300, 120, 60, 30];
const ZOOM_KEY = "delta-zoom-sec";
const WHEEL_THROTTLE_MS = 80;
const PINCH_RATIO = 1.08;

const THEMES = {
  dark: {
    bg: "#0c1210", grid: "rgba(157,177,167,0.07)", border: "#223029",
    text: "#9db1a7", dimText: "rgba(157,177,167,0.55)",
    zero: "rgba(157,177,167,0.4)",
    up: "#0ecb81", down: "#f6465d",
    upFillA: "rgba(14,203,129,0.30)", upFillB: "rgba(14,203,129,0.02)",
    downFillA: "rgba(246,70,93,0.28)", downFillB: "rgba(246,70,93,0.02)",
    boundary: "#f59e0b",
    chipBg: "rgba(34,48,41,0.9)",
    barBg: "rgba(245,158,11,0.05)",
  },
  light: {
    bg: "#fcfbf9", grid: "rgba(77,95,85,0.08)", border: "#dcd8cd",
    text: "#4d5f55", dimText: "rgba(77,95,85,0.55)",
    zero: "rgba(77,95,85,0.45)",
    up: "#02c07a", down: "#f0304e",
    upFillA: "rgba(2,192,122,0.28)", upFillB: "rgba(2,192,122,0.02)",
    downFillA: "rgba(240,48,78,0.26)", downFillB: "rgba(240,48,78,0.02)",
    boundary: "#d97706",
    chipBg: "rgba(220,216,205,0.9)",
    barBg: "rgba(217,119,6,0.05)",
  },
};

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function fmtClock(ms: number) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBn(n: number) { return String(n).split("").map((c) => BN_DIGITS[Number(c)] ?? c).join(""); }

export default function DeltaAreaChart() {
  const { symbol, timeframe } = useTerminal();
  const { resolvedTheme } = useTheme();
  const { t, locale } = useI18n();
  const flow = useFlow(symbol, timeframe);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const rafRef = useRef(0);

  // ── zoom: which slice of the running candle's tape is visible ──
  const [step, setStep] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(v) && v >= 0 && v < ZOOM_STEPS.length) return Math.round(v);
    } catch { /* best-effort */ }
    return 0;
  });
  useEffect(() => {
    try { localStorage.setItem(ZOOM_KEY, String(step)); } catch { /* best-effort */ }
  }, [step]);

  const zoomIn = useCallback(() => setStep((s) => Math.min(ZOOM_STEPS.length - 1, s + 1)), []);
  const zoomOut = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const zoomReset = useCallback(() => setStep(0), []);

  const tfSec = TF_SEC[timeframe] ?? 900;
  const th = resolvedTheme === "light" ? THEMES.light : THEMES.dark;
  const stateRef = useRef({ flow, tfSec, th, locale, t, step, timeframe, symbol });

  useEffect(() => {
    stateRef.current = { flow, tfSec, th, locale, t, step, timeframe, symbol };
  }, [flow, tfSec, th, locale, t, step, timeframe, symbol]);

  // ── wheel zoom ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - last < WHEEL_THROTTLE_MS) return;
      last = now;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (d > 0) zoomOut();
      else if (d < 0) zoomIn();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomIn, zoomOut]);

  // ── pinch zoom (touch) ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let lastDist = 0;
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) lastDist = dist(e.touches[0], e.touches[1]);
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !lastDist) return;
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      if (d > lastDist * PINCH_RATIO) { zoomOut(); lastDist = d; }
      else if (d < lastDist / PINCH_RATIO) { zoomIn(); lastDist = d; }
    };
    const onEnd = () => { lastDist = 0; };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [zoomIn, zoomOut]);

  // ── the canvas rAF loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const S = stateRef.current;
      const { flow: p, tfSec: tf, th: theme, locale: loc, step: st } = S;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const padR = 58, padT = 12, padB = 16, padL = 8;
      const plotW = W - padR - padL, plotH = H - padT - padB;
      if (plotW <= 10 || plotH <= 10) return;

      const now = Date.now();
      const winSec = ZOOM_STEPS[st];
      const hist = p?.deltaHist ?? [];
      const has = !!p && p.h > 0 && hist.length > 1;

      // window: [start, now] — full bar or the last winSec seconds
      let winStart: number;
      if (!has) {
        winStart = now - tf * 1000;
      } else if (winSec === 0) {
        winStart = p.t; // running bar open
      } else {
        winStart = Math.max(p.t, now - winSec * 1000);
      }
      const winEnd = now;

      const xOf = (t: number) => padL + ((t - winStart) / Math.max(1, winEnd - winStart)) * plotW;

      // ── background wash over the bar's elapsed span ──
      if (has) {
        const bx = xOf(Math.max(p.t, winStart));
        ctx.fillStyle = theme.barBg;
        ctx.fillRect(bx, padT, Math.max(0, W - padR - bx), plotH);
      }

      // ── grid ──
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 2; i++) {
        const y = padT + (plotH * i) / 2;
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y + 0.5);
        ctx.lineTo(W - padR, y + 0.5);
        ctx.stroke();
      }

      if (!has) {
        ctx.fillStyle = theme.dimText;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(loc === "bn" ? "টেপের অপেক্ষায়…" : t("deltaEmpty"), padL + plotW / 2, padT + plotH / 2);
        // countdown chip still ticks (bar clock is known from tf)
        drawCountdown(ctx, theme, W, padR, padT, now, tf, loc);
        return;
      }

      // ── visible delta path ──
      const visible = hist.filter((h) => h.t >= winStart - 200);
      if (visible.length < 2) {
        return;
      }
      const last = visible[visible.length - 1];
      const pos = last.d >= 0;

      // symmetric range around zero — buyers above the line, sellers below
      let mag = 1;
      for (const h of visible) mag = Math.max(mag, Math.abs(h.d));
      mag *= 1.18;
      const yOf = (d: number) => padT + (1 - (d + mag) / (2 * mag)) * plotH;
      const y0 = yOf(0);

      // zero line
      ctx.strokeStyle = theme.zero;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, y0 + 0.5);
      ctx.lineTo(W - padR, y0 + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.dimText;
      ctx.font = "8px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText("0", W - padR + 6, y0);
      ctx.fillText(`+${Math.round(mag / 1.18)}`, W - padR + 6, padT + 6);
      ctx.fillText(`${-Math.round(mag / 1.18)}`, W - padR + 6, padT + plotH - 6);

      // ── the AREA: zero → path (green above / red below by current sign) ──
      const fillA = pos ? theme.upFillA : theme.downFillA;
      const fillB = pos ? theme.upFillB : theme.downFillB;
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, fillA);
      grad.addColorStop(1, fillB);
      ctx.beginPath();
      ctx.moveTo(xOf(visible[0].t), y0);
      for (const h of visible) ctx.lineTo(xOf(h.t), yOf(h.d));
      ctx.lineTo(xOf(last.t), y0);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // the line
      ctx.beginPath();
      for (let i = 0; i < visible.length; i++) {
        const x = xOf(visible[i].t), y = yOf(visible[i].d);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = pos ? theme.up : theme.down;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      // live dot + right tag
      const lx = xOf(last.t), ly = yOf(last.d);
      const pulse = 2.4 + Math.sin(frameRef.current / 9) * 1.0;
      ctx.beginPath();
      ctx.arc(lx, ly, pulse + 4.5, 0, Math.PI * 2);
      ctx.fillStyle = pos ? "rgba(14,203,129,0.15)" : "rgba(246,70,93,0.15)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lx, ly, pulse, 0, Math.PI * 2);
      ctx.fillStyle = pos ? theme.up : theme.down;
      ctx.fill();

      ctx.fillStyle = pos ? theme.up : theme.down;
      const tag = `${last.d >= 0 ? "+" : ""}${last.d}`;
      ctx.font = "bold 9.5px ui-monospace, monospace";
      const tw = ctx.measureText(tag).width;
      ctx.fillRect(W - padR + 2, ly - 7, tw + 8, 14);
      ctx.fillStyle = theme.bg;
      ctx.textAlign = "left";
      ctx.fillText(tag, W - padR + 6, ly + 0.5);

      // ── buy/sell split (bottom-left) ──
      const total = p.buy + p.sell;
      const buyPct = total ? Math.round((p.buy / total) * 100) : 50;
      ctx.font = "8.5px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = theme.up;
      ctx.fillText(`${loc === "bn" ? "ক্রেতা" : "buy"} ${buyPct}%`, padL + 4, padT + plotH + 6.5);
      ctx.textAlign = "right";
      ctx.fillStyle = theme.down;
      ctx.fillText(`${100 - buyPct}% ${loc === "bn" ? "বিক্রেতা" : "sell"}`, W - padR - 4, padT + plotH + 6.5);
      // x-axis: window start clock
      ctx.textAlign = "left";
      ctx.fillStyle = theme.dimText;
      ctx.fillText(fmtClock(winStart), padL + 2, padT + plotH + 6.5);

      drawCountdown(ctx, theme, W, padR, padT, now, tf, loc);
    };

    function drawCountdown(
      ctx: CanvasRenderingContext2D, theme: typeof THEMES.dark,
      W: number, padR: number, padT: number, now: number, tf: number, loc: string,
    ) {
      const barEnd = (Math.floor(now / 1000 / tf) + 1) * tf * 1000;
      const cd = fmtCountdown(barEnd - now);
      const label = loc === "bn" ? "শেষ হবে" : "ends in";
      ctx.font = "bold 10px ui-monospace, monospace";
      const cw = ctx.measureText(cd).width;
      ctx.font = "8px ui-monospace, monospace";
      const lw = ctx.measureText(label).width;
      const chipW = cw + lw + 22;
      const chipX = W - padR - chipW - 6, chipY = padT + 1;
      ctx.fillStyle = theme.chipBg;
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipW, 17, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.dimText;
      ctx.textAlign = "left";
      ctx.fillText(label, chipX + 7, chipY + 9);
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillStyle = theme.boundary;
      ctx.textAlign = "right";
      ctx.fillText(cd, chipX + chipW - 7, chipY + 9);
    }

    const loop = () => {
      frameRef.current++;
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // mount once — reads everything from refs

  const winSec = ZOOM_STEPS[step];
  const winLabel = winSec === 0
    ? (locale === "bn" ? "পুরো ক্যান্ডেল" : "full candle")
    : locale === "bn"
      ? `শেষ ${toBn(winSec)} সেকেন্ড`
      : `last ${winSec}s`;
  const delta = flow?.delta ?? 0;
  const pos = delta >= 0;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full touch-pan-y"
      role="img"
      aria-label={`${symbol} ${timeframe} running candle delta, ${winLabel}. ${t("deltaZoomHint")}`}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      {/* header chip: X-RAY Δ · symbol · tf · window */}
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-md border border-border bg-card/70 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground backdrop-blur">
        <span className="text-gold">{t("deltaTitle")}</span>
        <span className="text-border">|</span>
        <span>{symbol}</span>
        <span className="text-border">|</span>
        <span>{timeframe}</span>
        <span className="text-border">|</span>
        <span>{winLabel}</span>
        <span className="text-border">|</span>
        <span className={pos ? "text-up" : "text-down"}>
          Δ {pos ? "+" : ""}{delta}
        </span>
      </div>
      {/* zoom controls */}
      <div className="absolute right-2 top-8 z-10 flex gap-1">
        <button
          type="button"
          onClick={zoomIn}
          disabled={step >= ZOOM_STEPS.length - 1}
          aria-label={t("deltaZoomIn")}
          title={t("deltaZoomIn")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/80 backdrop-blur transition-colors",
            "hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground",
          )}
        >
          <ZoomIn className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={zoomOut}
          disabled={step <= 0}
          aria-label={t("deltaZoomOut")}
          title={t("deltaZoomOut")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/80 backdrop-blur transition-colors",
            "hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground",
          )}
        >
          <ZoomOut className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={zoomReset}
          disabled={step === 0}
          aria-label={t("deltaZoomReset")}
          title={t("deltaZoomReset")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/80 backdrop-blur transition-colors",
            "hover:border-gold/60 hover:text-gold disabled:opacity-40",
          )}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
