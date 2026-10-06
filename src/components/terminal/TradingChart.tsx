"use client";

/**
 * TradingChart — MT5-style candlestick chart.
 *
 * Engine: lightweight-charts v4 (candles + ghosted volume) with a custom
 * canvas overlay carrying the whole analysis ink layer (ported visual grammar:
 * thin hard 0.7–1px lines with halos, ~3% zone fills, tiny fixed-px text with
 * shadows, kill-zone bands, EMA ribbon, SMC drawings, setup boxes, magnets,
 * draw-path) PLUS user drawings with hit-test / drag / persist.
 *
 * Live feel: a single-writer rAF easing loop (EASE = 0.22) drives the forming
 * candle toward the latest tick target, exactly like the reference engine.
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
import { feed, useBars, restUrl } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { expiryBarsFor } from "@/lib/market/engine";
import type {
  AutoDrawing,
  Candle,
  SignalPayload,
  UserDrawing,
} from "@/lib/market/types";
import type { Layers, ToolId, InkFilters } from "@/hooks/useTerminal";
import { TF_ORDER } from "@/lib/market/cluster";
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
  distToSeg,
  clamp,
  fmtCompact,
} from "./overlay-utils";
import { Plus, Minus, Maximize, ArrowRightToLine, Loader2 } from "lucide-react";

const EASE = 0.22;
const FOLLOW_SLACK_BARS = 2;
const RIGHT_PAD = 5;

/** /api/ai-chart response → AutoDrawing[] — what the AI brain "sees" on the chart */
function aiDrawingsFrom(j: {
  symbol?: string;
  tf?: string;
  supports?: { price: number; touches: number }[];
  resistances?: { price: number; touches: number }[];
  valueArea?: { poc: number; vah: number; val: number } | null;
  trade?: { side: string; entry: number; sl: number; tp: number } | null;
}, digits: number): AutoDrawing[] {
  const out: AutoDrawing[] = [];
  const fmt = (n: number) => n.toFixed(Math.min(digits, 4));
  for (const s of j.supports ?? []) {
    out.push({ kind: "hline", price: s.price, tone: "bull", style: "dash", label: `AI S ${fmt(s.price)} · ×${s.touches}` });
  }
  for (const r of j.resistances ?? []) {
    out.push({ kind: "hline", price: r.price, tone: "bear", style: "dash", label: `AI R ${fmt(r.price)} · ×${r.touches}` });
  }
  if (j.valueArea) {
    out.push({ kind: "hline", price: j.valueArea.poc, tone: "gold", label: `POC ${fmt(j.valueArea.poc)}` });
    out.push({ kind: "hline", price: j.valueArea.vah, tone: "gold", style: "dash", label: `VAH ${fmt(j.valueArea.vah)}` });
    out.push({ kind: "hline", price: j.valueArea.val, tone: "gold", style: "dash", label: `VAL ${fmt(j.valueArea.val)}` });
  }
  if (j.trade) {
    out.push({ kind: "hline", price: j.trade.entry, tone: "violet", label: `AI ${j.trade.side.toUpperCase()} ${fmt(j.trade.entry)}` });
    if (j.trade.sl > 0) out.push({ kind: "hline", price: j.trade.sl, tone: "bear", label: `AI SL ${fmt(j.trade.sl)}` });
    if (j.trade.tp > 0) out.push({ kind: "hline", price: j.trade.tp, tone: "bull", label: `AI TP ${fmt(j.trade.tp)}` });
  }
  return out;
}

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
  /** v17.0: the ink filters (level budget / HTF / faded / merged) — optional
   *  so the bare trio charts keep working without them */
  inkFilters?: InkFilters;
  tool: ToolId;
  onToolDone: () => void;
  autoDrawings: AutoDrawing[];
  signals: SignalPayload[];
  selectedSignalId: string | null;
  userDrawings: UserDrawing[];
  onCreateDrawing: (d: Omit<UserDrawing, "id" | "createdAt">) => void;
  onUpdateDrawing: (id: string, points: UserDrawing["points"], style: UserDrawing["style"]) => void;
  onDeleteDrawing: (id: string) => void;
  /** BARE mode (the trio's candle section): no on-canvas legend / badges —
   *  the OHLC legend lives in a strip OUTSIDE the chart (user request) */
  bare?: boolean;
}

interface PendingCreate {
  kind: ToolId;
  a1?: { x: number; y: number; t: number; p: number };
  /** v17.1 — the triangle tool's SECOND anchor (3-anchor creation) */
  a2?: { x: number; y: number; t: number; p: number };
  move?: { x: number; y: number; t: number; p: number };
}

/** v17.0 — one hoverable level band (a clustered level winner): the
 *  rectangle in canvas coordinates + the merge rationale it carries. */
interface LevelTip {
  x1: number; y1: number; x2: number; y2: number;
  title: string;
  price: string;
  sourceTf?: string;
  mergedFrom?: string[];
}

export default function TradingChart(props: Props) {
  const {
    symbol, timeframe, digits, layers, tool, onToolDone,
    autoDrawings, signals, selectedSignalId,
    userDrawings, onCreateDrawing, onUpdateDrawing, onDeleteDrawing,
    inkFilters,
    bare = false,
  } = props;

  const DEFAULT_INK: InkFilters = { maxLevels: 8, htf: true, faded: true, merged: false };

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
  const autoRef = useRef(autoDrawings);
  const userRef = useRef(userDrawings);
  const layersRef = useRef(layers);
  const inkRef = useRef<InkFilters>(inkFilters ?? DEFAULT_INK);
  const signalsRef = useRef(signals);
  const toolRef = useRef(tool);
  // BARE mode = no on-canvas legend / badges (the trio's candle section —
  // the OHLC legend renders in a strip outside the chart instead)
  const bareRef = useRef(bare);
  useEffect(() => { bareRef.current = bare; }, [bare]);
  // AI live chart-read (S/R + value area + trade levels from the trading brain)
  const aiRef = useRef<AutoDrawing[]>([]);

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
  // v17.0 — merge-rationale tooltip: hover targets registered by the level
  // renderer (one band per clustered level winner) + the currently shown tip
  const tipRef = useRef<LevelTip[]>([]);
  const [tip, setTip] = useState<{
    key: string; x: number; y: number; vw: number; vh: number;
    title: string; price: string;
    sourceTf?: string; mergedFrom?: string[];
  } | null>(null);
  // free-zoom follow mode (auto-follow the live right edge)
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);

  const tfSec = TF_SEC[timeframe] ?? 900;

  const scheduleRedraw = useCallback(() => {
    requestAnimationFrame(() => drawOverlayRef.current());
  }, []);

  // ── AI live chart read (what the trading brain sees) — refresh every 10s ──
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    // v16.4 (audit §4): a symbol/tf switch must not keep the PREVIOUS
    // market's AI drawings on the new chart while the fetch is in flight —
    // clear the layer immediately; the fresh read repopulates it.
    aiRef.current = [];
    scheduleRedraw();
    const load = async () => {
      try {
        const res = await fetch(restUrl(`/api/ai-chart?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}`));
        if (res.ok) {
          const j = await res.json();
          // v16.4.1 (audit §4): TWO stale guards, not one — the stop flag
          // kills responses after THIS effect was torn down (tf switched),
          // and the identity echo (the service returns symbol+tf) catches
          // an out-of-order landing that survived teardown (e.g. a retry
          // racing the cleanup). A stale read must never ink the new chart.
          const isCurrent =
            (j.symbol === undefined || j.symbol === symbol) &&
            (j.tf === undefined || j.tf === timeframe);
          if (!stop && j && !j.error && isCurrent) {
            aiRef.current = aiDrawingsFrom(j, digits);
            scheduleRedraw();
          }
        }
      } catch { /* service briefly away — retry below */ }
      if (!stop) timer = setTimeout(load, 10_000);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [symbol, timeframe, digits, scheduleRedraw]);

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
    // the LIVE setup's numbers on the price scale itself (axis tags,
    // TradingView-style) — entry / SL / TP always readable
    if (!layers.setup) return;
    const setup = autoDrawings.find(
      (d): d is Extract<AutoDrawing, { kind: "setup" }> => d.kind === "setup",
    );
    if (!setup) return;
    const mk = (price: number, color: string, title: string, dash: LineStyle) =>
      series.createPriceLine({
        price, color, lineWidth: 1, lineStyle: dash,
        axisLabelVisible: true, lineVisible: false, title,
      });
    priceLinesRef.current = [
      mk(setup.entry, "#d4af37", `${setup.dir} ${setup.status === "projected" ? "PLAN" : "ENTRY"}`, LineStyle.Dotted),
      mk(setup.sl, "#f87171", "SL", LineStyle.Dashed),
      mk(setup.tp, "#34d399", "TP", LineStyle.Dashed),
    ];
  }, [selectedSignalId, signals, autoDrawings, layers.setup]);

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
    autoRef.current = autoDrawings;
    userRef.current = userDrawings;
    layersRef.current = layers;
    inkRef.current = inkFilters ?? DEFAULT_INK;
    signalsRef.current = signals;
    toolRef.current = tool;
    selectedRef.current = selectedId;
    emaRef.current = emaArrays;
  });

  // volume layer visibility (histogram series toggle)
  useEffect(() => {
    volRef.current?.applyOptions({ visible: layers.volume });
  }, [layers.volume]);

  // ═══════════════ 7. THE OVERLAY ═══════════════

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
    // v18.0: narrow-chart ink discipline — the user reads this terminal on a
    // phone (their reference screenshots are Android Chrome); below ~520px
    // of plot width the secondary labels (fib ratios, pattern family
    // words) yield so the primary contracts stay readable
    const narrow = rightEdge < 520;
    const lastTime = bs[bs.length - 1].t;
    const barSpacing = ts.options().barSpacing ?? 6.5;

    const xOfTime = (t: number): number | null => {
      const x = ts.timeToCoordinate(t as UTCTimestamp);
      if (x !== null) return x;
      // v16.8 (user audit): off-window times resolve through the BAR GRID
      // (logical coordinates), never blind barSpacing arithmetic — the old
      // linear extrapolation ignored session/weekend gaps and drew BOS
      // break-lines from wildly wrong left endpoints. Older than the loaded
      // data clamps to the first bar; newer projects forward gap-free.
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
    const timeOfX = (x: number): number | null => {
      const t = ts.coordinateToTime(x);
      if (t !== null) return t as number;
      const xLast = ts.timeToCoordinate(lastTime as UTCTimestamp);
      if (xLast === null) return null;
      return lastTime + ((x - xLast) / barSpacing) * tf;
    };
    const yOfPrice = (p: number): number | null => series.priceToCoordinate(p) ?? null;
    const priceOfY = (y: number): number | null => series.coordinateToPrice(y) ?? null;

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
            // v16.8 (user audit): ICT kill zones on the UTC clock —
            // NY·AM = 09:30–11:00 EST = 14:30–16:00 UTC (the old 12–15
            // band started 30min early and ended an hour early);
            // NY·PM = 13:30–16:00 EST = 18:30–21:00 UTC (was 15:30–17,
            // which overlapped the corrected AM zone)
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

      // ── auto drawings (SMC ink) ──
      // label collision system: earlier (higher-priority) labels win space
      const labelBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const tryLabel = (x: number, y: number, text: string, size: number, align: CanvasTextAlign, force = false): boolean => {
        ctx.font = `700 ${size}px ${FONT_FAMILY}`;
        const w = ctx.measureText(text).width;
        const x1 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
        const x2 = x1 + w;
        const y1 = y - size / 2 - 1;
        const y2 = y + size / 2 + 1;
        if (!force) {
          for (const b of labelBoxes) {
            if (x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1) return false;
          }
        }
        labelBoxes.push({ x1: x1 - 3, y1: y1 - 2, x2: x2 + 3, y2: y2 + 2 });
        return true;
      };
      // badge tag — the trade's numbers in a box so they read over candles
      // (defined BEFORE the render loop — renderAuto uses it)
      const badgeTag = (
        x: number, y: number, text: string, fg: string, bg: string,
        border: string, dashed = false, size = 9,
      ) => {
        ctx.font = `700 ${size}px ${FONT_FAMILY}`;
        const tw = ctx.measureText(text).width;
        const padX = 5, padY = 3, r = 3.5;
        const bw = tw + padX * 2;
        const bh = size + padY * 2;
        const bx = x - bw;
        const by = y - bh / 2;
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
        ctx.fillStyle = bg;
        ctx.fill();
        if (dashed) ctx.setLineDash([2, 2]);
        ctx.strokeStyle = border;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.setLineDash([]);
        hardText(ctx, text, x - padX, y + 0.5, fg, size, "right");
      };
      // per-kind layer gating (D-058-style granular hide/show)
      // v16.5: the narrative kinds — range→zones, amd/instit/forecast→structure
      const LAYER_OF: Record<string, keyof Layers> = {
        setup: "setup",
        zone: "zones",
        range: "zones",
        hline: "levels",
        liq: "levels",
        magnet: "levels",
        structure: "structure",
        zigzag: "structure",
        swing: "structure",
        trendline: "structure",
        channel: "structure",
        candle: "structure",
        fib: "structure",
        sweep: "structure",
        pattern: "structure",
        arrow: "structure",
        amd: "structure",
        instit: "structure",
        forecast: "structure",
        path: "structure",
        tf_setup: "setup",
        momentum: "momentum",
      };
      // v17.0 — INK FILTERS (the audit's dedup/count/freshness controls):
      //  · merged duplicates stay hidden unless explicitly asked for
      //  · faded ink (mitigated zones, broken trendlines, swept pools,
      //    broken ranges) can be silenced
      //  · HTF-sourced ink (H1/H4 drawings on a lower-tf chart) can be silenced
      //  · level winners beyond the visible budget (rank > maxLevels) hide
      const chartTfRank = TF_ORDER[timeframe] ?? 3;
      const ink = inkRef.current;
      const tips: LevelTip[] = [];
      // v18.0 (reference images — "multiple setups"): a per-frame budget of
      // how many pattern TRADE PLANS (entry/stop/target + measured move)
      // may draw. The reference cheat-sheet labels entry/stop/target on
      // EVERY pattern — but it is a schematic with no hero setup box. We
      // keep TWO pattern plans max (confirmed first — they render first in
      // the array), so the chart reads as multiple setups without the
      // v16.10 four-competing-entries clutter.
      let patternPlanN = 0;
      // v17.2 — SWINGS FIRST (reference port): the HH/HL/LL/LH tags are the
      // spine every other drawing hangs from (user: "লাস্ট কয়েকটি LL HL HH HL
      // এই গুলো কে মাথা রেখে ড্রয়িং হচ্ছে"), so they render BEFORE all other
      // ink and win every label collision — no CHoCH/zone/level pill may
      // ever push a structure tag off the canvas.
      if (layersRef.current.structure) {
        for (const d of autoRef.current) {
          if (d.kind !== "swing") continue;
          try { drawSwingTag(d); } catch { /* one bad tag must not blank the chart */ }
        }
      }
      // v17.2 — ONE budget for ALL horizontal ink: key levels, liquidity
      // pools and magnets fight for the same maxLevels slots, nearest to
      // price first. The ×N clustering already ranks S/R winners, but pools
      // and magnets had NO cap — the right edge stacked pill on pill (VLM
      // audit of the live chart: "the right third is a spaghetti chart").
      const levelKinds = new Set(["hline", "liq", "magnet"]);
      const lastPrice = bs[bs.length - 1].c;
      const levelKeep = new Set<AutoDrawing>();
      autoRef.current
        .filter((d) => levelKinds.has(d.kind) && !(d.mergedInto && !ink.merged))
        .map((d) => ({ d, dist: Math.abs((d as { price: number }).price - lastPrice) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, Math.max(1, ink.maxLevels))
        .forEach((r) => levelKeep.add(r.d));
      for (const d of autoRef.current) {
        if (d.kind === "swing") continue; // v17.2: the pre-pass drew the spine first
        const layer = LAYER_OF[d.kind] ?? "zones";
        if (!layersRef.current[layer]) continue;
        if (d.mergedInto && !ink.merged) continue;
        if (!ink.faded) {
          const fadedInk =
            (d.kind === "zone" && (d.state === "faded" || d.mitT != null)) ||
            (d.kind === "trendline" && (d.broken || d.state === "faded")) ||
            (d.kind === "liq" && d.state !== "untouched") ||
            (d.kind === "range" && d.state !== "forming");
          if (fadedInk) continue;
        }
        if (!ink.htf) {
          const srcTf = (d as { source_tf?: string }).source_tf;
          if (srcTf && (TF_ORDER[srcTf] ?? 0) > chartTfRank) continue;
        }
        if (d.rank != null && d.rank > ink.maxLevels) continue;
        // v17.2: the unified proximity budget — only the nearest N
        // horizontal lines (of ANY kind) get ink
        if (levelKinds.has(d.kind) && !levelKeep.has(d)) continue;
        try { renderAuto(ctx, d); } catch (e) { console.warn("[chart] renderAuto failed:", d.kind, e); }
      }
      tipRef.current = tips;

      // ── AI chart-read layer — what the trading brain sees right now ──
      if (layersRef.current.ai) {
        for (const d of aiRef.current) {
          try { renderAuto(ctx, d); } catch { /* one bad level must not blank the chart */ }
        }
      }

      // ctx arrives as a PARAMETER, not a closure capture: renderAuto is a
      // hoisted function declaration, so TypeScript's `if (!ctx) return`
      // narrowing above does NOT cross into it — the non-null context must
      // be threaded through explicitly (v16.9: fixes ~130 null-guard errors).
      /** v17.2 — the swing tag (reference app's D-058 grammar): a 7px tick
       *  away from the swing, an anchor dot on the exact price and the tiny
       *  fixed-size shadowed word ABOVE highs / BELOW lows — the structure
       *  read a price-action trader keeps in their head. Color is positional
       *  (reference port): words above candles read bear/resistance red,
       *  words below read bull/support green — same coding as the zones. */
      function drawSwingTag(d: Extract<AutoDrawing, { kind: "swing" }>) {
        const x = xOfTime(d.t);
        const y = yOfPrice(d.price);
        if (x === null || y === null || x < -6 || x > rightEdge + 6) return;
        const high = d.side === "high";
        const dir = high ? -1 : 1; // the word sits away from the candles
        const color = high ? "rgba(252,165,165,0.95)" : "rgba(110,231,183,0.95)";
        // the tick at the swing point
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.6;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + dir * 7);
        ctx.stroke();
        // the anchor dot on the swing price
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
        // the word — fixed 8px, shadowed, never scaled by zoom
        const ty = y + dir * 16;
        if (tryLabel(x, ty, d.tag, 8, "center")) {
          hardText(ctx, d.tag, x, ty, color, 8, "center");
        }
      }
      function renderAuto(ctx: CanvasRenderingContext2D, d: AutoDrawing) {
        switch (d.kind) {
          case "hline": {
            const y = yOfPrice(d.price);
            if (y === null) return;
            const tone = TONES[d.tone] ?? TONES.neutral;
            // v17.1 — MTF S/R key level: tagged R/S · TF · ×hits, drawn
            // FROM the origin swing (TradingView-style) instead of full
            // width; multi-hit levels are solid, single-test dashed
            const isSr = d.side != null && d.source_tf != null;
            const x0 = isSr && d.t != null ? (xOfTime(d.t) ?? 0) : 0;
            const faded = d.style === "dash";
            // v17.0: a clustered winner wears the ×N merge badge
            const mc = d.mergedFrom?.length ?? 0;
            const srTag = isSr
              ? `${d.side === "resistance" ? "R" : "S"}·${d.source_tf}${(d.hits ?? 1) > 1 ? ` ×${d.hits}` : ""}`
              : null;
            const hl = srTag ?? (mc ? `${d.label} ×${mc + 1}` : d.label);
            hardSeg(
              ctx, Math.max(0, x0), y, rightEdge, y,
              tone.line(faded ? 0.45 : 0.9), tone.halo(0.08), 0.6,
              faded ? [4, 4] : [],
            );
            if (mc) {
              tips.push({
                x1: 0, y1: y - 9, x2: rightEdge, y2: y + 9,
                title: srTag != null ? `${d.side === "resistance" ? "RESISTANCE" : "SUPPORT"} · ${d.source_tf}${mc ? ` ×${mc + 1}` : ""}` : hl,
                price: d.price.toFixed(digits), sourceTf: d.source_tf, mergedFrom: d.mergedFrom,
              });
            }
            if (tryLabel(rightEdge - 4, y - 8, hl, 8.5, "right")) {
              pillLabel(ctx, hl, rightEdge - 4, y - 8, tone.text, tone.line(0.5), "right", 8.5);
            }
            break;
          }
          case "zone": {
            const st = ZONE_STYLE[d.side];
            const y1 = yOfPrice(d.hi);
            const y2 = yOfPrice(d.lo);
            const x = xOfTime(d.t);
            if (y1 === null || y2 === null || x === null) return;
            const x0 = clamp(x, -2, rightEdge);
            if (x0 >= rightEdge - 4) return;
            // v16.8 (user audit): a MITIGATED zone stops at its mitigation
            // candle — the old rect stretched every faded zone to the right
            // edge, piling dead ink over the live price area. Fresh zones
            // still extend right (they are live levels).
            let xEnd = rightEdge;
            if (d.state === "faded" && d.mitT != null) {
              const xm = xOfTime(d.mitT);
              if (xm != null) xEnd = clamp(xm, x0, rightEdge);
            }
            if (xEnd - x0 < 2) return;
            const alphaMul = d.state === "faded" ? 0.32 : 1;
            ctx.globalAlpha = alphaMul;
            ctx.fillStyle = st.fill;
            ctx.fillRect(x0, Math.min(y1, y2), xEnd - x0, Math.abs(y2 - y1));
            hardSeg(ctx, x0, y1, xEnd, y1, st.border, st.halo, 0.5);
            hardSeg(ctx, x0, y2, xEnd, y2, st.border, st.halo, 0.5);
            const sideName: Record<string, string> = {
              supply: "SUPPLY", demand: "DEMAND", ob_bull: "OB+", ob_bear: "OB−",
              fvg_bull: "FVG+", fvg_bear: "FVG−",
            };
            // v16.5: INST tag — the zone's origin bar carried a ≥1.5σ volume
            // spike (institutional footprint: banks/funds were active there)
            // v17.0: ×N merge badge when this zone won its price cluster
            const zmc = d.mergedFrom?.length ?? 0;
            const zl = `${sideName[d.side] ?? d.side}${d.source_tf ? " · " + d.source_tf : ""}${d.institutional ? " · INST" : ""}${zmc ? ` ×${zmc + 1}` : ""}`;
            if (zmc) {
              tips.push({
                x1: x0, y1: Math.min(y1, y2), x2: xEnd, y2: Math.max(y1, y2),
                title: zl,
                price: `${d.lo.toFixed(digits)}–${d.hi.toFixed(digits)}`,
                sourceTf: d.source_tf,
                mergedFrom: d.mergedFrom,
              });
            }
            if (tryLabel(x0 + 4, Math.min(y1, y2) + 9, zl, 8.5, "left")) {
              pillLabel(ctx, zl, x0 + 4, Math.min(y1, y2) + 9, st.border, st.border, "left", 8.5);
            }
            ctx.globalAlpha = 1;
            break;
          }
          case "trendline": {
            const x1 = xOfTime(d.t1);
            const x2 = xOfTime(d.t2);
            const y1 = yOfPrice(d.p1);
            const y2 = yOfPrice(d.p2);
            if ([x1, x2, y1, y2].some((v) => v === null)) return;
            const tone = TONES[d.tone] ?? TONES.neutral;
            const faded = d.state === "faded" || d.broken;
            if (faded) {
              // broken line: THIN ghost, never projected (ref D-053)
              hardSeg(ctx, x1!, y1!, x2!, y2!, tone.line(0.30), tone.halo(0.04), 0.4, [3, 4]);
            } else {
              // solid core t1→t2 — v17.2 (user: "ট্রেন্ড লাইন গুলো সুন্দর করে
              // দেখায়"): the reference app draws trendlines as the LOUDEST
              // structural ink — 0.85px core + soft halo, clearly ahead of
              // the 0.55px zone borders, so the diagonals read at a glance
              hardSeg(ctx, x1!, y1!, x2!, y2!, tone.line(0.92), tone.halo(0.10), 0.85);
              // … then the dashed projection to the right edge — the path
              // ahead the market has been respecting ("মার্কেট ট্রেন্ড লাইন
              // ফলো করেই চলে")
              const slope = (y2! - y1!) / Math.max(1, x2! - x1!);
              const ye = y2! + slope * (rightEdge - x2!);
              hardSeg(ctx, x2!, y2!, rightEdge, ye, tone.line(0.65), "transparent", 0.6, [5, 4]);
            }
            break;
          }
          case "channel": {
            // v16.6 (ref _channel): upper/lower parallels + dashed median,
            // each projected forward — the corridor the market walks in.
            // v18.0 (user reference image — the green corridor): the area
            // between the parallels FILLS with a whisper tone so the
            // channel reads as a ZONE (like the reference's pale-green
            // ascending channel), not two naked lines.
            const ctone = TONES[d.tone ?? (d.dir === "up" ? "bull" : "bear")] ?? TONES.neutral;
            const chPoly = (l1: { t1: number; p1: number; t2: number; p2: number }, l2: { t1: number; p1: number; t2: number; p2: number }) => {
              const a1 = xOfTime(l1.t1), a2 = xOfTime(l1.t2), ay1 = yOfPrice(l1.p1), ay2 = yOfPrice(l1.p2);
              const b1 = xOfTime(l2.t1), b2 = xOfTime(l2.t2), by1 = yOfPrice(l2.p1), by2 = yOfPrice(l2.p2);
              if ([a1, a2, ay1, ay2, b1, b2, by1, by2].some((v) => v === null)) return;
              const ca2 = clamp(a2!, -2, rightEdge), cb2 = clamp(b2!, -2, rightEdge);
              const maxT = Math.max(ca2, cb2);
              if (maxT >= rightEdge - 1) {
                // both anchors already at the edge — plain quad
                ctx.beginPath();
                ctx.moveTo(clamp(a1!, -2, rightEdge), ay1!);
                ctx.lineTo(ca2, ay2!);
                ctx.lineTo(cb2, by2!);
                ctx.lineTo(clamp(b1!, -2, rightEdge), by1!);
                ctx.closePath();
              } else {
                // extend the corridor along both projected lines
                const sA = (ay2! - ay1!) / Math.max(1e-6, a2! - a1!);
                const sB = (by2! - by1!) / Math.max(1e-6, b2! - b1!);
                ctx.beginPath();
                ctx.moveTo(clamp(a1!, -2, rightEdge), ay1!);
                ctx.lineTo(ca2, ay2!);
                ctx.lineTo(rightEdge, ay2! + sA * (rightEdge - ca2));
                ctx.lineTo(rightEdge, by2! + sB * (rightEdge - cb2));
                ctx.lineTo(cb2, by2!);
                ctx.lineTo(clamp(b1!, -2, rightEdge), by1!);
                ctx.closePath();
              }
              ctx.fillStyle = ctone.fill(0.05);
              ctx.fill();
            };
            chPoly(d.upper, d.lower);
            const drawSide = (l: { t1: number; p1: number; t2: number; p2: number }, isMedian = false) => {
              const cx1 = xOfTime(l.t1), cx2 = xOfTime(l.t2), cy1 = yOfPrice(l.p1), cy2 = yOfPrice(l.p2);
              if ([cx1, cx2, cy1, cy2].some((v) => v === null)) return;
              hardSeg(ctx, cx1!, cy1!, cx2!, cy2!,
                isMedian ? TONES.neutral.line(0.38) : ctone.line(0.8),
                isMedian ? "transparent" : ctone.halo(0.05),
                isMedian ? 0.45 : 0.55);
              const slope = (cy2! - cy1!) / Math.max(1, cx2! - cx1!);
              const ye = cy2! + slope * (rightEdge - cx2!);
              hardSeg(ctx, cx2!, cy2!, rightEdge, ye,
                isMedian ? TONES.neutral.line(0.28) : ctone.line(0.5),
                "transparent", 0.45, [4, 4]);
            };
            drawSide(d.upper);
            drawSide(d.lower);
            if (d.median) drawSide(d.median, true);
            if (d.label) {
              const xl = xOfTime(d.lower.t2);
              const yl = yOfPrice(d.lower.p2);
              if (xl !== null && yl !== null && tryLabel(xl + 6, yl + 11, d.label, 8, "left")) {
                pillLabel(ctx, `${d.label}${d.source_tf ? " · " + d.source_tf : ""}`, xl + 6, yl + 11, ctone.text, ctone.line(0.5), "left", 8);
              }
            }
            break;
          }
          case "candle": {
            // v19.0 — the candlestick STRATEGY box (34→32-setup catalog,
            // confirmation-entry): the v18.0 highlight-box grammar stays
            // (near-white rectangle around the exact pattern candles) but
            // now tells the setup's whole story:
            //   · fresh (WATCH)      — white box + gold "•" (entry waits
            //     for the confirmation close — the plan is pending)
            //   · confirmed          — side-tone border (validated setup)
            //     + "✓" when the trade paid / "✗" when it stopped
            //   · failed             — dashed muted box (broke before
            //     confirming — history, not a live setup)
            // The tag carries code + direction arrow + confidence, and a
            // ×N badge for multi-candle patterns (2–5 bars).
            const cpt = d.side === "bull" ? TONES.bull : TONES.bear;
            const x0c = xOfTime(d.t0);
            const x1c = xOfTime(d.t1);
            const y0c = yOfPrice(d.hi);
            const y1c = yOfPrice(d.lo);
            if ([x0c, x1c, y0c, y1c].some((v) => v === null)) return;
            const padX = Math.max(2, barSpacing * 0.4);
            const bx0 = clamp(x0c! - padX, -2, rightEdge);
            const bx1 = clamp(x1c! + padX, -2, rightEdge);
            if (bx1 - bx0 < 2.5 || bx0 > rightEdge) return;
            const bw = bx1 - bx0;
            const bh = Math.abs(y1c! - y0c!);
            if (bh < 2) return;
            const by0 = Math.min(y0c!, y1c!);
            // fill: whisper tone for live setups, near-nothing for failed
            const live = d.status === "fresh" || d.status === "confirmed";
            ctx.fillStyle = d.status === "failed" ? cpt.fill(0.02) : cpt.fill(0.06);
            ctx.fillRect(bx0, by0, bw, bh);
            // border: white (watch) · side-tone (confirmed) · dashed muted (failed)
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
                d.status === "confirmed"
                  ? cpt.line(0.9)
                  : isDark ? "rgba(232,238,236,0.95)" : "rgba(34,40,37,0.9)";
              const w = d.status === "confirmed" ? 1.35 : 1.1;
              hardSeg(ctx, bx0, by0, bx1, by0, boxEdge, "transparent", w);
              hardSeg(ctx, bx0, by0 + bh, bx1, by0 + bh, boxEdge, "transparent", w);
              hardSeg(ctx, bx0, by0, bx0, by0 + bh, boxEdge, "transparent", w);
              hardSeg(ctx, bx1, by0, bx1, by0 + bh, boxEdge, "transparent", w);
            }
            // the name tag — below bull boxes, above bear boxes
            const glyph =
              d.status === "fresh" ? " •" :
              d.status === "confirmed" ? (d.outcome === "lost" ? " ✗" : " ✓") : "";
            const arrow = d.direction === "up" ? "▲" : "▼";
            const tag = `${d.name} ${arrow}${d.confidence}${glyph}`;
            const cx = (bx0 + bx1) / 2;
            const ly = d.side === "bull" ? by0 + bh + 11 : by0 - 11;
            if (cx >= 0 && cx <= rightEdge && tryLabel(cx, ly, tag, 8, "center")) {
              pillLabel(
                ctx, tag, cx, ly,
                d.status === "failed" ? "rgba(148,163,158,0.75)" : cpt.text,
                d.status === "fresh" ? "rgba(245,158,11,0.55)" : cpt.line(0.5),
                "center", 8,
              );
            }
            // ×N badge for multi-candle patterns — tiny mono count at the
            // box's top-left corner (the 1-bar shapes stay unbadged)
            if (d.n >= 2 && bw >= 14) {
              const nb = `×${d.n}`;
              hardText(ctx, nb, bx0 + 2.5, by0 + 7.5, "rgba(148,163,158,0.85)", 7, "left");
            }
            break;
          }
          case "fib": {
            const x0 = xOfTime(d.t0);
            const xA = xOfTime(d.t1);
            const y0 = yOfPrice(d.p0);
            const yA = yOfPrice(d.p1);
            if ([x0, xA, y0, yA].some((v) => v === null)) return;
            hardSeg(ctx, x0!, y0!, xA!, yA!, TONES.gold.line(0.5), TONES.gold.halo(0.05), 0.5);
            const golden = [0.618, 0.786];
            const gp: number[] = [];
            for (const lv of d.levels) {
              const y = y0! + (yA! - y0!) * lv.ratio;
              if (y === null) continue;
              const isGolden = golden.includes(lv.ratio);
              hardSeg(
                ctx, Math.max(x0!, xA!), y, rightEdge, y,
                TONES.gold.line(isGolden ? 0.75 : 0.42),
                TONES.gold.halo(isGolden ? 0.07 : 0.04), isGolden ? 0.55 : 0.45,
              );
              // v18.0: fib labels join the collision system — the seven
              // right-edge ratio texts used to draw unguarded and stacked
              // with every level pill (VLM audit: right-strip clutter).
              // Check-only for the non-golden ratios (the box is popped
              // right back): fib renders BEFORE the MTF S/R pills, and a
              // registered fib box would evict them — the S/R key levels
              // keep their priority (user spec: S/R must always show).
              const fl = `${lv.ratio.toFixed(3)}  ${lv.price.toFixed(digits)}`;
              if (isGolden) {
                tryLabel(rightEdge - 4, y - 7, fl, 8, "right", true);
                hardText(ctx, fl, rightEdge - 4, y - 7, TONES.gold.text, 8, "right");
              } else if (!narrow && tryLabel(rightEdge - 4, y - 7, fl, 8, "right")) {
                labelBoxes.pop();
                hardText(ctx, fl, rightEdge - 4, y - 7, "rgba(148,163,158,0.7)", 8, "right");
              }
              if (isGolden) gp.push(y);
            }
            if (gp.length === 2 && d.ote) {
              ctx.fillStyle = "rgba(245,158,11,0.035)";
              ctx.fillRect(Math.max(x0!, xA!), Math.min(gp[0], gp[1]), rightEdge - Math.max(x0!, xA!), Math.abs(gp[1] - gp[0]));
            }
            break;
          }
          case "sweep": {
            const x = xOfTime(d.t);
            const y = yOfPrice(d.price);
            if (x === null || y === null) return;
            xMark(ctx, x, y, "rgba(248,113,113,0.9)", 5);
            if (tryLabel(x, y + (d.side === "high" ? -11 : 11), "SWEEP", 7, "center")) {
              hardText(ctx, "SWEEP", x, y + (d.side === "high" ? -11 : 11), "rgba(252,165,165,0.9)", 7, "center");
            }
            break;
          }
          case "structure": {
            const x = xOfTime(d.t);
            const y = yOfPrice(d.price);
            if (x === null || y === null) return;
            // v16.5: EVERY event carries its source tf — "BOS · H1" reads as
            // H1 context on any chart, "BOS · M15" = the active tf's own
            // (audit §2.6: overlay must say where each drawing came from)
            const tag = d.source_tf ? `${d.label} · ${d.source_tf}` : d.label;
            const isBos = d.label.startsWith("BOS");
            const color = isBos ? "rgba(52,211,153,0.9)" : "rgba(245,158,11,0.92)";
            // the break line: from the swing origin to the breaking candle
            // (classic SMC structure-break ink, reads at a glance)
            if (d.fromT != null) {
              const x0 = xOfTime(d.fromT);
              if (x0 !== null) {
                const xa = clamp(x0, -2, rightEdge);
                const xb = clamp(x + 6, xa, rightEdge);
                if (xb > xa) {
                  const bc = isBos ? "52,211,153" : "245,158,11";
                  hardSeg(ctx, xa, y, xb, y, `rgba(${bc},0.55)`, `rgba(${bc},0.04)`, 0.5, [4, 3]);
                }
              }
            }
            diamond(ctx, x, y, color, 4.5, color.replace("0.9", "0.25"), true);
            if (tryLabel(x, y + (d.dir === "up" ? 12 : -12), tag, 7.5, "center")) {
              hardText(ctx, tag, x, y + (d.dir === "up" ? 12 : -12), color, 7.5, "center");
            }
            break;
          }
          case "zigzag": {
            // the market-structure path — confirmed swings connected
            const pts = d.points
              .map((pt) => ({ x: xOfTime(pt.t), y: yOfPrice(pt.p), side: pt.side }))
              .filter((pt): pt is { x: number; y: number; side: "high" | "low" } =>
                pt.x !== null && pt.y !== null && pt.x >= -2 && pt.x <= rightEdge + 4);
            if (pts.length < 2) return;
            ctx.save();
            ctx.strokeStyle = "rgba(196,205,214,0.8)";
            ctx.lineWidth = 0.7; // v16.8: 1.0 → 0.7 — thinner & clearer
            ctx.setLineDash([]);
            ctx.shadowColor = "rgba(10,12,16,0.7)";
            ctx.shadowBlur = 2.5;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            // project the last leg to the right edge (structure continues)
            if (pts.length >= 2) {
              const a2 = pts[pts.length - 2];
              const b2 = pts[pts.length - 1];
              const slope = (b2.y - a2.y) / Math.max(1, b2.x - a2.x);
              ctx.lineTo(rightEdge, b2.y + slope * (rightEdge - b2.x));
            }
            ctx.stroke();
            ctx.restore();
            // node dots at each swing
            for (const pt of pts) {
              ctx.fillStyle = pt.side === "high" ? "rgba(255,138,138,0.98)" : "rgba(94,234,178,0.98)";
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = "rgba(10,12,16,0.6)";
              ctx.lineWidth = 0.8;
              ctx.stroke();
            }
            break;
          }
          case "arrow": {
            const x = xOfTime(d.t);
            const y = yOfPrice(d.price);
            if (x === null || y === null) return;
            const tone = TONES[d.tone ?? (d.dir === "up" ? "bull" : "bear")] ?? TONES.bull;
            arrow(ctx, x, y, d.dir, tone.line(0.9), tone.halo(0.25), 6);
            break;
          }
          case "swing": {
            // v17.2: the AI layer's swings use the same tag grammar as the
            // pre-pass spine (tick + dot + shadowed word)
            drawSwingTag(d);
            break;
          }
          case "setup": {
            // D-074 — the signal IS the drawing: full-width ENTRY/SL/TP
            // contract from the signal's own candle to the right edge.
            // "projected" = planned NEXT entry when no live signal exists
            // (user: কোন প্রাইসে এন্ট্রি / SL / TARGET — সবসময় চার্টে দেখতে হবে)।
            const yE = yOfPrice(d.entry);
            const yS = yOfPrice(d.sl);
            const yT = yOfPrice(d.tp);
            if (yE === null || yS === null || yT === null) return;
            const isBuy = d.dir === "BUY";
            const projected = d.status === "projected";
            const waiting = d.status === "pending" || projected;
            // anchor x — the bar the setup was born on, snapped to the grid
            const xEntry = xOfTime(d.t0);
            // v16.9 (audit §6.5): a limit entry projected into the future can
            // place the box anchor beyond the right edge (or off the time
            // scale entirely) — the pinned chevron below keeps it visible.
            const offscreen = xEntry === null || xEntry > rightEdge;
            let xs = xEntry ?? rightEdge - 24;
            xs = clamp(xs, -2, rightEdge - 24);
            // risk shading (red entry↔SL, green entry↔TP) — reads at a glance
            // v14: LIVE/pending setups ONLY. A PLAN (projected) setup draws
            // NO shading — the audit: same zone shading as a live entry
            // invited entries at the planned price. The dotted lines, the
            // PLAN badges and the "planned entry" note carry it alone.
            if (!projected) {
              ctx.fillStyle = "rgba(248,113,113,0.10)";
              ctx.fillRect(xs, Math.min(yE, yS), rightEdge - xs, Math.abs(yS - yE));
              ctx.fillStyle = "rgba(52,211,153,0.10)";
              ctx.fillRect(xs, Math.min(yE, yT), rightEdge - xs, Math.abs(yT - yE));
            }
            // dotted birth line — where the trade started
            if (xs > 2) {
              hardSeg(ctx, Math.round(xs) + 0.5, 0, Math.round(xs) + 0.5, h, "rgba(154,160,170,0.4)", "transparent", 0.7, [2, 4]);
            }
            // ENTRY (gold, dotted while waiting) / SL (red dashed) / TP (green dashed)
            // v14: PLAN ink dimmed to 0.55 (was 0.85 — still read as a live entry)
            const inkM = projected ? 0.55 : 1;
            // ENTRY gets a soft glow so the entry price pops over everything
            ctx.save();
            ctx.shadowColor = "rgba(212,175,55,0.55)";
            ctx.shadowBlur = 5;
            hardSeg(ctx, xs, yE, rightEdge, yE, `rgba(230,190,70,${(0.98 * inkM).toFixed(2)})`, "rgba(212,175,55,0.1)", 0.8, waiting ? [2, 3] : []);
            ctx.restore();
            hardSeg(ctx, xs, yS, rightEdge, yS, `rgba(255,120,132,${(0.92 * inkM).toFixed(2)})`, "rgba(248,113,113,0.07)", 0.6, [5, 4]);
            hardSeg(ctx, xs, yT, rightEdge, yT, `rgba(52,211,153,${(0.92 * inkM).toFixed(2)})`, "rgba(52,211,153,0.07)", 0.6, [5, 4]);
            // v16.9 (audit §5.5): TP2 — the RUNNER leg of the partial TP
            // ladder. Same whisper-dashed grammar as TP, teal so it never
            // reads as a second bank target.
            const tp2 = d.tp2 != null && d.tp2 !== d.tp ? d.tp2 : null;
            const yT2 = tp2 != null ? yOfPrice(tp2) : null;
            if (tp2 != null && yT2 !== null) {
              hardSeg(ctx, xs, yT2, rightEdge, yT2, `rgba(20,184,166,${(0.85 * inkM).toFixed(2)})`, "rgba(20,184,166,0.06)", 0.55, [5, 4]);
            }
            // right-edge contract badges (setup labels always win — force register)
            const verb = projected ? "PLAN" : waiting ? "WAIT" : "ENTRY";
            const lE = `${d.dir} ${verb} ${d.entry.toFixed(digits)}`;
            const lS = `SL ${d.sl.toFixed(digits)}`;
            const lT = `TP ${d.tp.toFixed(digits)} · ${d.rr.toFixed(1)}R`;
            tryLabel(rightEdge - 4, yE - 11, lE, 10, "right", true);
            tryLabel(rightEdge - 4, yS + 11, lS, 10, "right", true);
            tryLabel(rightEdge - 4, yT - 11, lT, 10, "right", true);
            badgeTag(rightEdge, yE - 11, lE, "#fbbf24", "rgba(94,63,10,0.92)", "rgba(251,191,36,0.6)", projected, 10);
            badgeTag(rightEdge, yS + 11, lS, "#fecaca", "rgba(96,28,33,0.92)", "rgba(255,120,132,0.6)", projected, 10);
            badgeTag(rightEdge, yT - 11, lT, "#a7f3d0", "rgba(12,64,44,0.92)", "rgba(52,211,153,0.6)", projected, 10);
            if (tp2 != null && yT2 !== null) {
              const lT2 = `TP2 ${tp2.toFixed(digits)}`;
              tryLabel(rightEdge - 4, yT2 - 11, lT2, 9, "right", true);
              badgeTag(rightEdge, yT2 - 11, lT2, "#99f6e4", "rgba(4,47,46,0.92)", "rgba(20,184,166,0.55)", projected, 9);
            }
            // v16.9 (audit §6.5): off-screen setup — the entry lives beyond
            // the right edge, so a small chevron pinned at the edge + a
            // compact price tag at the entry's y keep the signal visible
            // even when its box can't be drawn in full (null/off-scale y skips).
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
            hardText(ctx, liveTxt, headX, headY, projected ? "#e7cd6f" : waiting ? "#e7cd6f" : isBuy ? "rgba(110,231,183,0.95)" : "rgba(252,165,165,0.95)", 10);
            if (d.note) hardText(ctx, d.note, headX, headY + 14, "rgba(190,196,206,0.9)", 8.5, "left", 500);
            if (projected) {
              hardText(ctx, "planned entry — no live signal yet", headX, headY + 26, "rgba(231,205,111,0.7)", 8.5, "left", 500);
            } else {
              const ageMin = d.createdAt
                ? Math.max(0, Math.round((Date.now() - new Date(d.createdAt).getTime()) / 60000))
                : null;
              const barsSinceSetup = d.t0 ? Math.max(0, Math.floor((bs[bs.length - 1].t - d.t0) / tf)) : 0;
              // v16.10 (user report): an ACTIVE signal holds until TP/SL is
              // consumed on a close — the expiry countdown is a PENDING-only
              // contract. Showing "expires in N bars" on a holding position
              // made the box look like it was about to vanish.
              const barsLeft = Math.max(0, expiryBarsFor(d.tf ?? timeframe) - barsSinceSetup);
              const holding = d.status === "active";
              const meta = [
                d.entryType === "limit" ? "limit order" : "market entry",
                ageMin !== null ? `${ageMin}m ago` : null,
                d.trigger ? d.trigger.toUpperCase() : null,
                holding
                  ? "holding · stays until TP/SL close"
                  : `${t("expires")} ${barsLeft} ${t("bars")}`,
              ].filter(Boolean).join(" · ");
              hardText(ctx, meta, headX, headY + 26, "rgba(164,172,182,0.85)", 8.5, "left", 500);
            }
            break;
          }
          // ═══════ v16.5 — the market-structure narrative (user spec) ═══════
          case "range": {
            // WHERE the market consolidated — the coil before the decision
            const y1 = yOfPrice(d.hi);
            const y2 = yOfPrice(d.lo);
            const x1 = xOfTime(d.t0);
            if (y1 === null || y2 === null || x1 === null) return;
            const x2raw = d.state === "forming" ? rightEdge : xOfTime(d.t1);
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
            const stTxt = d.state === "forming" ? "FORMING" : d.state === "broken_up" ? "BROKEN ↑" : "BROKEN ↓";
            const rl = `CONSOLIDATION · ${d.source_tf ?? ""}${d.source_tf ? " · " : ""}${stTxt}`;
            if (tryLabel(rx + 4, ry + 8, rl, 8, "left")) {
              pillLabel(ctx, rl, rx + 4, ry + 8, "rgba(200,210,205,0.95)", "rgba(148,163,158,0.5)", "left", 8);
            }
            break;
          }
          case "amd": {
            // the smart-money sequence: ACCUMULATION → MANIPULATION → DISTRIBUTION
            const y1 = yOfPrice(d.hi);
            const y2 = yOfPrice(d.lo);
            const x1 = xOfTime(d.t0);
            const x2raw = d.done ? xOfTime(d.t1) : rightEdge;
            if (y1 === null || y2 === null || x1 === null) return;
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
            if (tryLabel(xa + 4, ry - 7, label, 8, "left")) {
              pillLabel(ctx, label, xa + 4, ry - 7, st.text, st.stroke(0.5), "left", 8);
            }
            break;
          }
          case "instit": {
            // big players were HERE — volume-spiked impulse candle
            const x = xOfTime(d.t);
            const y = yOfPrice(d.price);
            if (x === null || y === null) return;
            const bull = d.side === "buy";
            const ay = y + (bull ? 17 : -17);
            arrow(ctx, x, ay, bull ? "up" : "down", bull ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)", "transparent", 5);
            const il = `${bull ? "BIG BUYERS" : "BIG SELLERS"} · z${d.volZ.toFixed(1)}`;
            if (tryLabel(x, ay + (bull ? 13 : -13), il, 7.5, "center")) {
              hardText(ctx, il, x, ay + (bull ? 13 : -13), bull ? "rgba(110,231,183,0.95)" : "rgba(252,165,165,0.95)", 7.5, "center");
            }
            break;
          }
          case "forecast": {
            // WHERE the market can go — projected legs to the roadmap targets
            const xNow = xOfTime(bs[bs.length - 1].t) ?? rightEdge - 10;
            const yFrom = yOfPrice(d.from);
            if (yFrom === null) return;
            const drawScenario = (
              legs: { price: number; label: string }[],
              primary: boolean,
            ) => {
              if (!legs.length) return;
              const step = Math.max(16, barSpacing * 7);
              let px = xNow;
              let py = yFrom;
              legs.forEach((leg, i) => {
                const ty = yOfPrice(leg.price);
                if (ty === null) return;
                const tx = Math.min(rightEdge - 2, xNow + step * (i + 1));
                if (tx <= px + 2 || Math.abs(ty - py) < 2) return;
                hardSeg(
                  ctx, px, py, tx, ty,
                  primary ? "rgba(251,191,36,0.85)" : "rgba(148,163,158,0.4)",
                  "transparent", primary ? 0.7 : 0.5, [4, 3],
                );
                arrow(ctx, tx, ty, ty < py ? "up" : "down", primary ? "rgba(251,191,36,0.95)" : "rgba(178,190,185,0.6)", "transparent", 4.5);
                if (primary && tryLabel(tx, ty + (ty < py ? -11 : 11), leg.label, 7.5, "center", true)) {
                  pillLabel(ctx, leg.label, tx, ty + (ty < py ? -11 : 11), "rgba(251,191,36,0.95)", "rgba(245,158,11,0.5)", "center", 7.5);
                }
                px = tx;
                py = ty;
              });
            };
            drawScenario(d.primary.legs, true);
            drawScenario(d.alternate?.legs ?? [], false);
            // the map header at the origin — direction verdict in one glance
            const hd = `MAP ${d.primary.dir === "up" ? "▲" : "▼"}${d.primary.note ? "" : ""}`;
            if (tryLabel(xNow, yFrom + (d.primary.dir === "up" ? -14 : 14), hd, 8, "center", true)) {
              pillLabel(ctx, hd, xNow, yFrom + (d.primary.dir === "up" ? -14 : 14), "rgba(251,191,36,0.95)", "rgba(245,158,11,0.55)", "center", 8);
            }
            break;
          }
          case "magnet": {
            const y = yOfPrice(d.price);
            if (y === null) return;
            hardSeg(ctx, rightEdge - 220, y, rightEdge, y, "rgba(251,191,36,0.6)", "rgba(245,158,11,0.06)", 0.6, [2, 4]);
            const mmc = d.mergedFrom?.length ?? 0;
            const ml = `MAGNET · ${d.source}${mmc ? ` ×${mmc + 1}` : ""}`;
            if (mmc) tips.push({ x1: rightEdge - 220, y1: y - 9, x2: rightEdge, y2: y + 9, title: ml, price: d.price.toFixed(digits), mergedFrom: d.mergedFrom });
            if (tryLabel(rightEdge - 4, y - 8, ml, 8, "right")) {
              pillLabel(ctx, ml, rightEdge - 4, y - 8, "rgba(251,191,36,0.92)", "rgba(251,191,36,0.45)", "right", 8);
            }
            break;
          }
          case "liq": {
            const y = yOfPrice(d.price);
            if (y === null) return;
            const faded = d.state !== "untouched";
            const color = d.side === "BSL" ? "rgba(255,120,132," : "rgba(52,211,153,";
            hardSeg(ctx, 0, y, rightEdge, y, color + (faded ? "0.32)" : "0.72)"), color + "0.06)", 0.62, faded ? [3, 4] : []);
            const state = d.state === "untouched" ? "" : d.state === "swept" ? " · SWEPT" : " · RUN";
            const lmc = d.mergedFrom?.length ?? 0;
            const ll = `${d.side} ${d.price.toFixed(digits)}${state}${lmc ? ` ×${lmc + 1}` : ""}`;
            if (lmc) tips.push({ x1: 0, y1: y - 9, x2: rightEdge, y2: y + 9, title: `${d.side} LIQUIDITY ×${lmc + 1}`, price: d.price.toFixed(digits), mergedFrom: d.mergedFrom });
            if (tryLabel(6, y - 8, ll, 8.5, "left")) {
              pillLabel(ctx, ll, 6, y - 8, color + (faded ? "0.55)" : "0.95)"), color + "0.5)", "left", 8.5);
            }
            break;
          }
          case "momentum": {
            // v17.1 — the momentum ribbon (user: "মার্কেট মোমেন্টাম ও মার্কেট
            // স্ট্রাকচার ভালো ভাবে ড্রয়িং হচ্ছে না"): a per-bar velocity
            // strip above the time axis + the two state pills — structure
            // trend and momentum state, both DRAWN instead of buried in the
            // engine. Ribbon: strong/mild bull green, strong/mild bear red,
            // flat gray — reads like a heartbeat of the market.
            let axisH = 26;
            try {
              // (chartRef re-read locally — the hoisted renderAuto can't
              // inherit drawOverlay's non-null narrowing)
              const ch = chartRef.current;
              axisH = ch ? (ch.timeScale() as { height?: () => number }).height?.() ?? 26 : 26;
            } catch { /* older builds — the 26px default stands */ }
            const laneH = 7;
            const y0 = h - axisH - laneH - 2;
            if (y0 > 40) {
              // backing lane — the strip reads as its own lane even over
              // the volume histogram's baseline
              ctx.fillStyle = isDark ? "rgba(8,12,10,0.62)" : "rgba(250,249,246,0.72)";
              ctx.fillRect(0, y0, rightEdge, laneH);
              hardSeg(ctx, 0, y0 + laneH + 0.5, rightEdge, y0 + laneH + 0.5, isDark ? "rgba(34,48,41,0.9)" : "rgba(220,216,205,0.9)", "transparent", 0.5);
              const cellW = Math.max(1.5, Math.min(barSpacing, 10));
              for (const b of d.bars) {
                const x = xOfTime(b.t);
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
            // the two state pills — top-left, under the OHLC legend
            if (!bareRef.current) {
              const py = 30;
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
            break;
          }
          case "path": {
            const yA = yOfPrice(d.from_price);
            const yB = yOfPrice(d.to_price);
            if (yA === null || yB === null) return;
            const xA = rightEdge - 110;
            const xB = rightEdge - 46;
            ctx.save();
            ctx.setLineDash([1.5, 3.5]);
            hardSeg(ctx, xA, yA, xB, yB, "rgba(245,158,11,0.7)", "rgba(245,158,11,0.06)", 1);
            ctx.restore();
            const dir = d.to_price > d.from_price ? "up" : "down";
            arrow(ctx, xB, yB, dir, "rgba(245,158,11,0.85)", "rgba(245,158,11,0.2)", 6);
            break;
          }
          case "pattern": {
            // v16.6 — the classic chart-pattern recipe (ref D-072, the
            // studied channel's drawing style): numbered swing circles,
            // thin geometry lines + dashed neckline, whisper shading, ENTRY
            // ring + gold dashed line, red dashed SL, gold TARGET band,
            // breakout arrow, name pill with family/state — the on-chart
            // answer to "reversal নাকি continuation, কত দূর যাবে"
            const pt = d.tone === "bull" ? TONES.bull : TONES.bear;
            const gold = TONES.gold;
            // 1. whisper body shading (candles stay loud)
            if (d.zone) {
              const yA = yOfPrice(d.zone.hi);
              const yB = yOfPrice(d.zone.lo);
              const xRaw = xOfTime(d.zone.t);
              if (yA !== null && yB !== null && Math.abs(yB - yA) > 1 && xRaw !== null) {
                const zx = Math.max(-2, xRaw);
                if (zx <= rightEdge) {
                  ctx.fillStyle = pt.fill(0.035);
                  ctx.fillRect(zx, Math.min(yA, yB), rightEdge - zx, Math.abs(yB - yA));
                }
              }
            }
            // 1b. v17.1 → v18.0 — converging boundary patterns (TRIANGLE /
            //     WEDGE / PENNANT) fill the area BETWEEN their two boundary
            //     lines ALL THE WAY to the convergence point (the apex),
            //     exactly like the user's reference screenshots: the coil
            //     reads as a triangle SHAPE, not two sticks. Parallel sides
            //     (RECTANGLE) extend the fill a third of the remaining chart.
            if (
              (d.name.includes("TRIANGLE") || d.name.includes("WEDGE") || d.name.includes("PENNANT") || d.name.includes("RECTANGLE")) &&
              (d.lines ?? []).length >= 2
            ) {
              const [gA, gB] = d.lines;
              const ax1 = xOfTime(gA.t1), ax2 = xOfTime(gA.t2);
              const ay1 = yOfPrice(gA.p1), ay2 = yOfPrice(gA.p2);
              const bx1 = xOfTime(gB.t1), bx2 = xOfTime(gB.t2);
              const by1 = yOfPrice(gB.p1), by2 = yOfPrice(gB.p2);
              if ([ax1, ax2, ay1, ay2, bx1, bx2, by1, by2].every((v) => v !== null)) {
                const cax2 = clamp(ax2!, -2, rightEdge);
                const cbx2 = clamp(bx2!, -2, rightEdge);
                const maxX2 = Math.max(cax2, cbx2);
                // project both lines forward in pixels and find the apex
                const sA = (ay2! - ay1!) / Math.max(1e-6, ax2! - ax1!);
                const sB = (by2! - by1!) / Math.max(1e-6, bx2! - bx1!);
                let endX = clamp(maxX2 + 0.3 * Math.max(30, rightEdge - maxX2), maxX2, rightEdge);
                if (Math.abs(sA - sB) > 1e-6) {
                  const apexX = (by2! - ay2! + sA * cax2 - sB * cbx2) / (sA - sB);
                  if (apexX > maxX2) endX = clamp(apexX, maxX2, rightEdge);
                }
                if (endX > maxX2 + 1) {
                  const yAe = ay2! + sA * (endX - cax2);
                  const yBe = by2! + sB * (endX - cbx2);
                  ctx.save();
                  ctx.beginPath();
                  ctx.moveTo(clamp(ax1!, -2, rightEdge), ay1!);
                  ctx.lineTo(cax2, ay2!);
                  ctx.lineTo(endX, yAe);
                  ctx.lineTo(endX, yBe);
                  ctx.lineTo(cbx2, by2!);
                  ctx.lineTo(clamp(bx1!, -2, rightEdge), by1!);
                  ctx.closePath();
                  ctx.fillStyle = pt.fill(0.07);
                  ctx.fill();
                  ctx.restore();
                } else {
                  ctx.save();
                  ctx.beginPath();
                  ctx.moveTo(clamp(ax1!, -2, rightEdge), ay1!);
                  ctx.lineTo(cax2, ay2!);
                  ctx.lineTo(cbx2, by2!);
                  ctx.lineTo(clamp(bx1!, -2, rightEdge), by1!);
                  ctx.closePath();
                  ctx.fillStyle = pt.fill(0.07);
                  ctx.fill();
                  ctx.restore();
                }
              }
            }
            // 2. geometry lines — thin hard cores, dashed for necklines.
            //    v18.0 (reference images): the BOUNDARY-family sides (the
            //    two trendlines of a triangle / wedge / rectangle) PROJECT
            //    FORWARD as solid faded rays — the reference screenshots
            //    draw the pattern's lines well past the last candle so the
            //    apex sits ahead of price where the decision happens.
            const boundaryFam = d.family === "boundary";
            for (const g of d.lines ?? []) {
              const gx1 = xOfTime(g.t1), gx2 = xOfTime(g.t2), gy1 = yOfPrice(g.p1), gy2 = yOfPrice(g.p2);
              if ([gx1, gx2, gy1, gy2].some((v) => v === null)) continue;
              if (gx1! > rightEdge || gx2! < -2) continue;
              hardSeg(ctx, clamp(gx1!, -2, rightEdge), gy1!, clamp(gx2!, -2, rightEdge), gy2!,
                pt.line(0.85), pt.halo(0.06), 0.7, g.dash ? [4, 3] : []);
              // dashed neckline/boundary extended ahead of price — the
              // live trigger line stays visible where the decision happens
              if (g.dash && gx2! <= rightEdge) {
                const gslope = (gy2! - gy1!) / Math.max(1, gx2! - gx1!);
                const gye = gy2! + gslope * (rightEdge - gx2!);
                hardSeg(ctx, gx2!, gy2!, rightEdge, gye, pt.line(0.4), "transparent", 0.5, [4, 3]);
              }
              // v18.0: solid boundary sides project as rays to the right
              // edge — the visible corridor/apex ahead of price
              if (boundaryFam && !g.dash && gx2! <= rightEdge && gx2! > 0) {
                const gslope = (gy2! - gy1!) / Math.max(1, gx2! - gx1!);
                const gye = gy2! + gslope * (rightEdge - gx2!);
                hardSeg(ctx, gx2!, gy2!, rightEdge, gye, pt.line(0.5), "transparent", 0.6);
              }
            }
            // 3. numbered swing circles 1..N (the structure walk)
            for (const p of d.points) {
              const x = xOfTime(p.t);
              const y = yOfPrice(p.price);
              if (x === null || y === null || x < -6 || x > rightEdge + 6) continue;
              const cy = p.kind === "high" ? y - 10 : y + 10;
              ctx.save();
              ctx.beginPath();
              ctx.arc(x, cy, 5.5, 0, Math.PI * 2);
              ctx.fillStyle = "rgba(13,17,23,0.85)";
              ctx.fill();
              ctx.strokeStyle = pt.line(0.9);
              ctx.lineWidth = 0.8;
              ctx.stroke();
              ctx.restore();
              hardText(ctx, String(p.n), x, cy + 0.5, pt.text, 8, "center");
            }
            // tag anchor — NEXT TO THE PATTERN, not the right-edge strip
            const headP = d.points[d.points.length - 1];
            const xH = headP ? xOfTime(headP.t) : null;
            const xAnchor = Math.min(xH ?? rightEdge - 84, rightEdge - 84) + 8;
            // v16.10 → v18.0 (user reference images — "মাল্টিপল সেটাপ"):
            // the trade-plan ink (ENTRY / STOP / TARGET + the measured-move
            // vertical) now renders for FORMING patterns too — the
            // reference cheat-sheet labels entry/stop/target on every
            // pattern BEFORE the breakout; that is what makes it a SETUP.
            // The clutter lesson stays: a per-frame budget (patternPlanN)
            // caps plans at TWO patterns (confirmed render first in the
            // array and get the loud gold contract; forming get the same
            // levels in thin dotted ink), so the hero setup box keeps the
            // loudest voice on the chart.
            const confirmed = d.state === "confirmed";
            const drawPlan = patternPlanN < 2;
            if (drawPlan) patternPlanN++;
            // plan lines START at the pattern's birth, never x=0 full width
            const firstPx = d.points[0] ? xOfTime(d.points[0].t) : null;
            const planX0 = clamp(firstPx ?? xAnchor, 2, rightEdge - 10);
            // 4. ENTRY — gold ring at the trigger + dashed level line + tag
            //    (forming: thin dotted, dimmer — the setup being prepared)
            const yE = drawPlan ? yOfPrice(d.entry.price) : null;
            if (yE !== null && yE > -5 && yE < h + 5) {
              const xE0 = d.entry.t != null ? xOfTime(d.entry.t) : xH;
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
              if (tryLabel(xAnchor, d.dir === "up" ? yE + 11 : yE - 4, `ENTRY ${d.entry.price.toFixed(digits)}`, 8, "left")) {
                pillLabel(ctx, `ENTRY ${d.entry.price.toFixed(digits)}`, xAnchor, d.dir === "up" ? yE + 11 : yE - 4,
                  confirmed ? gold.text : "rgba(230,190,70,0.75)", gold.line(confirmed ? 0.5 : 0.3), "left", 8);
              }
            }
            // 5. STOP-LOSS — thin red dashed line + tag. v18.0: the tag sits
            //    on the side AWAY from the entry line (down patterns: above
            //    the SL; up patterns: below it) — the old yS+12 always put
            //    the down-pattern SL tag into the entry↔SL gap where it
            //    fought the ENTRY pill (VLM audit: obscured SL label).
            const yS = drawPlan ? yOfPrice(d.sl) : null;
            if (yS !== null && yS > -5 && yS < h + 5) {
              hardSeg(ctx, planX0, Math.round(yS) + 0.5, rightEdge, Math.round(yS) + 0.5,
                confirmed ? "rgba(248,113,113,0.72)" : "rgba(248,113,113,0.45)", "rgba(248,113,113,0.05)", confirmed ? 0.55 : 0.45, [2.5, 3.5]);
              const slLy = d.dir === "down" ? yS - 4 : yS + 12;
              if (tryLabel(xAnchor, slLy, `SL ${d.sl.toFixed(digits)}`, 8, "left")) {
                pillLabel(ctx, `SL ${d.sl.toFixed(digits)}`, xAnchor, slLy,
                  confirmed ? "rgba(252,165,165,0.95)" : "rgba(252,165,165,0.7)", "rgba(248,113,113,0.5)", "left", 8);
              }
            }
            // 6. TARGET — whisper green band + dashed line + tag.
            //    v18.0: TARGET reads GREEN (profit direction — the same
            //    coding as the hero setup's TP), so the three plan levels
            //    answer at a glance: gold = pay, red = pain, green = gain.
            const yT1 = drawPlan ? yOfPrice(d.target_zone.lo) : null;
            const yT2 = drawPlan ? yOfPrice(d.target_zone.hi) : null;
            if (yT1 !== null && yT2 !== null && Math.abs(yT2 - yT1) > 0.5) {
              ctx.fillStyle = confirmed ? "rgba(52,211,153,0.05)" : "rgba(52,211,153,0.03)";
              ctx.fillRect(rightEdge - 64, Math.min(yT1, yT2), 64, Math.abs(yT2 - yT1));
            }
            const yT = drawPlan ? yOfPrice(d.target) : null;
            if (yT !== null && yT > -5 && yT < h + 5) {
              hardSeg(ctx, planX0, Math.round(yT) + 0.5, rightEdge, Math.round(yT) + 0.5,
                confirmed ? "rgba(52,211,153,0.8)" : "rgba(52,211,153,0.45)", "transparent", confirmed ? 0.6 : 0.45, [2, 3]);
              const rrTxt = d.rr != null ? ` · RR ${d.rr.toFixed(1)}` : "";
              if (tryLabel(rightEdge - 4, yT - 8, `TARGET ${d.target.toFixed(digits)}${rrTxt}`, 8, "right")) {
                pillLabel(ctx, `TARGET ${d.target.toFixed(digits)}${rrTxt}`, rightEdge - 4, yT - 8,
                  confirmed ? "rgba(167,243,208,0.95)" : "rgba(167,243,208,0.7)", "rgba(52,211,153,0.5)", "right", 8);
              }
            }
            // 6b. v18.0 — the MEASURED-MOVE VERTICAL (the reference
            //     cheat-sheet's signature element): a dashed vertical from
            //     the ENTRY level to the TARGET level with bracket caps and
            //     an arrowhead at the target — the projected distance drawn
            //     to scale, so "reversal হলে কত দূর যাবে" is answered by
            //     geometry. SKY-CYAN like the reference's blue connectors:
            //     green ink over green candles camouflages (VLM audit), the
            //     measurement color must contrast with the candles.
            if (drawPlan && yE !== null && yT !== null && Math.abs(yT - yE) > 6) {
              // anchor: the breakout candle when it is ON SCREEN; else the
              // pattern's last pivot +2 bars (a confirmed breakout that
              // scrolled off-screen must not strand the bracket at x=4)
              const xV0 = d.entry.t != null ? xOfTime(d.entry.t) : null;
              const onScreen = xV0 != null && xV0 >= 8 && xV0 <= rightEdge - 8;
              const xV = clamp(
                onScreen ? xV0! : ((xH ?? rightEdge - 40) + barSpacing * 2),
                4, rightEdge - 4,
              );
              const mvA = confirmed ? 0.85 : 0.5;
              const mvCol = `rgba(56,189,248,${mvA})`;
              hardSeg(ctx, xV, yE, xV, yT, mvCol, "transparent", 0.7, [4, 3]);
              // bracket caps at both levels — the |—| measurement grammar
              hardSeg(ctx, xV - 4, yE, xV + 4, yE, mvCol, "transparent", 0.7);
              hardSeg(ctx, xV - 4, yT, xV + 4, yT, mvCol, "transparent", 0.7);
              arrow(ctx, xV, yT, d.dir, mvCol, "rgba(56,189,248,0.15)", 5);
            }
            // 7. breakout arrow once price CLOSED through the trigger
            if (d.state === "confirmed" && d.breakout_t != null) {
              const xb = xOfTime(d.breakout_t);
              if (xb != null && xb >= 0 && xb <= rightEdge) {
                const yb = yOfPrice(d.entry.price);
                if (yb !== null) {
                  arrow(ctx, Math.min(xb + 10, rightEdge - 14), d.dir === "up" ? yb - 18 : yb + 18, d.dir,
                    d.dir === "up" ? "rgba(52,211,153,0.95)" : "rgba(248,113,113,0.95)",
                    d.dir === "up" ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)", 6);
                }
              }
            }
            // 8. name pill at the pattern's first point — family + state.
            //    v18.0: compact form on narrow charts (mobile) and no
            //    forced collision win — a phone screen cannot afford the
            //    full "NAME · FAMILY · STATE · TF" sentence
            const firstP = d.points[0];
            if (firstP) {
              const x0 = xOfTime(firstP.t);
              const y0 = yOfPrice(firstP.price);
              if (x0 !== null && y0 !== null && x0 >= -4 && x0 <= rightEdge) {
                const fam = d.family === "reversal" ? "REVERSAL" : d.family === "continuation" ? "CONTINUATION" : "BOUNDARY";
                const nm = narrow
                  ? `${d.name} · ${d.state === "confirmed" ? "✓" : "FORMING"}`
                  : `${d.name} · ${fam} · ${d.state === "confirmed" ? "✓ CONFIRMED" : "FORMING"}${d.source_tf ? " · " + d.source_tf : ""}`;
                const ty = firstP.kind === "high" ? y0 - 22 : y0 + 22;
                if (tryLabel(x0, ty, nm, 8.5, "left", !narrow)) {
                  pillLabel(ctx, nm, x0, ty,
                    d.state === "confirmed" ? pt.text : "rgba(226,232,230,0.9)",
                    d.state === "confirmed" ? pt.line(0.55) : "rgba(148,163,158,0.4)", "left", 8.5);
                }
              }
            }
            break;
          }
          case "tf_setup": {
            // v16.7 — ANOTHER timeframe's own entry setup (user spec:
            // "প্রত্যেক টাইম ফ্রেমের জন্য আলাদা আলাদা এন্ট্রি সেটাপ"): a thin
            // TF-colored entry rail over the recent action + SL/TP whiskers
            // + ONE compact TF-tagged contract badge. Live signals solid,
            // plans dotted — thin crisp ink, never louder than the hero box.
            const TF_INK: Record<string, [number, number, number]> = {
              M1: [244, 114, 182], M5: [251, 191, 36], M15: [52, 211, 153],
              M30: [251, 146, 60], H1: [45, 212, 191], H4: [251, 113, 133],
            };
            const [ir, ig, ib] = TF_INK[d.tf] ?? [226, 232, 230];
            const ink = (a: number) => `rgba(${ir},${ig},${ib},${a})`;
            const yE = yOfPrice(d.entry);
            const yS = yOfPrice(d.sl);
            const yT = yOfPrice(d.tp);
            if (yE === null || yE < -8 || yE > h + 8) return;
            const live = d.status === "signal";
            const x0 = Math.max(2, rightEdge - Math.max(140, barSpacing * 24));
            // entry rail — thin and crisp (0.8px), solid live · dotted planned
            hardSeg(ctx, x0, yE, rightEdge, yE, ink(live ? 0.85 : 0.55), ink(0.05), 0.8, live ? [] : [2, 3]);
            // tiny TF tick at the rail's start — the eye can follow it in
            hardText(ctx, d.tf, x0 + 2, yE - 5, ink(live ? 0.9 : 0.62), 7, "left", 700);
            // SL/TP whiskers — short, dimmer, dashed
            const wx = rightEdge - 64;
            if (yS !== null && yS > -8 && yS < h + 8) {
              hardSeg(ctx, wx, yS, rightEdge, yS, `rgba(248,113,113,${live ? 0.42 : 0.28})`, "transparent", 0.55, [2, 3]);
            }
            if (yT !== null && yT > -8 && yT < h + 8) {
              hardSeg(ctx, wx, yT, rightEdge, yT, `rgba(52,211,153,${live ? 0.42 : 0.28})`, "transparent", 0.55, [2, 3]);
            }
            // ONE compact contract badge — TF · dir · entry, SL/TP below it
            const verb = live ? "SIG" : "PLAN";
            const arrowCh = d.dir === "BUY" ? "▲" : "▼";
            const l1 = `${d.tf} ${arrowCh}${verb} ${d.entry.toFixed(digits)}`;
            const l2 = `SL ${d.sl.toFixed(digits)} · TP ${d.tp.toFixed(digits)} · ${d.rr.toFixed(1)}R`;
            let by = yE + 11;
            if (!tryLabel(rightEdge - 4, by, l1, 8, "right")) by = yE - 11;
            tryLabel(rightEdge - 4, by, l1, 8, "right", true);
            badgeTag(rightEdge, by, l1, `rgb(${ir},${ig},${ib})`, "rgba(13,17,23,0.88)", ink(0.5), !live, 8);
            if (tryLabel(rightEdge - 4, by + 10, l2, 7, "right", true)) {
              hardText(ctx, l2, rightEdge - 4, by + 10, `rgba(200,208,214,${live ? 0.8 : 0.58})`, 7, "right", 600);
            }
            break;
          }
        }
      }

      // ── EMA ribbon ──
      if (layersRef.current.ema) {
        // v16.8 (user audit): the forming candle's LIVE close drives the last
        // EMA point — the ribbon used the last socket-bar close and visibly
        // lagged the tick during the whole forming candle.
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
              hardSeg(ctx, pts[0].x!, pts[0].y!, ex, ey, color, "rgba(226,232,230,0.08)", 0.7);
              // keep original segment solid
              hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color, "rgba(226,232,230,0.08)", 0.7);
            } else {
              hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color, "rgba(226,232,230,0.08)", 0.7);
            }
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            break;
          }
          case "hline": {
            if (pts.length < 1 || pts[0].y === null) break;
            const y = pts[0].y!;
            hardSeg(ctx, 0, y, rightEdge, y, color, "rgba(226,232,230,0.08)", 0.7);
            hardText(ctx, `${pts[0].p.toFixed(digits)}`, rightEdge - 4, y - 7, color, 8, "right");
            hit.pts.push({ x: 80, y });
            hit.rects.push({ x1: 0, y1: y - 5, x2: rightEdge, y2: y + 5 });
            break;
          }
          case "vline": {
            if (pts.length < 1 || pts[0].x === null) break;
            const x = pts[0].x!;
            hardSeg(ctx, x, 0, x, h, color, "rgba(226,232,230,0.08)", 0.7);
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
            // v17.1 — the 3-anchor triangle tool: closed polygon + whisper
            // fill, three draggable vertices, bounding-box hit target
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
              hardSeg(ctx, Math.min(pts[0].x!, pts[1].x!), y, rightEdge, y,
                golden ? "rgba(245,158,11,0.8)" : "rgba(226,232,230,0.4)",
                "rgba(226,232,230,0.05)", golden ? 0.65 : 0.5);
              hardText(ctx, `${r.toFixed(3)}  ${price.toFixed(digits)}`, rightEdge - 4, y - 7,
                golden ? "rgba(251,191,36,0.9)" : "rgba(178,190,185,0.7)", 8, "right");
            }
            hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, "rgba(226,232,230,0.5)", "rgba(226,232,230,0.04)", 0.55);
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
          // two vertices placed → live closed-shape preview following the cursor
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
          const bars = Math.round((move.t - a1.t) / tf);
          hardText(
            ctx,
            `${dp >= 0 ? "+" : ""}${dp.toFixed(digits)} (${pct.toFixed(2)}%) · ${Math.abs(bars)} bars`,
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
        const by = 24;
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
    // v17.0: ink filter changes (level budget / HTF / faded / merged toggles)
    // re-filter the SAME drawings — an immediate repaint, no data refetch
  }, [bars, autoDrawings, userDrawings, layers, inkFilters, selectedId, signals, emaArrays, symbol, timeframe, drawOverlay, scheduleRedraw]);

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
        // v17.1 — the triangle tool is THREE-anchor: first tap = vertex 1,
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
      // v17.0 — merge-rationale tooltip: the topmost clustered level band
      // under the cursor carries the story (what was merged into it). The
      // tip is keyed by band identity so mouse travel inside one band does
      // not re-render; leaving every band clears it.
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let found: LevelTip | null = null;
      const bands = tipRef.current;
      for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i];
        if (mx >= b.x1 && mx <= b.x2 && my >= b.y1 && my <= b.y2) {
          found = b;
          break;
        }
      }
      if (found) {
        const f = found;
        const key = `${f.title}|${f.price}`;
        const vw = rect.width;
        const vh = rect.height;
        setTip((prev) =>
          prev && prev.key === key
            ? prev
            : { key, x: mx, y: my, vw, vh, title: f.title, price: f.price, sourceTf: f.sourceTf, mergedFrom: f.mergedFrom },
        );
      } else {
        setTip((prev) => (prev ? null : prev));
      }
    };
    const onHostLeave = () => setTip(null);

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    host.addEventListener("mousemove", onContainerMove);
    host.addEventListener("mouseleave", onHostLeave);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("mousemove", onContainerMove);
      host.removeEventListener("mouseleave", onHostLeave);
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

      {/* v17.0 — MERGE-RATIONALE TOOLTIP: hover a clustered level (×N badge)
          to see exactly which sources agreed on that price and which one won
          the priority hierarchy (HTF key level > fresh OB/FVG > local S/R) */}
      {tip && (
        <div
          className="pointer-events-none absolute z-30 w-52 rounded-md border border-border bg-popover/95 p-2 shadow-lg backdrop-blur-sm"
          style={{
            left: Math.min(Math.max(tip.x - 216, 4), Math.max(4, tip.vw - 216)),
            top: Math.min(Math.max(tip.y + 12, 4), Math.max(4, tip.vh - 110)),
          }}
          role="tooltip"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[10px] font-bold uppercase tracking-wider text-foreground">{tip.title}</span>
            <span className="tnum shrink-0 font-mono text-[10px] font-bold text-gold">{tip.price}</span>
          </div>
          {tip.sourceTf && (
            <div className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              source TF · {tip.sourceTf}
            </div>
          )}
          {tip.mergedFrom?.length ? (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {t("mergedLevels")}
              </div>
              <ul className="mt-0.5 space-y-px">
                {tip.mergedFrom.map((m, i) => (
                  <li key={i} className="flex items-start gap-1 text-[9px] leading-snug text-muted-foreground">
                    <span className="mt-px shrink-0 text-gold/80">≡</span>
                    <span className="truncate">{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

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


