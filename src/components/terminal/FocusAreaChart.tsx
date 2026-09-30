"use client";

/**
 * FocusAreaChart v4 — the AREA section (top 30%) of the combined three-chart
 * view, with TRUE free zoom and a CLEAN chart surface.
 *
 * v4 (user request — “সকল চার্ট এর উপর থেকে নির্দেশক প্রতীক গুলো সরিয়ে দাও, এই
 * গুলো চার্ট এর বাহিরে থাকবে"):
 *   · every control lives in a strip OUTSIDE the plot (window chip, zoom
 *     buttons, back-to-live) — nothing floats on the canvas anymore
 *   · on-canvas text (open label, prev-close label, NEW-tf label, countdown
 *     chip) removed — the pure drawing (path, fills, boundary, separators,
 *     live dot, axes) remains
 *   · the pair name lives ONCE in the trio header, not on the chart
 *
 * Kept from v3 (user request: “নিজের মতো করে zoom in zoom out”):
 *   · TIME zoom 1..64 bars · PRICE zoom ×0.3..×8 · PAN with live-snap
 *   · M1-synthesized depth so zoom-out always shows a real path
 *   · TAP — a clean tap fires onActivate (the trio's exit-to-candles)
 *
 * Rendering is pure canvas because the x-axis is TIME-PROPORTIONAL with
 * sub-second tick resolution.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ZoomIn, ZoomOut, RotateCcw, ChevronsUp, ChevronsDown, Play } from "lucide-react";
import { feed, useQuote, useTicks, useBars } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import type { Candle } from "@/lib/market/types";

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/** zoom limits — window size in bars / vertical price stretch */
const ZOOM_MIN = 1;
const ZOOM_MAX = 64;
const VZ_MIN = 0.3;
const VZ_MAX = 8;
const ZOOM_KEY = "focus-zoom-bars";
const VZ_KEY = "focus-zoom-v";
/** a wheel burst / pinch must move at least this much before another step */
const WHEEL_THROTTLE_MS = 60;
/** pinch distance must change by ≥6% per step (dead zone, no jitter) */
const PINCH_RATIO = 1.06;
/** pointer movement beyond this = drag (pan), below = clean tap */
const TAP_SLOP_PX = 7;
/** a stationary release is a tap no matter how long it was held (no
 *  long-press gesture exists here) — generous cap for slow pointers */
const TAP_MAX_MS = 900;
/** panning this close to the live edge snaps home */
const SNAP_HOME_FRAC = 0.12;

const THEMES = {
  dark: {
    bg: "#0c1210", grid: "rgba(157,177,167,0.07)", border: "#223029", text: "#9db1a7",
    dimText: "rgba(157,177,167,0.55)",
    prevFill: "rgba(157,177,167,0.035)",
    runFill: "rgba(245,158,11,0.045)",
    boundary: "#f59e0b",
    up: "#0ecb81", down: "#f6465d",
    upFillA: "rgba(14,203,129,0.28)", upFillB: "rgba(14,203,129,0.01)",
    downFillA: "rgba(246,70,93,0.26)", downFillB: "rgba(246,70,93,0.01)",
    refLine: "rgba(157,177,167,0.4)",
    sep: "rgba(157,177,167,0.22)",
    chipBg: "rgba(34,48,41,0.9)",
    synth: "rgba(157,177,167,0.5)",
    live: "#0ecb81",
  },
  light: {
    bg: "#fcfbf9", grid: "rgba(77,95,85,0.08)", border: "#dcd8cd", text: "#4d5f55",
    dimText: "rgba(77,95,85,0.55)",
    prevFill: "rgba(77,95,85,0.04)",
    runFill: "rgba(217,119,6,0.05)",
    boundary: "#d97706",
    up: "#02c07a", down: "#f0304e",
    upFillA: "rgba(2,192,122,0.26)", upFillB: "rgba(2,192,122,0.01)",
    downFillA: "rgba(240,48,78,0.24)", downFillB: "rgba(240,48,78,0.01)",
    refLine: "rgba(77,95,85,0.45)",
    sep: "rgba(77,95,85,0.25)",
    chipBg: "rgba(220,216,205,0.9)",
    synth: "rgba(77,95,85,0.5)",
    live: "#02c07a",
  },
};

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function fmtClock(ms: number) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBn(n: number) { return String(n).split("").map((c) => BN_DIGITS[Number(c)] ?? c).join(""); }

interface Props {
  /** fired on a clean tap (no drag) — the trio exits back to candles */
  onActivate?: () => void;
}

export default function FocusAreaChart({ onActivate }: Props) {
  const { symbol, timeframe } = useTerminal();
  const { resolvedTheme } = useTheme();
  const { t, locale } = useI18n();
  const ticks = useTicks(symbol);
  const quote = useQuote(symbol);
  const m1 = useBars(symbol, "M1");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const rafRef = useRef(0);

  // ── M1 history: REST fetch + live socket bars (deep-zoom fallback path) ──
  useEffect(() => {
    feed.getCandles(symbol, "M1", 600).catch(() => {});
    feed.subscribeBars(symbol, "M1");
    return () => {
      feed.unsubscribeBars(symbol, "M1");
    };
  }, [symbol]);

  // ── zoom state (persisted) — mirrored into stateRef for the rAF loop ──
  const [bars, setBars] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) return Math.round(v);
    } catch { /* SSR / privacy mode */ }
    return 2;
  });
  const [vZoom, setVZoom] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(VZ_KEY));
      if (Number.isFinite(v) && v >= VZ_MIN && v <= VZ_MAX) return v;
    } catch { /* best-effort */ }
    return 1;
  });
  /** pan back from the live edge in ms (0 = live / follow) */
  const [panMs, setPanMs] = useState(0);

  useEffect(() => {
    try { localStorage.setItem(ZOOM_KEY, String(bars)); } catch { /* best-effort */ }
  }, [bars]);
  useEffect(() => {
    try { localStorage.setItem(VZ_KEY, String(vZoom)); } catch { /* best-effort */ }
  }, [vZoom]);

  const zoomIn = useCallback(() => setBars((b) => Math.max(ZOOM_MIN, b - 1)), []);
  const zoomOut = useCallback(() => setBars((b) => Math.min(ZOOM_MAX, b + 1)), []);
  const vIn = useCallback(() => setVZoom((v) => Math.max(VZ_MIN, v / 1.3)), []);
  const vOut = useCallback(() => setVZoom((v) => Math.min(VZ_MAX, v * 1.3)), []);
  const zoomReset = useCallback(() => {
    setBars(2);
    setVZoom(1);
    setPanMs(0);
  }, []);
  const goLive = useCallback(() => setPanMs(0), []);

  const tfSec = TF_SEC[timeframe] ?? 900;
  const tfMs = tfSec * 1000;
  const digits = quote?.digits ?? 2;

  // ── data depth (ticks + M1) → how far the user may zoom out / pan back ──
  const nowMs = Date.now();
  const tickDepth = ticks.length ? nowMs - ticks[0].t : 0;
  const m1Depth = m1.length ? nowMs - m1[0].t * 1000 + 60_000 : 0;
  const depthMs = Math.max(tickDepth, m1Depth);
  const maxBars = Math.max(1, Math.min(ZOOM_MAX, Math.floor((depthMs - tfMs * 0.5) / tfMs)));
  const effBars = Math.min(bars, maxBars);

  // theme colors resolved once per render — pushed into a ref FOR the rAF loop
  const th = resolvedTheme === "light" ? THEMES.light : THEMES.dark;
  const stateRef = useRef({ ticks, m1, quote, tfSec, digits, th, locale, t, bars, vZoom, panMs, timeframe, effBars, depthMs });

  // live price at the right edge — ref updated by the store, read by rAF
  const priceRef = useRef<number | null>(null);

  useEffect(() => {
    stateRef.current = { ticks, m1, quote, tfSec, digits, th, locale, t, bars, vZoom, panMs, timeframe, effBars, depthMs };
    if (quote?.mid) priceRef.current = quote.mid;
  }, [ticks, m1, quote, tfSec, digits, th, locale, t, bars, vZoom, panMs, timeframe, effBars, depthMs]);

  // keep pan legal when the window grows past available history
  useEffect(() => {
    const winMs = effBars * tfMs;
    const maxPan = Math.max(0, depthMs - winMs - tfMs * 0.25);
    if (panMs > maxPan) setPanMs(maxPan);
  }, [effBars, tfMs, depthMs, panMs]);

  // ── wheel / trackpad zoom: time (plain) · price (shift) ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let lastStep = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastStep < WHEEL_THROTTLE_MS) return;
      lastStep = now;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (e.shiftKey) {
        // vertical price zoom
        if (d > 0) vOut();
        else if (d < 0) vIn();
      } else if (d > 0) {
        zoomOut();
      } else if (d < 0) {
        zoomIn();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomIn, zoomOut, vIn, vOut]);

  // ── two-finger pinch zoom (touch) — time axis ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let lastDist = 0;
    const dist = (t1: Touch, t2: Touch) =>
      Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
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

  // ── drag to pan + clean tap → onActivate ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let startX = 0, startY = 0, startPan = 0, startT = 0, dragged = false, down = false;
    const winMsNow = () => stateRef.current.effBars * stateRef.current.tfSec * 1000;
    const msPerPx = () => {
      const c = canvasRef.current;
      const w = c ? c.clientWidth - 70 : 600;
      return winMsNow() / Math.max(120, w);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // buttons/controls inside the chart must keep their clicks — never capture
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, [role='button'], [data-no-pan]")) return;
      down = true; dragged = false;
      startX = e.clientX; startY = e.clientY; startT = performance.now();
      startPan = stateRef.current.panMs;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) > TAP_SLOP_PX) dragged = true;
      if (!dragged) return;
      const win = winMsNow();
      const depth = stateRef.current.depthMs;
      const next = Math.max(0, Math.min(depth - win - stateRef.current.tfSec * 250, startPan + dx * msPerPx()));
      // snap-home gravity near the live edge
      const snap = next < win * SNAP_HOME_FRAC ? 0 : next;
      setPanMs(snap);
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      if (!dragged && performance.now() - startT < TAP_MAX_MS) onActivate?.();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [onActivate]);

  // ── the canvas rAF loop (mount once; reads everything from refs) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const S = stateRef.current;
      const { ticks: tk, m1: m1bars, th: theme, locale: loc, vZoom: vz, panMs: pan } = S;
      const dg = S.digits;
      const nb = S.effBars;
      const tf = S.tfSec;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // ── layout ──
      const padR = 62, padT = 8, padB = 26, padL = 8;
      const plotW = W - padR - padL, plotH = H - padT - padB;
      if (plotW <= 10 || plotH <= 10) return;
      const now = Date.now();
      const liveBarStart = Math.floor(now / 1000 / tf) * tf * 1000;   // running bar open (ms)
      const liveBarEnd = liveBarStart + tf * 1000;
      const winMs = nb * tf * 1000;
      const winEnd = pan > 0 ? liveBarEnd - pan : liveBarEnd;         // right edge
      const winStart = winEnd - winMs;                                // N-bar window: left edge
      const live = pan <= 0;

      // ── collect the visible path: synth (M1) where older than ticks + real ticks ──
      const visibleTicks = tk.filter((p) => p.t >= winStart - 200 && p.t <= winEnd + 50);
      const liveMid = priceRef.current;
      const tickStartT = visibleTicks.length ? visibleTicks[0].t : Infinity;

      // synth from M1 candles for the part of the window the tick ring can't reach
      const synth: { t: number; p: number }[] = [];
      if (winStart < tickStartT - 3000 && m1bars.length) {
        for (const b of m1bars) {
          const bo = b.t * 1000, bc = bo + 60_000;
          if (bc < winStart) continue;
          if (bo > Math.min(winEnd, tickStartT)) break;
          if (bo >= winStart) synth.push({ t: bo, p: b.o });
          if (bc <= Math.min(winEnd, tickStartT)) synth.push({ t: bc, p: b.c });
        }
      }
      const tickPath = visibleTicks.filter((p) => p.t >= winStart && p.t <= winEnd);
      const path: { t: number; p: number }[] = [...synth, ...tickPath];
      if (live && liveMid && (!path.length || now - path[path.length - 1].t > 40)) {
        path.push({ t: now, p: liveMid });
      }
      const synthEndT = synth.length ? synth[synth.length - 1].t : -Infinity;

      // price range: path + live + padding, then ×vZoom around the centre
      let lo = Infinity, hi = -Infinity;
      for (const p of path) { if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p; }
      if (!path.length) { lo = liveMid ? liveMid * 0.999 : 0; hi = liveMid ? liveMid * 1.001 : 1; }
      const range = Math.max(hi - lo, Math.abs(hi) * 1e-6, 1e-9);
      lo -= range * 0.18; hi += range * 0.18;
      const centre = (lo + hi) / 2;
      const half = ((hi - lo) / 2) * vz;
      lo = centre - half; hi = centre + half;

      const xOf = (t: number) => padL + ((t - winStart) / (winEnd - winStart)) * plotW;
      const yOf = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;

      // ── backgrounds: completed bars dim / running bar highlighted ──
      const barStart = liveBarStart; // gold boundary anchor (running bar)
      const bx = xOf(barStart);
      if (barStart > winStart && barStart < winEnd) {
        ctx.fillStyle = theme.prevFill;
        ctx.fillRect(padL, padT, Math.max(0, bx - padL), plotH);
        ctx.fillStyle = theme.runFill;
        ctx.fillRect(bx, padT, W - padR - bx, plotH);
      } else {
        // historical window — plain completed-bar wash
        ctx.fillStyle = theme.prevFill;
        ctx.fillRect(padL, padT, plotW, plotH);
      }

      // ── horizontal grid + right price labels ──
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y + 0.5);
        ctx.lineTo(W - padR, y + 0.5);
        ctx.stroke();
        const price = hi - ((hi - lo) * i) / 4;
        ctx.fillStyle = theme.dimText;
        ctx.fillText(price.toFixed(dg), W - padR + 6, y);
      }

      // ── faint separators at each bar open in the window ──
      const barsInView = winMs / (tf * 1000);
      if (barsInView <= 41) {
        ctx.strokeStyle = theme.sep;
        ctx.lineWidth = 1;
        const firstOpen = Math.ceil(winStart / (tf * 1000)) * tf * 1000;
        for (let t0 = firstOpen; t0 < winEnd; t0 += tf * 1000) {
          if (t0 === barStart) continue; // the gold boundary owns this line
          const sx = xOf(t0);
          if (sx < padL + 1 || sx > W - padR - 1) continue;
          ctx.beginPath();
          ctx.moveTo(sx + 0.5, padT);
          ctx.lineTo(sx + 0.5, padT + plotH);
          ctx.stroke();
        }
      }

      // ── boundary line: “new bar starts HERE” (only when the running bar is in view) ──
      // (v4: the gold dashed line only — the text label lives off-canvas now)
      if (barStart > winStart && barStart < winEnd) {
        ctx.strokeStyle = theme.boundary;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, padT - 4);
        ctx.lineTo(bx + 0.5, padT + plotH + 6);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── previous bar close reference (dotted line only — v4 moved the
      //    text off-canvas; the line itself is chart drawing, not a badge) ──
      const rightBarStart = Math.floor((winEnd - 1) / (tf * 1000)) * tf * 1000; // bar at the right edge
      const prevPath = path.filter((p) => p.t >= rightBarStart - tf * 1000 && p.t < rightBarStart);
      const prevClose = prevPath.length ? prevPath[prevPath.length - 1].p : null;
      if (prevClose !== null && prevClose >= lo && prevClose <= hi) {
        const y = yOf(prevClose);
        ctx.strokeStyle = theme.refLine;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(padL, y + 0.5);
        ctx.lineTo(W - padR, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── the AREA itself ──
      if (path.length >= 2) {
        const lastP = path[path.length - 1].p;
        const firstP = path[0].p;
        const base = prevClose ?? firstP;
        const rising = lastP >= base;
        const line = rising ? theme.up : theme.down;
        const fillA = rising ? theme.upFillA : theme.downFillA;
        const fillB = rising ? theme.upFillB : theme.downFillB;

        // area fill (to the bottom of the plot) — one continuous path
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, fillA);
        grad.addColorStop(1, fillB);
        ctx.beginPath();
        ctx.moveTo(xOf(path[0].t), padT + plotH);
        for (const p of path) ctx.lineTo(xOf(p.t), yOf(p.p));
        ctx.lineTo(xOf(path[path.length - 1].t), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // synthesized (M1) segment — dimmed, the "older than tick memory" part
        if (synth.length >= 2) {
          ctx.beginPath();
          for (let i = 0; i < synth.length; i++) {
            const x = xOf(synth[i].t), y = yOf(synth[i].p);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = theme.synth;
          ctx.lineWidth = 1.1;
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        // the live tick line — full brightness (from where synth ends)
        const liveSeg = path.filter((p) => p.t >= synthEndT - 1);
        if (liveSeg.length >= 2) {
          ctx.beginPath();
          for (let i = 0; i < liveSeg.length; i++) {
            const x = xOf(liveSeg[i].t), y = yOf(liveSeg[i].p);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = line;
          ctx.lineWidth = 1.6;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.stroke();
        }

        // glowing dot at the right edge of the path
        const lx = xOf(path[path.length - 1].t), ly = yOf(lastP);
        const pulse = 2.6 + Math.sin(frameRef.current / 9) * 1.1;
        ctx.beginPath();
        ctx.arc(lx, ly, pulse + 5, 0, Math.PI * 2);
        ctx.fillStyle = rising ? "rgba(14,203,129,0.15)" : "rgba(246,70,93,0.15)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(lx, ly, pulse, 0, Math.PI * 2);
        ctx.fillStyle = line;
        ctx.fill();

        // right-axis live tag
        ctx.fillStyle = line;
        const tag = lastP.toFixed(dg);
        ctx.font = "bold 9.5px ui-monospace, monospace";
        const tw = ctx.measureText(tag).width;
        ctx.fillRect(W - padR + 2, ly - 7, tw + 8, 14);
        ctx.fillStyle = theme.bg;
        ctx.textAlign = "left";
        ctx.fillText(tag, W - padR + 6, ly + 0.5);
      } else {
        // waiting for the first ticks
        ctx.fillStyle = theme.dimText;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          loc === "bn" ? "টিক অপেক্ষা করা হচ্ছে…" : "waiting for ticks…",
          padL + plotW / 2, padT + plotH / 2,
        );
      }

      // ── x-axis: window start · boundary · right edge ──
      ctx.font = "8.5px ui-monospace, monospace";
      ctx.fillStyle = theme.dimText;
      ctx.textAlign = "left";
      ctx.fillText(fmtClock(winStart), padL + 2, H - padB + 12);
      ctx.textAlign = "center";
      const midT = (winStart + winEnd) / 2;
      ctx.fillText(fmtClock(midT), padL + plotW / 2, H - padB + 12);
      ctx.textAlign = "right";
      ctx.fillText(fmtClock(live ? now : winEnd), W - padR - 2, H - padB + 12);
    };

    const loop = () => {
      frameRef.current++;
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => {});
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []); // the rAF loop reads everything from refs — mount once

  const barsLabel = locale === "bn"
    ? `${toBn(effBars)}-বার ফোকাস`
    : `${effBars}-bar focus`;
  const live = panMs <= 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card/30" role="region" aria-label={t("trioAreaLabel")}>
      {/* control strip — OUTSIDE the plot (v4: nothing floats on the chart) */}
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <span className="font-mono text-[9px] font-black uppercase tracking-wider text-gold">
          {t("trioAreaLabel")}
        </span>
        <span className="text-border">|</span>
        <span className="tnum font-mono text-[9px] font-bold tracking-wider text-muted-foreground">
          {barsLabel}
        </span>
        {vZoom !== 1 && (
          <>
            <span className="text-border">|</span>
            <span className="tnum font-mono text-[9px] tracking-wider text-muted-foreground/70">
              ×{vZoom.toFixed(1)}
            </span>
          </>
        )}
        {!live && (
          <>
            <span className="text-border">|</span>
            <span className="font-mono text-[9px] font-bold tracking-wider text-amber-500">
              {t("areaPanned")}
            </span>
            <button
              type="button"
              onClick={goLive}
              className="flex h-4 items-center gap-1 rounded-full border border-gold/60 bg-gold/15 px-1.5 font-mono text-[8px] font-bold text-gold transition-colors hover:bg-gold/25"
              aria-label={t("areaGoLive")}
            >
              <Play className="h-2 w-2" />
              {t("areaGoLive")}
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={zoomIn}
            disabled={effBars <= ZOOM_MIN}
            aria-label={t("areaZoomIn")}
            title={t("areaZoomIn")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ZoomIn className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={zoomOut}
            disabled={effBars >= ZOOM_MAX || effBars >= maxBars}
            aria-label={t("areaZoomOut")}
            title={t("areaZoomOut")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ZoomOut className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={vIn}
            disabled={vZoom <= VZ_MIN}
            aria-label={t("areaZoomVIn")}
            title={t("areaZoomVIn")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ChevronsDown className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={vOut}
            disabled={vZoom >= VZ_MAX}
            aria-label={t("areaZoomVOut")}
            title={t("areaZoomVOut")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ChevronsUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={zoomReset}
            disabled={effBars === 2 && vZoom === 1 && live}
            aria-label={t("areaZoomReset")}
            title={t("areaZoomReset")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40"
          >
            <RotateCcw className="h-2.5 w-2.5" />
          </button>
        </span>
      </div>

      {/* the chart — pure drawing, nothing overlaid */}
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 cursor-grab touch-pan-y active:cursor-grabbing"
        role="img"
        aria-label={`${symbol} ${timeframe} area chart, ${effBars} bar window. ${t("areaZoomHint")}`}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
    </div>
  );
}
