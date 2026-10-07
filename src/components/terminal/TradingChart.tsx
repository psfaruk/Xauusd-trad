/**
 * TradingChart — MT5-style candlestick chart.
 *
 * Engine: lightweight-charts v4 (candles + ghosted volume) with a custom
 * canvas overlay. v21.0 REWRITES the drawing layer from scratch:
 *
 *   · ink.ts         — the clean ink builder: the chart needs ONLY the
 *     swing structure (HH/HL/LH/LL + one zigzag), the two key levels
 *     (nearest R above + S below) and — when one exists — the AI Board's
 *     fresh decision (entry/SL/TP + OB box + trendline). Nothing else.
 *     ("যখন যেই ড্রয়িং টি chart এ দরকার সেই ড্রয়িং টি থাকবে")
 *   · overlay-clean.ts — THE HAND: bold clear lines (ENTRY 2px gold, SL/
 *     TP colored with risk/reward zone fills), ONE right-edge label
 *     column that nudges labels apart — nothing overlaps, ever.
 *
 * The old 19-kind auto-ink pipeline (drawings.ts → inkSelect →
 * overlay-render) is DELETED — it was the "এলোমেলো / ওভার রাইট" complaint.
 *
 * This file owns the CHART plumbing: lifecycle, data, the rAF easing
 * loop, kill-zone bands, the EMA ribbon, user drawings with
 * hit-test/drag/persist, free zoom, and the crosshair legend.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { feed, useBars } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { buildCleanInk } from "@/lib/market/ink";
import { renderClean } from "./overlay-clean";
import type {
  BoardSessionPayload,
  Candle,
  SignalPayload,
  UserDrawing,
} from "@/lib/market/types";
import type { Layers, ToolId } from "@/hooks/useTerminal";
import {
  hardText,
  clamp,
  fmtCompact,
  distToSeg,
} from "./overlay-utils";
import { Plus, Minus, Maximize, ArrowRightToLine, Loader2 } from "lucide-react";

const EASE = 0.22;
const FOLLOW_SLACK_BARS = 2;
const RIGHT_PAD = 5;


const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400,
};

const THEMES = {
  dark: {
    bg: "#0c1210", text: "#9db1a7", grid: "#141d18", border: "#223029",
    up: "#0ecb81", down: "#f6465d", wickUp: "#2fe0a0", wickDown: "#ff7086",
    volUp: "rgba(14,203,129,0.10)", volDown: "rgba(246,70,93,0.10)",
    crosshair: "#6b7a72",
  },
  light: {
    bg: "#fcfbf9", text: "#4d5f55", grid: "#ece9e1", border: "#dcd8cd",
    up: "#02c07a", down: "#f0304e", wickUp: "#10d68d", wickDown: "#ff5a72",
    volUp: "rgba(2,192,122,0.10)", volDown: "rgba(240,48,78,0.10)",
    crosshair: "#9aa89f",
  },
};

interface Props {
  symbol: string;
  timeframe: string;
  digits: number;
  layers: Layers;
  tool: ToolId;
  onToolDone: () => void;
  /** the AI Board's latest decision for this symbol+tf (drives the hero ink:
   * entry/SL/TP lines + OB box + trendline). Null → structure-only chart. */
  board: BoardSessionPayload | null;
  signals: SignalPayload[];
  selectedSignalId: string | null;
  userDrawings: UserDrawing[];
  onCreateDrawing: (d: Omit<UserDrawing, "id" | "createdAt">) => void;
  onUpdateDrawing: (id: string, points: UserDrawing["points"], style: UserDrawing["style"]) => void;
  onDeleteDrawing: (id: string) => void;
  /** BARE mode (the trio's candle section): no on-canvas legend / badges —
   * the OHLC legend lives in a strip OUTSIDE the chart (user request) */
  bare?: boolean;
}

interface PendingCreate {
  kind: ToolId;
  a1?: { x: number; y: number; t: number; p: number };
  /** the triangle tool's SECOND anchor (3-anchor creation) */
  a2?: { x: number; y: number; t: number; p: number };
  move?: { x: number; y: number; t: number; p: number };
}

export default function TradingChart(props: Props) {
  const {
    symbol, timeframe, digits, layers, tool, onToolDone,
    board, signals, selectedSignalId,
    userDrawings, onCreateDrawing, onUpdateDrawing, onDeleteDrawing,
    bare = false,
  } = props;

  const { resolvedTheme } = useTheme();
  const bars = useBars(symbol, timeframe);
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const barsRef = useRef<Candle[]>(bars);
  const userRef = useRef(userDrawings);
  const layersRef = useRef(layers);
  const signalsRef = useRef(signals);
  const toolRef = useRef(tool);
  const bareRef = useRef(bare);
  useEffect(() => { bareRef.current = bare; }, [bare]);
  // AI live chart-read (S/R + value area magnets from the trading brain) —
  // v20: reactive state so the ink plan recomputes when the read lands

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingCreate | null>(null);
  const measureRef = useRef<PendingCreate | null>(null);
  const dragRef = useRef<{
    id: string;
    anchorIdx: number | null;
    last: { t: number; p: number };
    orig: UserDrawing["points"];
  } | null>(null);
  const [textDialog, setTextDialog] = useState<{ t: number; p: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const hitRef = useRef<Map<string, { pts: { x: number; y: number }[]; rects: { x1: number; y1: number; x2: number; y2: number }[] }>>(new Map());
  const drawOverlayRef = useRef<() => void>(() => {});
  // free-zoom follow mode (auto-follow the live right edge)
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);

  const tfSec = TF_SEC[timeframe] ?? 900;

  const scheduleRedraw = useCallback(() => {
    requestAnimationFrame(() => drawOverlayRef.current());
  }, []);

  // ═══════════════ 0. THE CLEAN INK (v21: less ink, more meaning) ═══════════════
  // Swing structure + the 2 key levels are computed client-side from the
  // bars on the chart; the decision ink comes from the AI Board. Nothing
  // else draws — the chart stays readable at a glance.
  const cleanInk = useMemo(
    () => buildCleanInk(bars, timeframe, board),
    [bars, timeframe, board],
  );
  const cleanRef = useRef(cleanInk);
  const boardRef = useRef(board);

  // ═══════════════ 1. chart lifecycle ═══════════════
  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      layout: {
        background: { type: ColorType.Solid, color: THEMES.dark.bg },
        textColor: THEMES.dark.text,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: THEMES.dark.grid },
        horzLines: { color: THEMES.dark.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: THEMES.dark.crosshair, labelBackgroundColor: "#2a3830", width: 1, style: LineStyle.Solid },
        horzLine: { color: THEMES.dark.crosshair, labelBackgroundColor: "#2a3830", width: 1, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: THEMES.dark.border, scaleMargins: { top: 0.08, bottom: 0.14 } },
      timeScale: {
        borderColor: THEMES.dark.border,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 7,
        rightOffset: 8,
        minBarSpacing: 0.8,
        shiftVisibleRangeOnNewBar: true,
      },
      autoSize: true,
      // FREE zoom & pan: wheel/pinch zoom, drag pan on BOTH axes, axis drag
      // rescales, double-click an axis to reset it
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true, pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });
    const series = chart.addCandlestickSeries({
      upColor: THEMES.dark.up, downColor: THEMES.dark.down,
      borderUpColor: THEMES.dark.up, borderDownColor: THEMES.dark.down,
      wickUpColor: THEMES.dark.wickUp, wickDownColor: THEMES.dark.wickDown,
      priceLineColor: "#f59e0b",
      priceLineStyle: LineStyle.Dotted,
      priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits },
    });
    const vol = chart.addHistogramSeries({
      priceScaleId: "",
      color: "rgba(120,130,125,0.22)",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;

    // overlay redraw triggers
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; drawOverlayRef.current(); });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const resizeObs = new ResizeObserver(schedule);
    resizeObs.observe(host);
    const priceSync = setInterval(schedule, 500);
    (host as any).__cleanup = () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      resizeObs.disconnect();
      clearInterval(priceSync);
      if (raf) cancelAnimationFrame(raf);
    };

    return () => {
      (host as any).__cleanup?.();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
    };

  }, []);

  // theme switch
  useEffect(() => {
    const th = resolvedTheme === "light" ? THEMES.light : THEMES.dark;
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: th.bg }, textColor: th.text },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      crosshair: {
        vertLine: { color: th.crosshair },
        horzLine: { color: th.crosshair },
      },
      rightPriceScale: { borderColor: th.border },
      timeScale: { borderColor: th.border },
    });
    seriesRef.current?.applyOptions({
      upColor: th.up, downColor: th.down,
      borderUpColor: th.up, borderDownColor: th.down,
      wickUpColor: th.wickUp, wickDownColor: th.wickDown,
    });
    scheduleRedraw();

  }, [resolvedTheme]);

  // symbol/precision switch
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits },
    });
  }, [digits]);

  // ═══════════════ 2. data loading (symbol/tf switch) ═══════════════
  const appliedMetaRef = useRef<{ firstT: number; len: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const prevRange = chartRef.current?.timeScale().getVisibleLogicalRange() ?? null;
    const prevBars = barsRef.current;

    feed.getCandles(symbol, timeframe, 900).then((nextBars) => {
      if (cancelled || !seriesRef.current || !volRef.current) return;
      const clean = sanitize(nextBars);
      seriesRef.current.setData(clean.map(barToLw));
      volRef.current.setData(
        clean.map((b) => ({
          time: b.t as UTCTimestamp,
          value: b.v,
          color: b.c >= b.o ? THEMES.dark.volUp : THEMES.dark.volDown,
        })),
      );
      appliedMetaRef.current = clean.length
        ? { firstT: clean[0].t, len: clean.length }
        : null;
      applyPreservedRange(chartRef.current, prevRange, prevBars, clean);
      displayRef.current = null;
      scheduleRedraw();
    }).catch(() => {});

    feed.subscribeBars(symbol, timeframe);
    return () => {
      cancelled = true;
      feed.unsubscribeBars(symbol, timeframe);
    };

  }, [symbol, timeframe]);

  // ═══════════════ 3. incremental bar sync ═══════════════
  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    if (!series || !vol || !bars.length) return;
    const meta = appliedMetaRef.current;
    const structChange =
      !meta ||
      bars[0].t !== meta.firstT ||
      bars.length < meta.len ||
      bars.length > meta.len + 3;
    if (structChange) {
      const clean = sanitize(bars);
      series.setData(clean.map(barToLw));
      vol.setData(
        clean.map((b) => ({
          time: b.t as UTCTimestamp,
          value: b.v,
          color: b.c >= b.o ? THEMES.dark.volUp : THEMES.dark.volDown,
        })),
      );
      appliedMetaRef.current = { firstT: clean[0]?.t ?? 0, len: clean.length };
    } else if (bars.length > meta.len) {
      const b = bars[bars.length - 1];
      series.update(barToLw(b));
      vol.update({
        time: b.t as UTCTimestamp,
        value: b.v,
        color: b.c >= b.o ? THEMES.dark.volUp : THEMES.dark.volDown,
      });
      appliedMetaRef.current = { firstT: meta.firstT, len: bars.length };
    }
    // volume colors drift on direction flips — refresh the last bar's volume color
    if (!structChange) {
      const b = bars[bars.length - 1];
      vol.update({
        time: b.t as UTCTimestamp,
        value: b.v,
        color: b.c >= b.o ? THEMES.dark.volUp : THEMES.dark.volDown,
      });
    }
    scheduleRedraw();

  }, [bars]);

  // ═══════════════ 4. rAF easing loop (single writer of last bar) ═══════════════
  const displayRef = useRef<Candle | null>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const series = seriesRef.current;
      const vol = volRef.current;
      const bs = barsRef.current;
      if (!series || !vol || !bs.length) return;
      const last = bs[bs.length - 1];
      // live tick refinement (forming bar only)
      const q = feed.getQuoteSnapshot(symbol);
      let target: Candle = { ...last };
      if (last.f && q && q.ts >= last.t) {
        target.c = q.mid;
        target.h = Math.max(target.h, q.mid);
        target.l = Math.min(target.l, q.mid);
      }
      const disp = displayRef.current;
      if (!disp || disp.t !== target.t) {
        displayRef.current = { ...target };
        series.update(barToLw(target));
        vol.update(volToLw(target));
        return;
      }
      const dc = target.c - disp.c;
      if (Math.abs(dc) < 1e-9) {
        if (disp.h !== target.h || disp.l !== target.l || disp.c !== target.c) {
          displayRef.current = { ...target };
          series.update(barToLw(target));
          vol.update(volToLw(target));
        }
        return;
      }
      disp.c += dc * EASE;
      disp.h = Math.max(disp.h, target.h, disp.c);
      disp.l = Math.min(disp.l, target.l, disp.c);
      series.update(barToLw(disp));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);

  }, [symbol]);

  // ═══════════════ 5. signal markers + selected signal price lines ═══════════════
  const priceLinesRef = useRef<any[]>([]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const markers: SeriesMarker<Time>[] = signals
      .filter((s) => s.barTime)
      .slice(-40)
      .map((s): SeriesMarker<Time> => ({
        time: s.barTime as UTCTimestamp,
        position: s.direction === "BUY" ? "belowBar" : "aboveBar",
        color: s.direction === "BUY" ? "#10b981" : "#f43f5e",
        shape: s.direction === "BUY" ? "arrowUp" : "arrowDown",
        text: `${s.direction === "BUY" ? "B" : "S"}·${(s.confidence * 100).toFixed(0)}%`,
        size: 1,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    if (layersRef.current.signals) series.setMarkers(markers);
    else series.setMarkers([]);
  }, [signals, layers.signals]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const pl of priceLinesRef.current) {
      try { series.removePriceLine(pl); } catch {}
    }
    priceLinesRef.current = [];
    const sig = signals.find((s) => s.id === selectedSignalId);
    if (sig) {
      priceLinesRef.current = [
        series.createPriceLine({ price: sig.entry, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${sig.direction} ENTRY` }),
        series.createPriceLine({ price: sig.sl, color: "#f43f5e", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL" }),
        series.createPriceLine({ price: sig.tp, color: "#10b981", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP" }),
      ];
      return;
    }
    // the AI Board decision's numbers on the price scale itself (axis
    // tags, TradingView-style) — entry / SL / TP always readable
    if (!layers.setup) return;
    const d = board?.decision;
    if (!d || d.action === "HOLD" || d.entry == null) return;
    const mk = (price: number, color: string, title: string, dash: LineStyle) =>
      series.createPriceLine({
        price, color, lineWidth: 1, lineStyle: dash,
        axisLabelVisible: true, lineVisible: false, title,
      });
    const lines: any[] = [mk(d.entry, "#d4af37", `${d.action} ENTRY`, LineStyle.Dotted)];
    if (d.sl != null) lines.push(mk(d.sl, "#f87171", "SL", LineStyle.Dashed));
    if (d.tp != null) lines.push(mk(d.tp, "#34d399", "TP", LineStyle.Dashed));
    priceLinesRef.current = lines;
  }, [selectedSignalId, signals, board, layers.setup]);

  // ═══════════════ 6. EMA ribbon (computed on bars) ═══════════════
  const emaArrays = useMemo(() => {
    const bs = bars;
    return {
      e9: emaSeries(bs, 9),
      e21: emaSeries(bs, 21),
      e50: emaSeries(bs, 50),
    };
  }, [bars]);
  const emaRef = useRef(emaArrays);

  // post-render ref sync (compiler-safe: refs updated only in effects)
  useEffect(() => {
    barsRef.current = bars;
    userRef.current = userDrawings;
    layersRef.current = layers;
    signalsRef.current = signals;
    toolRef.current = tool;
    selectedRef.current = selectedId;
    emaRef.current = emaArrays;
    cleanRef.current = cleanInk;
    boardRef.current = board;
  });

  // volume layer visibility (histogram series toggle)
  useEffect(() => {
    volRef.current?.applyOptions({ visible: layers.volume });
  }, [layers.volume]);

  // ═══════════════ 7. THE OVERLAY (v20: plan-driven, clean) ═══════════════

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const host = chartHostRef.current;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 10 || h < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const needW = Math.round(w * dpr);
    const needH = Math.round(h * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bs = barsRef.current;
    if (!bs.length) return;
    const ts = chart.timeScale();
    const tf = tfSec;
    const axisW = chart.priceScale("right").width() ?? 56;
    const rightEdge = Math.max(60, w - axisW - 2);
    const lastTime = bs[bs.length - 1].t;
    const barSpacing = ts.options().barSpacing ?? 6.5;

    const xOfTime = (t: number): number | null => {
      const x = ts.timeToCoordinate(t as UTCTimestamp);
      if (x !== null) return x;
      // off-window times resolve through the BAR GRID (logical coordinates),
      // never blind barSpacing arithmetic — the old linear extrapolation
      // ignored session/weekend gaps and drew break-lines from wrong
      // endpoints. Older than the loaded data clamps to the first bar.
      if (bs.length) {
        const idx = bs.findIndex((b) => b.t >= t);
        if (idx > 0) {
          const prev = bs[idx - 1];
          const frac = (t - prev.t) / Math.max(1e-9, bs[idx].t - prev.t);
          const lc = ts.logicalToCoordinate((idx - 1 + frac) as Logical);
          if (lc != null) return lc;
        }
        if (t <= bs[0].t) {
          const lc0 = ts.logicalToCoordinate(0 as Logical);
          if (lc0 != null) return lc0;
        }
      }
      const xLast = ts.timeToCoordinate(lastTime as UTCTimestamp);
      if (xLast === null) return null;
      return xLast + ((t - lastTime) / tf) * barSpacing;
    };
    const yOfPrice = (p: number): number | null => series.priceToCoordinate(p) ?? null;

    hitRef.current.clear();
    const isDark = resolvedTheme !== "light";

    try {
      // ── kill-zone session bands (under everything) ──
      if (layersRef.current.killzones && tf <= 3600) {
        const vr = ts.getVisibleRange();
        if (vr) {
          const bands: { name: string; s: number; e: number; gold: boolean }[] = [
            { name: "ASIA", s: 0, e: 6, gold: false },
            { name: "LONDON", s: 7, e: 10, gold: true },
            // ICT kill zones on the UTC clock — NY·AM = 09:30–11:00 EST =
            // 14:30–16:00 UTC; NY·PM = 13:30–16:00 EST = 18:30–21:00 UTC
            { name: "NY·AM", s: 14.5, e: 16, gold: true },
            { name: "NY·PM", s: 18.5, e: 21, gold: false },
          ];
          const dayStart = Math.floor((vr.from as number) / 86400) * 86400 - 86400;
          for (let d = dayStart; d < (vr.to as number) + 86400; d += 86400) {
            for (const b of bands) {
              const t1 = d + b.s * 3600;
              const t2 = d + b.e * 3600;
              const x1 = xOfTime(t1);
              const x2 = xOfTime(t2);
              if (x1 === null || x2 === null || x2 < 0 || x1 > rightEdge) continue;
              const cx1 = clamp(x1, -2, rightEdge);
              const cx2 = clamp(x2, -2, rightEdge);
              ctx.fillStyle = b.gold ? "rgba(245,158,11,0.026)" : "rgba(130,145,138,0.020)";
              ctx.fillRect(cx1, 0, cx2 - cx1, h);
              ctx.strokeStyle = b.gold ? "rgba(245,158,11,0.30)" : "rgba(130,145,138,0.25)";
              ctx.lineWidth = 0.5;
              ctx.beginPath();
              ctx.moveTo(cx1 + 0.25, 0);
              ctx.lineTo(cx1 + 0.25, h);
              ctx.stroke();
              hardText(ctx, b.name, (cx1 + cx2) / 2, 8, b.gold ? "rgba(245,158,11,0.5)" : "rgba(148,163,158,0.45)", 7, "center");
            }
          }
        }
      }

      // ── THE CLEAN INK — one draw call: decision + structure + 2 levels ──
      renderClean(
        cleanRef.current,
        {
          ctx, w, h, rightEdge,
          digits, isDark,
          xOfTime, yOfPrice,
          chart,
        },
        layersRef.current,
      );

      // ── EMA ribbon ──
      if (layersRef.current.ema) {
        // the forming candle's LIVE close drives the last EMA point — the
        // ribbon used the last socket-bar close and visibly lagged the tick
        const liveC = bs[bs.length - 1]?.f && displayRef.current ? displayRef.current.c : null;
        const drawEma = (vals: (number | null)[], color: string, width: number, period: number) => {
          ctx.save();
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < bs.length; i++) {
            let v = vals[i];
            if (v == null) continue;
            if (liveC != null && i === bs.length - 1 && i > 0 && vals[i - 1] != null) {
              const k = 2 / (period + 1);
              v = liveC * k + (vals[i - 1] as number) * (1 - k);
            }
            const x = ts.timeToCoordinate(bs[i].t as UTCTimestamp);
            const y = yOfPrice(v);
            if (x === null || y === null) continue;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.stroke();
          ctx.restore();
        };
        drawEma(emaRef.current.e9, "rgba(52,211,153,0.55)", 0.7, 9);
        drawEma(emaRef.current.e21, "rgba(245,158,11,0.55)", 0.6, 21);
        drawEma(emaRef.current.e50, "rgba(148,163,158,0.5)", 0.6, 50);
      }

      // ── user drawings ──
      for (const ud of userRef.current) {
        const selected = ud.id === selectedRef.current;
        const color = selected ? "rgba(245,158,11,0.95)" : "rgba(226,232,230,0.78)";
        const pts = ud.points.map((p) => ({ x: xOfTime(p.t), y: yOfPrice(p.p), t: p.t, p: p.p }));
        const hit = { pts: [] as { x: number; y: number }[], rects: [] as any[] };
        switch (ud.kind) {
          case "trendline":
          case "ray": {
            if (pts.length < 2 || pts[0].x === null || pts[0].y === null || pts[1].x === null || pts[1].y === null) break;
            if (ud.kind === "ray") {
              const dx = pts[1].x! - pts[0].x!;
              const dy = pts[1].y! - pts[0].y!;
              let ex: number, ey: number;
              if (Math.abs(dx) < 2) {
                ex = pts[0].x!;
                ey = dy > 0 ? h : 0;
              } else if (dx > 0) {
                ex = rightEdge;
                ey = pts[0].y! + (dy / dx) * (rightEdge - pts[0].x!);
              } else {
                ex = 0;
                ey = pts[0].y! + (dy / dx) * (0 - pts[0].x!);
              }
              seg(ctx, pts[0].x!, pts[0].y!, ex, ey, color);
              seg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color);
            } else {
              seg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color);
            }
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            break;
          }
          case "hline": {
            if (pts.length < 1 || pts[0].y === null) break;
            const y = pts[0].y!;
            seg(ctx, 0, y, rightEdge, y, color);
            hardText(ctx, `${pts[0].p.toFixed(digits)}`, rightEdge - 4, y - 7, color, 8, "right");
            hit.pts.push({ x: 80, y });
            hit.rects.push({ x1: 0, y1: y - 5, x2: rightEdge, y2: y + 5 });
            break;
          }
          case "vline": {
            if (pts.length < 1 || pts[0].x === null) break;
            const x = pts[0].x!;
            seg(ctx, x, 0, x, h, color);
            hit.pts.push({ x, y: 60 });
            hit.rects.push({ x1: x - 5, y1: 0, x2: x + 5, y2: h });
            break;
          }
          case "rect":
          case "measure": {
            if (pts.length < 2 || pts[0].x === null || pts[0].y === null || pts[1].x === null || pts[1].y === null) break;
            const rx = Math.min(pts[0].x!, pts[1].x!);
            const ry = Math.min(pts[0].y!, pts[1].y!);
            const rw = Math.abs(pts[1].x! - pts[0].x!);
            const rh = Math.abs(pts[1].y! - pts[0].y!);
            ctx.fillStyle = ud.kind === "measure" ? "rgba(245,158,11,0.07)" : "rgba(226,232,230,0.05)";
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.7;
            ctx.strokeRect(rx, ry, rw, rh);
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            hit.rects.push({ x1: rx, y1: ry, x2: rx + rw, y2: ry + rh });
            break;
          }
          case "triangle": {
            if (pts.length < 3 || pts.some((p) => p.x === null || p.y === null)) break;
            const [t1, t2, t3] = pts;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(t1.x!, t1.y!);
            ctx.lineTo(t2.x!, t2.y!);
            ctx.lineTo(t3.x!, t3.y!);
            ctx.closePath();
            ctx.fillStyle = "rgba(226,232,230,0.05)";
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.7;
            ctx.stroke();
            ctx.restore();
            hit.pts.push({ x: t1.x!, y: t1.y! }, { x: t2.x!, y: t2.y! }, { x: t3.x!, y: t3.y! });
            hit.rects.push({
              x1: Math.min(t1.x!, t2.x!, t3.x!),
              y1: Math.min(t1.y!, t2.y!, t3.y!),
              x2: Math.max(t1.x!, t2.x!, t3.x!),
              y2: Math.max(t1.y!, t2.y!, t3.y!),
            });
            break;
          }
          case "fib": {
            if (pts.length < 2 || pts[0].x === null || pts[0].y === null || pts[1].x === null || pts[1].y === null) break;
            const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
            const p0 = ud.points[0].p, p1 = ud.points[1].p;
            for (const r of ratios) {
              const price = p0 + (p1 - p0) * r;
              const y = yOfPrice(price);
              if (y === null) continue;
              const golden = r === 0.618 || r === 0.786;
              seg(ctx, Math.min(pts[0].x!, pts[1].x!), y, rightEdge, y,
                golden ? "rgba(245,158,11,0.8)" : "rgba(226,232,230,0.4)");
              hardText(ctx, `${r.toFixed(3)}  ${price.toFixed(digits)}`, rightEdge - 4, y - 7,
                golden ? "rgba(251,191,36,0.9)" : "rgba(178,190,185,0.7)", 8, "right");
            }
            seg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, "rgba(226,232,230,0.5)");
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            break;
          }
          case "text": {
            if (pts.length < 1 || pts[0].x === null || pts[0].y === null) break;
            hardText(ctx, ud.style.text || "…", pts[0].x!, pts[0].y!, color, 10, "left", 600);
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! });
            hit.rects.push({ x1: pts[0].x! - 4, y1: pts[0].y! - 8, x2: pts[0].x! + 90, y2: pts[0].y! + 8 });
            break;
          }
        }
        // selection handles
        if (selected) {
          for (const p of hit.pts) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
            ctx.fillStyle = "#f59e0b";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.5)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
          }
        }
        hitRef.current.set(ud.id, hit);
      }

      // ── creation preview ──
      const preview = pendingRef.current ?? measureRef.current;
      if (preview?.a1 && preview.move) {
        const { a1, move } = preview;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(245,158,11,0.8)";
        ctx.lineWidth = 0.9;
        if (preview.kind === "triangle" && preview.a2) {
          ctx.beginPath();
          ctx.moveTo(a1.x, a1.y);
          ctx.lineTo(preview.a2.x, preview.a2.y);
          ctx.lineTo(move.x, move.y);
          ctx.closePath();
          ctx.fillStyle = "rgba(245,158,11,0.06)";
          ctx.fill();
          ctx.stroke();
        } else if (preview.kind === "trendline" || preview.kind === "ray" || preview.kind === "fib" || preview.kind === "measure") {
          ctx.beginPath();
          ctx.moveTo(a1.x, a1.y);
          ctx.lineTo(move.x, move.y);
          ctx.stroke();
        } else if (preview.kind === "rect") {
          ctx.strokeRect(Math.min(a1.x, move.x), Math.min(a1.y, move.y), Math.abs(move.x - a1.x), Math.abs(move.y - a1.y));
        } else if (preview.kind === "hline") {
          ctx.beginPath();
          ctx.moveTo(0, move.y);
          ctx.lineTo(rightEdge, move.y);
          ctx.stroke();
        } else if (preview.kind === "vline") {
          ctx.beginPath();
          ctx.moveTo(move.x, 0);
          ctx.lineTo(move.x, h);
          ctx.stroke();
        }
        ctx.restore();
        // anchor crosshair
        ctx.save();
        ctx.strokeStyle = "rgba(245,158,11,0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a1.x - 5, a1.y);
        ctx.lineTo(a1.x + 5, a1.y);
        ctx.moveTo(a1.x, a1.y - 5);
        ctx.lineTo(a1.x, a1.y + 5);
        ctx.stroke();
        ctx.restore();
        if (preview.kind === "measure") {
          const dp = move.p - a1.p;
          const pct = (dp / a1.p) * 100;
          const barsN = Math.round((move.t - a1.t) / tf);
          hardText(
            ctx,
            `${dp >= 0 ? "+" : ""}${dp.toFixed(digits)} (${pct.toFixed(2)}%) · ${Math.abs(barsN)} bars`,
            (a1.x + move.x) / 2, Math.min(a1.y, move.y) - 10,
            dp >= 0 ? "rgba(110,231,183,0.95)" : "rgba(252,165,165,0.95)", 9, "center",
          );
        }
      }

      // ── crosshair legend (fixed px, direct on canvas) — BARE mode skips it:
      //    the trio renders its OHLC legend in a strip OUTSIDE the chart ──
      if (!bareRef.current) {
      const q = feed.getQuoteSnapshot(symbol);
      let li = bs.length - 1;
      const cross = crosshairRef.current;
      if (cross != null && cross.t != null) {
        const idx = bs.findIndex((b) => b.t === cross.t);
        if (idx >= 0) li = idx;
      }
      const lb = bs[li];
      const prev = li > 0 ? bs[li - 1] : null;
      const up = lb.c >= lb.o;
      const col = (v: number) => (up ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)");
      const chg = prev ? lb.c - prev.c : 0;
      const chgPct = prev ? (chg / prev.c) * 100 : 0;
      let lx = 8;
      const ly = 14;
      hardText(ctx, `${symbol} · ${timeframe}`, lx, ly, isDark ? "rgba(226,232,230,0.95)" : "rgba(41,52,47,0.95)", 10, "left", 700);
      lx += ctx.measureText(`${symbol} · ${timeframe}`).width + 26;
      const parts: [string, string][] = [
        ["O", lb.o.toFixed(digits)], ["H", lb.h.toFixed(digits)],
        ["L", lb.l.toFixed(digits)], ["C", lb.c.toFixed(digits)],
      ];
      ctx.font = `700 10px monospace`;
      for (const [k, v] of parts) {
        hardText(ctx, k, lx, ly, "rgba(148,163,158,0.8)", 8.5, "left");
        const kw = ctx.measureText(k).width;
        hardText(ctx, v, lx + kw + 4, ly, col(1), 9, "left");
        lx += kw + 4 + ctx.measureText(v).width + 12;
      }
      const chgTxt = `${chg >= 0 ? "+" : ""}${chg.toFixed(digits)} (${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%)`;
      hardText(ctx, chgTxt, lx, ly, chg >= 0 ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)", 9, "left");
      lx += ctx.measureText(chgTxt).width + 14;
      hardText(ctx, `VOL ${fmtCompact(lb.v)}`, lx, ly, "rgba(148,163,158,0.8)", 8.5, "left");
      if (q) {
        lx += ctx.measureText(`VOL ${fmtCompact(lb.v)}`).width + 14;
        hardText(ctx, `SPR ${(q.ask - q.bid).toFixed(digits)}`, lx, ly, "rgba(148,163,158,0.7)", 8.5, "left");
      }

      // ── RUNNING forming-bar badge (buyer vs seller pressure) ──
      const rng = lb.h - lb.l;
      if (rng > 0) {
        const delta = ((lb.c - lb.l) / rng) * 2 - 1;
        const buyPct = ((delta + 1) / 2) * 100;
        const bw = 90;
        const bx = 8;
        const by = 26;
        ctx.fillStyle = "rgba(248,113,113,0.5)";
        ctx.fillRect(bx, by, bw, 3);
        ctx.fillStyle = "rgba(52,211,153,0.75)";
        ctx.fillRect(bx, by, (bw * buyPct) / 100, 3);
        const label = buyPct >= 60 ? `RUNNING · BUYERS ${buyPct.toFixed(0)}%`
          : buyPct <= 40 ? `RUNNING · SELLERS ${(100 - buyPct).toFixed(0)}%`
          : `RUNNING · EVEN ${buyPct.toFixed(0)}%`;
        hardText(ctx, label, bx + bw + 8, by + 2, "rgba(178,190,185,0.75)", 7.5, "left", 600);
      }
      }
    } catch (err) {
      // an overlay error must never blank the candles
      console.warn("[chart] overlay draw failed:", err);
    }
  }, [symbol, timeframe, digits, tfSec, resolvedTheme, t]);

  useEffect(() => {
    drawOverlayRef.current = drawOverlay;
  }, [drawOverlay]);

  useEffect(() => {
    scheduleRedraw();
    // ink plan / filter changes re-render the same plumbing — an immediate
    // repaint, no data refetch
  }, [bars, userDrawings, layers, cleanInk, board, selectedId, signals, emaArrays, symbol, timeframe, drawOverlay, scheduleRedraw]);

  // crosshair tracking (for legend) — via ref, no re-render
  const crosshairRef = useRef<{ t: number | null }>({ t: null });
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: any) => {
      crosshairRef.current.t = param?.time ?? null;
      drawOverlayRef.current();
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, []);

  // ═══════════════ 7b. FREE ZOOM — controls, follow mode, keyboard ═══════════════
  const zoomBy = useCallback((factor: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    const center = (range.from + range.to) / 2;
    const nextSpan = Math.max(6, Math.min(1200, span * factor));
    ts.setVisibleLogicalRange({
      from: center - nextSpan / 2,
      to: center + nextSpan / 2,
    });
  }, []);

  const fitContent = useCallback(() => {
    chartRef.current?.timeScale().fitContent();
  }, []);

  const goLive = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const bs = barsRef.current;
    if (!bs.length) return;
    const span = 95;
    ts.setVisibleLogicalRange({ from: Math.max(0, bs.length - span), to: bs.length + RIGHT_PAD });
    ts.applyOptions({ shiftVisibleRangeOnNewBar: true });
    setFollow(true);
    followRef.current = true;
  }, []);

  // follow sync: panning away from the right edge turns follow off;
  // zooming/panning back to the edge (or pressing ⟶) turns it on
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range || !barsRef.current.length) return;
      const atEdge = range.to >= barsRef.current.length - 1 - FOLLOW_SLACK_BARS;
      if (atEdge !== followRef.current) {
        followRef.current = atEdge;
        setFollow(atEdge);
        ts.applyOptions({ shiftVisibleRangeOnNewBar: atEdge });
      }
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
  }, []);

  // keyboard zoom shortcuts: + / - / 0 / f
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (selectedRef.current) return; // don't hijack drawing delete keys
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(0.78); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1.28); }
      else if (e.key === "0") { e.preventDefault(); fitContent(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); goLive(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, fitContent, goLive]);

  // ═══════════════ 8. pointer interactions ═══════════════
  const toTimePrice = useCallback((e: PointerEvent | MouseEvent): { t: number; p: number; x: number; y: number } | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const canvas = canvasRef.current;
    if (!chart || !series || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ts = chart.timeScale();
    const bs = barsRef.current;
    if (!bs.length) return null;
    const lastTime = bs[bs.length - 1].t;
    const barSpacing = ts.options().barSpacing ?? 6.5;
    let t = ts.coordinateToTime(x) as number | null;
    if (t == null) {
      const xLast = ts.timeToCoordinate(lastTime as UTCTimestamp);
      if (xLast == null) return null;
      t = lastTime + ((x - xLast) / barSpacing) * tfSec;
    }
    const p = series.coordinateToPrice(y);
    if (p == null) return null;
    return { t, p, x, y };
  }, [tfSec]);

  const hitTestUser = useCallback((x: number, y: number): { id: string; anchor: number | null } | null => {
    for (const [id, hit] of hitRef.current) {
      for (let i = 0; i < hit.pts.length; i++) {
        if (Math.hypot(hit.pts[i].x - x, hit.pts[i].y - y) < 9) return { id, anchor: i };
      }
      for (const r of hit.rects) {
        if (x >= r.x1 - 3 && x <= r.x2 + 3 && y >= r.y1 - 3 && y <= r.y2 + 3) return { id, anchor: null };
      }
      // segment hit for line-ish drawings without rects
      if (hit.pts.length === 2 && !hit.rects.length) {
        const d = distToSeg(x, y, hit.pts[0].x, hit.pts[0].y, hit.pts[1].x, hit.pts[1].y);
        if (d < 7) return { id, anchor: null };
      }
    }
    return null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = chartHostRef.current;
    if (!canvas || !host) return;

    const setPe = (v: "auto" | "none") => {
      if (canvas.style.pointerEvents !== v) canvas.style.pointerEvents = v;
    };
    setPe(tool !== "cursor" ? "auto" : "none");

    const onDown = (e: PointerEvent) => {
      const tp = toTimePrice(e);
      if (!tp) return;
      const currentTool = toolRef.current;

      // any click clears a frozen measure
      if (measureRef.current && currentTool === "cursor") {
        measureRef.current = null;
        drawOverlayRef.current();
      }

      if (currentTool !== "cursor") {
        // the triangle tool is THREE-anchor: first tap = vertex 1,
        // second tap = vertex 2, third tap closes the shape and persists it
        if (currentTool === "triangle") {
          if (!pendingRef.current?.a1) {
            pendingRef.current = { kind: "triangle", a1: tp };
          } else if (!pendingRef.current.a2) {
            pendingRef.current.a2 = tp;
          } else {
            const { a1, a2 } = pendingRef.current;
            onCreateDrawing({
              symbol, timeframe, kind: "triangle",
              points: [{ t: a1!.t, p: a1!.p }, { t: a2!.t, p: a2!.p }, { t: tp.t, p: tp.p }],
              style: {},
            });
            pendingRef.current = null;
            onToolDone();
          }
          drawOverlayRef.current();
          return;
        }
        const twoAnchor = ["trendline", "ray", "rect", "fib", "measure"].includes(currentTool);
        if (currentTool === "measure") {
          if (!pendingRef.current?.a1) {
            pendingRef.current = { kind: "measure", a1: tp };
          } else {
            pendingRef.current.move = tp;
            measureRef.current = pendingRef.current; // frozen until next click
            pendingRef.current = null;
            onToolDone();
          }
          drawOverlayRef.current();
          return;
        }
        if (currentTool === "text") {
          setTextDialog({ t: tp.t, p: tp.p });
          onToolDone();
          return;
        }
        if (!twoAnchor) {
          // single anchor: hline / vline
          onCreateDrawing({
            symbol, timeframe, kind: currentTool as any,
            points: [{ t: tp.t, p: tp.p }],
            style: {},
          });
          onToolDone();
          return;
        }
        if (!pendingRef.current?.a1) {
          pendingRef.current = { kind: currentTool, a1: tp };
        } else {
          const a1 = pendingRef.current.a1!;
          onCreateDrawing({
            symbol, timeframe, kind: currentTool as any,
            points: [{ t: a1.t, p: a1.p }, { t: tp.t, p: tp.p }],
            style: {},
          });
          pendingRef.current = null;
          onToolDone();
        }
        drawOverlayRef.current();
        return;
      }

      // cursor mode → select / drag
      const hit = hitTestUser(tp.x, tp.y);
      if (hit) {
        setSelectedId(hit.id);
        const ud = userRef.current.find((d) => d.id === hit.id);
        if (ud) {
          dragRef.current = {
            id: hit.id,
            anchorIdx: hit.anchor,
            last: { t: tp.t, p: tp.p },
            orig: ud.points.map((p) => ({ ...p })),
          };
        }
        canvas.setPointerCapture(e.pointerId);
      } else {
        setSelectedId(null);
      }
      drawOverlayRef.current();
    };

    const onMove = (e: PointerEvent) => {
      const tp = toTimePrice(e);
      if (!tp) return;
      if (pendingRef.current?.a1) {
        pendingRef.current.move = tp;
        drawOverlayRef.current();
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        const ud = userRef.current.find((d) => d.id === drag.id);
        if (!ud) { dragRef.current = null; return; }
        const dT = tp.t - drag.last.t;
        const dP = tp.p - drag.last.p;
        const pts = ud.points.map((p, i) =>
          drag.anchorIdx == null || i === drag.anchorIdx
            ? { t: p.t + dT, p: p.p + dP }
            : p,
        );
        ud.points = pts;
        drag.last = { t: tp.t, p: tp.p };
        drawOverlayRef.current();
        return;
      }
      // hover feedback
      const hit = hitTestUser(tp.x, tp.y);
      canvas.style.cursor = hit ? "move" : "";
      if (toolRef.current === "cursor") setPe(hit ? "auto" : "none");
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (drag) {
        const ud = userRef.current.find((d) => d.id === drag.id);
        if (ud) onUpdateDrawing(drag.id, ud.points, ud.style);
        dragRef.current = null;
      }
    };

    const onLeave = () => {
      if (pendingRef.current?.a1 && pendingRef.current.move) pendingRef.current.move = undefined;
      drawOverlayRef.current();
    };

    // container-level hover routing (chart canvases bubble here)
    const onContainerMove = (e: MouseEvent) => {
      if (toolRef.current !== "cursor" || dragRef.current) return;
      const tp = toTimePrice(e);
      if (!tp) return;
      const hit = hitTestUser(tp.x, tp.y);
      setPe(hit ? "auto" : "none");
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    host.addEventListener("mousemove", onContainerMove);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("mousemove", onContainerMove);
    };
  }, [tool, symbol, timeframe, digits, toTimePrice, hitTestUser, onCreateDrawing, onUpdateDrawing, onToolDone]);

  // keyboard delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        onDeleteDrawing(selectedRef.current);
        setSelectedId(null);
      }
      if (e.key === "Escape") {
        pendingRef.current = null;
        measureRef.current = null;
        setSelectedId(null);
        onToolDone();
        drawOverlayRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDeleteDrawing, onToolDone]);

  // tool changes reset pending
  useEffect(() => {
    pendingRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.pointerEvents = tool !== "cursor" ? "auto" : "none";
      canvas.style.cursor = tool !== "cursor" ? "crosshair" : "";
    }
  }, [tool]);

  return (
    <div ref={containerRef} className="relative h-full w-full no-select">
      <div ref={chartHostRef} className="absolute inset-0" />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        style={{ touchAction: "none" }}
      />

      {/* candle-loading state — shown until the first bars arrive */}
      {!bars.length && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/60 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-xs font-semibold">{t("loadingCandles")}</span>
          </div>
          <div className="flex h-16 w-52 flex-col justify-end gap-1 opacity-40" aria-hidden>
            {[0.5, 0.8, 0.35, 0.65].map((h, i) => (
              <div key={i} className="animate-pulse rounded-sm bg-muted-foreground/30" style={{ height: `${h * 100}%`, width: "12%", marginLeft: `${i * 12}%`, animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        </div>
      )}

      {/* FREE ZOOM control cluster — bottom-right, above the price axis */}
      <div className="absolute bottom-10 right-20 z-20 flex flex-col gap-1 sm:right-24">
        <button
          onClick={() => zoomBy(0.78)}
          aria-label={t("zoomIn")}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/85 text-muted-foreground shadow-sm backdrop-blur transition-all hover:border-gold/50 hover:text-gold active:scale-95"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => zoomBy(1.28)}
          aria-label={t("zoomOut")}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/85 text-muted-foreground shadow-sm backdrop-blur transition-all hover:border-gold/50 hover:text-gold active:scale-95"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={fitContent}
          aria-label={t("zoomFit")}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/85 text-muted-foreground shadow-sm backdrop-blur transition-all hover:border-gold/50 hover:text-gold active:scale-95"
        >
          <Maximize className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={goLive}
          aria-label={t("followLive")}
          title={t("followLive")}
          className={
            "flex h-7 w-7 items-center justify-center rounded-md border shadow-sm backdrop-blur transition-all active:scale-95 " +
            (follow
              ? "border-gold/60 bg-gold/15 text-gold"
              : "border-border bg-card/85 text-muted-foreground hover:border-gold/50 hover:text-gold")
          }
        >
          <ArrowRightToLine className={"h-3.5 w-3.5 " + (follow ? "live-dot" : "")} />
        </button>
      </div>

      {selectedId && (
        <button
          className="absolute right-2 top-2 z-20 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] font-semibold text-red-400 backdrop-blur hover:bg-red-500/10"
          onClick={() => {
            onDeleteDrawing(selectedId);
            setSelectedId(null);
          }}
        >
          DELETE DRAWING
        </button>
      )}
      {textDialog && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-72 rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="mb-2 text-xs font-semibold text-foreground">Chart note</div>
            <input
              autoFocus
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && textValue.trim()) {
                  onCreateDrawing({
                    symbol, timeframe, kind: "text",
                    points: [textDialog],
                    style: { text: textValue.trim() },
                  });
                  setTextDialog(null);
                  setTextValue("");
                }
                if (e.key === "Escape") { setTextDialog(null); setTextValue(""); }
              }}
              placeholder="Type a note and press Enter…"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════ helpers ═══════════════

/** user-drawing line segment (thin, haloed) */
function seg(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  color: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

function sanitize(bars: Candle[]): Candle[] {
  const seen = new Map<number, Candle>();
  for (const b of bars) {
    if (
      !Number.isFinite(b.t) || !Number.isFinite(b.o) || !Number.isFinite(b.h) ||
      !Number.isFinite(b.l) || !Number.isFinite(b.c) || b.h < b.l
    ) continue;
    seen.set(b.t, b);
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

function barToLw(b: Candle) {
  return {
    time: b.t as UTCTimestamp,
    open: b.o, high: b.h, low: b.l, close: b.c,
  };
}
function volToLw(b: Candle) {
  return {
    time: b.t as UTCTimestamp,
    value: b.v,
    color: b.c >= b.o ? THEMES.dark.volUp : THEMES.dark.volDown,
  };
}

function emaSeries(bars: Candle[], n: number): (number | null)[] {
  if (bars.length < n) return bars.map(() => null);
  const k = 2 / (n + 1);
  const out: (number | null)[] = [];
  let prev = bars.slice(0, n).reduce((a, b) => a + b.c, 0) / n;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (i === n - 1) { out.push(prev); continue; }
    prev = bars[i].c * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function applyPreservedRange(
  chart: IChartApi | null,
  prevRange: { from: number; to: number } | null,
  prevBars: Candle[],
  nextBars: Candle[],
) {
  if (!chart) return;
  const ts = chart.timeScale();
  const len = nextBars.length;
  if (!prevRange || !prevBars.length || !len) {
    ts.setVisibleLogicalRange({ from: Math.max(0, len - 95), to: len + RIGHT_PAD });
    return;
  }
  const span = prevRange.to - prevRange.from;
  const lastIdx = len - 1;
  if (prevRange.to >= prevBars.length - 1 - FOLLOW_SLACK_BARS) {
    // was following the right edge → keep following
    const to = lastIdx + RIGHT_PAD;
    ts.setVisibleLogicalRange({ from: to - span, to });
  } else {
    // history-anchored → anchor by time
    const anchorIdx = Math.round(prevRange.from);
    const anchorT = prevBars[Math.min(anchorIdx, prevBars.length - 1)]?.t;
    if (anchorT == null) {
      ts.setVisibleLogicalRange({ from: Math.max(0, len - 95), to: len + RIGHT_PAD });
      return;
    }
    let idx = nextBars.findIndex((b) => b.t >= anchorT);
    if (idx < 0) idx = Math.max(0, len - 95);
    const to = Math.min(idx + span, lastIdx + 12);
    ts.setVisibleLogicalRange({ from: Math.max(0, to - span), to });
  }
}
