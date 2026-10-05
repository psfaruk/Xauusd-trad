"use client";

/**
 * DeltaMicroStrip v2 — the X-ray panel's "Delta micro" section as a REAL
 * chart in the MIDDLE band (30%) of the triple-chart view (user request):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ MICRO Δ · ২ ক্যান্ডেল · ⏳ 3:24          [ + ] [ − ] [ ⟳ ] │  strip (outside)
 *   ├─────────┬────────────────────────────────────────────────┤
 *   │  DELTA  │ │        cumulative delta, candle-aware        │ │
 *   │  +123   │ │  2 candles by default — every candle open    │ │  plot
 *   │  MICRO  │ │  gets a separator + the running open a GOLD  │ │
 *   │  +45    │ │  boundary (exactly like the area chart)      │ │
 *   ├─────────┴────────────────────────────────────────────────┤
 *   │ ক্রেতা 62% ━━━━━━━━━━━━━━━━━━━━━ 38% বিক্রেতা              │  strip (outside)
 *   └──────────────────────────────────────────────────────────┘
 *
 * "এর এখানে 2 টি ক্যান্ডেল এর চার্ট থাকবে, যেমন টা এরিয়া চার্ট এ স্পষ্ট করে
 *  দেখা যায় কখন কোন ক্যান্ডেল টি কোথায় শেষ হলো" — the default window is the
 * previous + running candle, with a clear boundary where each candle ends.
 *
 * "movement বা জুম আউট ইন, স্মুথলি" — zoom (wheel/pinch/buttons) and pan
 * (drag) are CONTINUOUS and eased every frame (buttery, not stepped).
 *
 * Data: histDeep (cross-candle, ~2.3 candles, refreshed every 2s) carries
 * the previous candle + older part; deltaHist carries the fresh running
 * tail at the full emit rate; the live delta closes the path at "now".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw, Play } from "lucide-react";
import { useFlow, useFlowDeep } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/** zoom limits — visible window in seconds */
const WIN_MIN_SEC = 10;
/** how deep the user may zoom out, in candles */
const MAX_CANDLES = 6;
/** easing factor per frame — 0.22 settles in ~a dozen frames */
const EASE = 0.22;
const WHEEL_THROTTLE_MS = 60;
const WHEEL_FACTOR = 1.18;
const PINCH_RATIO = 1.06;
const TAP_SLOP_PX = 7;
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
    upFillA: "rgba(14,203,129,0.26)", upFillB: "rgba(14,203,129,0.02)",
    downFillA: "rgba(246,70,93,0.24)", downFillB: "rgba(246,70,93,0.02)",
    zero: "rgba(157,177,167,0.55)",
    sep: "rgba(157,177,167,0.22)",
    chipBg: "rgba(34,48,41,0.9)",
  },
  light: {
    bg: "#fcfbf9", grid: "rgba(77,95,85,0.08)", border: "#dcd8cd", text: "#4d5f55",
    dimText: "rgba(77,95,85,0.55)",
    prevFill: "rgba(77,95,85,0.04)",
    runFill: "rgba(217,119,6,0.05)",
    boundary: "#d97706",
    up: "#02c07a", down: "#f0304e",
    upFillA: "rgba(2,192,122,0.24)", upFillB: "rgba(2,192,122,0.02)",
    downFillA: "rgba(240,48,78,0.22)", downFillB: "rgba(240,48,78,0.02)",
    zero: "rgba(77,95,85,0.55)",
    sep: "rgba(77,95,85,0.25)",
    chipBg: "rgba(220,216,205,0.9)",
  },
};

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function fmtClock(ms: number) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function toBn(n: number | string) { return String(n).split("").map((c) => BN_DIGITS[Number(c)] ?? c).join(""); }

export default function DeltaMicroStrip() {
  const { symbol, timeframe } = useTerminal();
  const { t, locale } = useI18n();
  const flow = useFlow(symbol, timeframe);
  const deep = useFlowDeep(symbol, timeframe);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const rafRef = useRef(0);

  const tfSec = TF_SEC[timeframe] ?? 900;
  const tfMs = tfSec * 1000;
  const defWin = tfSec * 2; // the user's spec: 2 candles

  // ── zoom / pan targets (React state) + eased display values (refs) ──
  const [winSec, setWinSec] = useState(defWin);
  const [panMs, setPanMs] = useState(0);
  // when the timeframe changes, snap the window back to the 2-candle spec
  const lastTfRef = useRef(timeframe);
  useEffect(() => {
    if (lastTfRef.current !== timeframe) {
      lastTfRef.current = timeframe;
      // v16.9: TF_SEC[timeframe] is typed number (Record<string, number>), so
      // the old `TF_SEC[timeframe] * 2 ?? defWin` right operand was dead code
      // (TS2869) — and NaN is never nullish, so the fallback never fired
      // anyway. defWin IS the 2-candle spec (tfSec already 900-fallback).
      setWinSec(defWin);
      setPanMs(0);
    }
  }, [timeframe, defWin]);

  const depthMs = deep.length ? Date.now() - deep[0].t : 0;
  const maxWinSec = Math.max(defWin, Math.min(MAX_CANDLES * tfSec, (depthMs + tfMs * 0.5) / 1000));
  const effWinSec = Math.min(winSec, maxWinSec);

  const zoomIn = useCallback(() => setWinSec((w) => Math.max(WIN_MIN_SEC, w / 1.5)), []);
  const zoomOut = useCallback(() => setWinSec((w) => Math.min(MAX_CANDLES * tfSec * 1.001, w * 1.5)), [tfSec]);
  const zoomReset = useCallback(() => { setWinSec(defWin); setPanMs(0); }, [defWin]);
  const goLive = useCallback(() => setPanMs(0), []);

  // keep pan legal when the window grows past available history
  useEffect(() => {
    const maxPan = Math.max(0, depthMs + tfMs - effWinSec * 1000 - tfMs * 0.25);
    if (panMs > maxPan) setPanMs(maxPan);
  }, [effWinSec, depthMs, tfMs, panMs]);

  // ── per-second ticker (countdown in the outside strip) ──
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── everything the rAF loop needs, mirrored into a ref ──
  // the merged delta path (deep cross-candle ∪ fresh running tail, time-sorted)
  // is rebuilt ONLY when the data changes — not every frame. Same-t points are
  // KEPT: the candle-roll pairs {t, finalD}→{t, 0} are the vertical reset lines.
  const stateRef = useRef<{ path: { t: number; d: number }[]; delta: number; tfSec: number; locale: string; timeframe: string; winSec: number; panMs: number; depthMs: number }>({
    path: [], delta: 0, tfSec, locale, timeframe, winSec: effWinSec, panMs: 0, depthMs: 0,
  });
  useEffect(() => {
    const hist = flow?.deltaHist ?? [];
    const merged = [...deep, ...hist].sort((a, b) => a.t - b.t);
    stateRef.current = { path: merged, delta: flow?.delta ?? 0, tfSec, locale, timeframe, winSec: effWinSec, panMs, depthMs };
  }, [deep, flow, tfSec, locale, timeframe, effWinSec, panMs, depthMs]);

  // ── wheel zoom (continuous — the eased rAF makes it buttery) ──
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
      if (d > 0) zoomOut();
      else if (d < 0) zoomIn();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomIn, zoomOut]);

  // ── two-finger pinch zoom ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let lastDist = 0;
    const dist = (t1: Touch, t2: Touch) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
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

  // ── drag to pan (mouse + touch) ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let startX = 0, startPan = 0, down = false, dragged = false;
    const msPerPx = () => {
      const c = canvasRef.current;
      const w = c ? c.clientWidth - 60 : 500;
      return (stateRef.current.winSec * 1000) / Math.max(120, w);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, [role='button'], [data-no-pan]")) return;
      down = true; dragged = false;
      startX = e.clientX;
      startPan = stateRef.current.panMs;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!dragged && Math.abs(dx) > TAP_SLOP_PX) dragged = true;
      if (!dragged) return;
      const S = stateRef.current;
      const win = S.winSec * 1000;
      const next = Math.max(0, Math.min(S.depthMs + S.tfSec * 750, startPan + dx * msPerPx()));
      const snap = next < win * SNAP_HOME_FRAC ? 0 : next;
      setPanMs(snap);
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* gone */ }
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
  }, []);

  // ── the canvas rAF loop (mount once; eased zoom/pan live here) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // eased display values — the "স্মুথলি" in the user's request
    let dWinMs = 0, dPanMs = 0;

    const draw = () => {
      const S = stateRef.current;
      const loc = S.locale;
      const tf = S.tfSec * 1000;
      const isDark = !document.documentElement.classList.contains("light");
      const theme = isDark ? THEMES.dark : THEMES.light;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // ease toward the targets (snap when close)
      const targetWin = S.winSec * 1000;
      if (Math.abs(targetWin - dWinMs) < 40) dWinMs = targetWin;
      else dWinMs += (targetWin - dWinMs) * EASE;
      const targetPan = S.panMs;
      if (Math.abs(targetPan - dPanMs) < 30) dPanMs = targetPan;
      else dPanMs += (targetPan - dPanMs) * EASE;

      // ── layout ──
      const padR = 56, padT = 6, padB = 16, padL = 6;
      const plotW = W - padR - padL, plotH = H - padT - padB;
      if (plotW <= 10 || plotH <= 10) return;
      const now = Date.now();
      const liveBarStart = Math.floor(now / tf) * tf;
      const liveBarEnd = liveBarStart + tf;
      const winEnd = dPanMs > 0 ? liveBarEnd - dPanMs : liveBarEnd;
      const winStart = winEnd - dWinMs;
      const live = dPanMs <= 0;

      // ── the delta path: merged (deep + fresh tail) filtered to the window,
      //      closed by the live point (same cumulative counter) ──
      const inWin = (p: { t: number }) => p.t >= winStart - 200 && p.t <= winEnd + 50;
      const pts: { t: number; d: number }[] = [];
      for (const p of S.path) if (inWin(p)) pts.push({ t: p.t, d: p.d });
      const lastD = S.delta;
      if (live && pts.length) {
        // continuous live edge — same cumulative counter as the samples
        pts.push({ t: now, d: lastD });
      }

      // ── vertical range: always include 0 (the zero line is the story) ──
      let lo = 0, hi = 0;
      for (const p of pts) { if (p.d < lo) lo = p.d; if (p.d > hi) hi = p.d; }
      if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
      const padV = (hi - lo) * 0.14;
      lo -= padV; hi += padV;

      const xOf = (tm: number) => padL + ((tm - winStart) / (winEnd - winStart)) * plotW;
      const yOf = (d: number) => padT + (1 - (d - lo) / (hi - lo)) * plotH;

      // ── backgrounds: completed candles dim / running candle highlighted ──
      if (liveBarStart > winStart && liveBarStart < winEnd) {
        const bx = xOf(liveBarStart);
        ctx.fillStyle = theme.prevFill;
        ctx.fillRect(padL, padT, Math.max(0, bx - padL), plotH);
        ctx.fillStyle = theme.runFill;
        ctx.fillRect(bx, padT, W - padR - bx, plotH);
      } else {
        ctx.fillStyle = theme.prevFill;
        ctx.fillRect(padL, padT, plotW, plotH);
      }

      // ── horizontal grid + right delta labels (axis — outside the plot) ──
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const steps = 3;
      for (let i = 0; i <= steps; i++) {
        const y = padT + (plotH * i) / steps;
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y + 0.5);
        ctx.lineTo(W - padR, y + 0.5);
        ctx.stroke();
        const v = Math.round(hi - ((hi - lo) * i) / steps);
        ctx.fillStyle = theme.dimText;
        ctx.fillText(String(v), W - padR + 6, y);
      }

      // ── zero line (dashed — buyers above, sellers below) ──
      const zy = yOf(0);
      ctx.strokeStyle = theme.zero;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, zy + 0.5);
      ctx.lineTo(W - padR, zy + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── faint separators at every candle open (where each candle ends) ──
      const candlesInView = dWinMs / tf;
      if (candlesInView <= 25) {
        ctx.strokeStyle = theme.sep;
        ctx.lineWidth = 1;
        const firstOpen = Math.ceil(winStart / tf) * tf;
        for (let t0 = firstOpen; t0 < winEnd; t0 += tf) {
          if (t0 === liveBarStart) continue; // the gold boundary owns this line
          const sx = xOf(t0);
          if (sx < padL + 1 || sx > W - padR - 1) continue;
          ctx.beginPath();
          ctx.moveTo(sx + 0.5, padT);
          ctx.lineTo(sx + 0.5, padT + plotH);
          ctx.stroke();
        }
      }

      // ── the delta path ──
      if (pts.length >= 1) {
        // two-tone area fill against the zero line: green above, red below
        const pathPoly = () => {
          ctx.beginPath();
          ctx.moveTo(xOf(pts[0].t), zy);
          for (const p of pts) ctx.lineTo(xOf(p.t), yOf(p.d));
          ctx.lineTo(xOf(pts[pts.length - 1].t), zy);
          ctx.closePath();
        };
        // above zero → buyers
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, padT, plotW, Math.max(0, zy - padT));
        ctx.clip();
        pathPoly();
        const gUp = ctx.createLinearGradient(0, padT, 0, zy);
        gUp.addColorStop(0, theme.upFillB);
        gUp.addColorStop(1, theme.upFillA);
        ctx.fillStyle = gUp;
        ctx.fill();
        ctx.restore();
        // below zero → sellers
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, zy, plotW, Math.max(0, padT + plotH - zy));
        ctx.clip();
        pathPoly();
        const gDn = ctx.createLinearGradient(0, zy, 0, padT + plotH);
        gDn.addColorStop(0, theme.downFillA);
        gDn.addColorStop(1, theme.downFillB);
        ctx.fillStyle = gDn;
        ctx.fill();
        ctx.restore();

        // the line
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const x = xOf(pts[i].t), y = yOf(pts[i].d);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = lastD >= 0 ? theme.up : theme.down;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();

        // pulsing live dot at the path's end
        const lx = xOf(pts[pts.length - 1].t), ly = yOf(pts[pts.length - 1].d);
        const pulse = 2.4 + Math.sin(frameRef.current / 9) * 1;
        ctx.beginPath();
        ctx.arc(lx, ly, pulse + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = lastD >= 0 ? "rgba(14,203,129,0.15)" : "rgba(246,70,93,0.15)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(lx, ly, pulse, 0, Math.PI * 2);
        ctx.fillStyle = lastD >= 0 ? theme.up : theme.down;
        ctx.fill();

        // right-axis Δ tag (gutter — axis territory)
        ctx.fillStyle = lastD >= 0 ? theme.up : theme.down;
        const tag = `Δ${lastD >= 0 ? "+" : ""}${lastD}`;
        ctx.font = "bold 9.5px ui-monospace, monospace";
        const tw = ctx.measureText(tag).width;
        ctx.fillRect(W - padR + 2, ly - 7, tw + 8, 14);
        ctx.fillStyle = theme.bg;
        ctx.textAlign = "left";
        ctx.fillText(tag, W - padR + 6, ly + 0.5);
      } else {
        ctx.fillStyle = theme.dimText;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          loc === "bn" ? "ডেল্টা অপেক্ষা করা হচ্ছে…" : "waiting for delta…",
          padL + plotW / 2, padT + plotH / 2,
        );
      }

      // ── gold boundary at the running candle's open — the dashed line only
      //    (v2: text labels live off-canvas; where each candle ends is read
      //    from the separators + this boundary + the strip countdown) ──
      if (liveBarStart > winStart && liveBarStart < winEnd) {
        const bx = xOf(liveBarStart);
        ctx.strokeStyle = theme.boundary;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, padT - 2);
        ctx.lineTo(bx + 0.5, padT + plotH + 4);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── x-axis: window start · mid · end ──
      ctx.font = "8.5px ui-monospace, monospace";
      ctx.fillStyle = theme.dimText;
      ctx.textAlign = "left";
      ctx.fillText(fmtClock(winStart), padL + 2, H - padB + 10);
      ctx.textAlign = "center";
      ctx.fillText(fmtClock((winStart + winEnd) / 2), padL + plotW / 2, H - padB + 10);
      ctx.textAlign = "right";
      ctx.fillText(fmtClock(live ? now : winEnd), W - padR - 2, H - padB + 10);
    };

    const loop = () => {
      frameRef.current++;
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // the rAF loop reads everything from refs — mount once

  // ── outside-strip labels ──
  const live = panMs <= 0;
  const liveBarEnd = Math.floor(nowTick / tfMs) * tfMs + tfMs;
  const candles = effWinSec / tfSec;
  const winLabel = candles >= 1
    ? (locale === "bn"
        ? `${toBn(candles >= 9.95 ? Math.round(candles) : candles.toFixed(candles >= 3 ? 0 : 1))} ক্যান্ডেল`
        : `${candles >= 9.95 ? Math.round(candles) : candles.toFixed(candles >= 3 ? 0 : 1)} candle${candles >= 1.95 ? "s" : ""}`)
    : (locale === "bn" ? `শেষ ${toBn(Math.round(effWinSec))} সেকেন্ড` : `last ${Math.round(effWinSec)}s`);

  const delta = flow?.delta ?? 0;
  const micro = flow?.recentDelta ?? 0;
  const total = (flow?.buy ?? 0) + (flow?.sell ?? 0);
  const buyPct = total ? Math.round(((flow?.buy ?? 0) / total) * 100) : 50;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-card/30"
      role="img"
      aria-label={`${symbol} ${timeframe} delta micro: Δ ${delta}, micro ${micro}. ${t("deltaZoomHint")}`}
    >
      {/* top strip (outside the plot): title · window · countdown/history · zoom
          — no symbol/tf here: the trio header shows the pair ONCE (user request) */}
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <span className="font-mono text-[9px] font-black uppercase tracking-wider text-gold">
          {t("flowRecent")}
        </span>
        <span className="text-border">|</span>
        <span className="truncate font-mono text-[9px] tracking-wider text-muted-foreground/70">
          {winLabel}
        </span>
        {live ? (
          <>
            <span className="text-border">|</span>
            <span className="tnum font-mono text-[9px] font-bold tracking-wider text-gold">
              {t("deltaEndsIn")} {fmtCountdown(liveBarEnd - nowTick)}
            </span>
          </>
        ) : (
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
            disabled={effWinSec <= WIN_MIN_SEC}
            aria-label={t("deltaZoomIn")}
            title={t("deltaZoomIn")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ZoomIn className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={zoomOut}
            disabled={effWinSec >= maxWinSec}
            aria-label={t("deltaZoomOut")}
            title={t("deltaZoomOut")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <ZoomOut className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={zoomReset}
            disabled={live && Math.abs(effWinSec - defWin) < 1}
            aria-label={t("deltaZoomReset")}
            title={t("deltaZoomReset")}
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-card/80 text-muted-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40"
          >
            <RotateCcw className="h-2.5 w-2.5" />
          </button>
        </span>
      </div>

      {/* main band — numbers on the left (outside), live canvas plot on the right */}
      <div className="flex min-h-0 flex-1 items-stretch">
        <div className="flex w-[86px] shrink-0 flex-col justify-center gap-1 border-r border-border/60 px-2.5 sm:w-[110px] sm:px-3">
          <div>
            <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("flowDelta")}
            </div>
            <div
              className={cn(
                "tnum font-mono text-xl font-black leading-none sm:text-2xl",
                delta >= 0 ? "text-up" : "text-down",
              )}
            >
              {delta >= 0 ? "+" : ""}{delta}
            </div>
          </div>
          <div className="border-t border-border/60 pt-1">
            <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("flowRecent")}
            </div>
            <div
              className={cn(
                "tnum font-mono text-sm font-bold leading-tight",
                micro >= 0 ? "text-up" : "text-down",
              )}
            >
              {micro >= 0 ? "+" : ""}{micro}
            </div>
          </div>
        </div>

        {/* the plot — nothing overlaid on it except the live pill */}
        <div
          ref={wrapRef}
          className="relative min-w-0 flex-1 cursor-grab touch-pan-y active:cursor-grabbing"
        >
          <canvas ref={canvasRef} className="h-full w-full" />
        </div>
      </div>

      {/* bottom strip (outside): running candle buy/sell pressure */}
      <div className="flex h-4 shrink-0 items-center gap-2 border-t border-border/60 px-2">
        <span className="tnum font-mono text-[8px] font-bold text-up">
          {locale === "bn" ? "ক্রেতা" : "buy"} {buyPct}%
        </span>
        <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-up" style={{ width: `${buyPct}%`, transition: "width 250ms ease" }} />
          <div className="h-full bg-down" style={{ width: `${100 - buyPct}%`, transition: "width 250ms ease" }} />
        </div>
        <span className="tnum font-mono text-[8px] font-bold text-down">
          {100 - buyPct}% {locale === "bn" ? "বিক্রেতা" : "sell"}
        </span>
      </div>
    </div>
  );
}
