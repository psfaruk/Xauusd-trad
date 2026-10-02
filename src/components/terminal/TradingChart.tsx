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
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { feed, useBars, restUrl } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { SIGNAL_EXPIRY_BARS } from "@/lib/market/engine";
import type {
  AutoDrawing,
  Candle,
  SignalPayload,
  UserDrawing,
} from "@/lib/market/types";
import type { Layers, ToolId } from "@/hooks/useTerminal";
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
  move?: { x: number; y: number; t: number; p: number };
}

export default function TradingChart(props: Props) {
  const {
    symbol, timeframe, digits, layers, tool, onToolDone,
    autoDrawings, signals, selectedSignalId,
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
  const autoRef = useRef(autoDrawings);
  const userRef = useRef(userDrawings);
  const layersRef = useRef(layers);
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
        axisDoubleClick: { time: true, price: true },
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
      .map((s) => ({
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
    const lastTime = bs[bs.length - 1].t;
    const barSpacing = ts.options().barSpacing ?? 6.5;

    const xOfTime = (t: number): number | null => {
      const x = ts.timeToCoordinate(t as UTCTimestamp);
      if (x !== null) return x;
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
            { name: "NY·AM", s: 12, e: 15, gold: true },
            { name: "NY·PM", s: 15.5, e: 17, gold: false },
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
      const LAYER_OF: Record<string, keyof Layers> = {
        setup: "setup",
        zone: "zones",
        hline: "levels",
        liq: "levels",
        magnet: "levels",
        structure: "structure",
        zigzag: "structure",
        swing: "structure",
        trendline: "structure",
        channel: "structure",
        fib: "structure",
        sweep: "structure",
        pattern: "structure",
        arrow: "structure",
        path: "structure",
      };
      for (const d of autoRef.current) {
        const layer = LAYER_OF[d.kind] ?? "zones";
        if (!layersRef.current[layer]) continue;
        try { renderAuto(d); } catch (e) { console.warn("[chart] renderAuto failed:", d.kind, e); }
      }

      // ── AI chart-read layer — what the trading brain sees right now ──
      if (layersRef.current.ai) {
        for (const d of aiRef.current) {
          try { renderAuto(d); } catch { /* one bad level must not blank the chart */ }
        }
      }

      function renderAuto(d: AutoDrawing) {
        switch (d.kind) {
          case "hline": {
            const y = yOfPrice(d.price);
            if (y === null) return;
            const tone = TONES[d.tone] ?? TONES.neutral;
            const faded = d.style === "dash";
            hardSeg(ctx, 0, y, rightEdge, y, tone.line(faded ? 0.45 : 0.9), tone.halo(0.08), 0.85, faded ? [4, 4] : []);
            if (tryLabel(rightEdge - 4, y - 8, d.label, 8.5, "right")) {
              pillLabel(ctx, d.label, rightEdge - 4, y - 8, tone.text, tone.line(0.5), "right", 8.5);
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
            const alphaMul = d.state === "faded" ? 0.32 : 1;
            ctx.globalAlpha = alphaMul;
            ctx.fillStyle = st.fill;
            ctx.fillRect(x0, Math.min(y1, y2), rightEdge - x0, Math.abs(y2 - y1));
            hardSeg(ctx, x0, y1, rightEdge, y1, st.border, st.halo, 0.9);
            hardSeg(ctx, x0, y2, rightEdge, y2, st.border, st.halo, 0.9);
            const sideName: Record<string, string> = {
              supply: "SUPPLY", demand: "DEMAND", ob_bull: "OB+", ob_bear: "OB−",
              fvg_bull: "FVG+", fvg_bear: "FVG−",
            };
            const zl = `${sideName[d.side] ?? d.side}${d.source_tf ? " · " + d.source_tf : ""}`;
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
            const alpha = faded ? 0.32 : 0.88;
            // project to right edge
            const slope = (y2! - y1!) / Math.max(1, x2! - x1!);
            const xe = rightEdge;
            const ye = y1! + slope * (xe - x1!);
            hardSeg(ctx, x1!, y1!, xe, ye, tone.line(alpha), tone.halo(0.07), 0.7, faded ? [3, 4] : []);
            break;
          }
          case "channel": {
            const draw = (l: { t1: number; p1: number; t2: number; p2: number }) => {
              const x1 = xOfTime(l.t1), x2 = xOfTime(l.t2), y1 = yOfPrice(l.p1), y2 = yOfPrice(l.p2);
              if ([x1, x2, y1, y2].some((v) => v === null)) return;
              const slope = (y2! - y1!) / Math.max(1, x2! - x1!);
              const ye = y1! + slope * (rightEdge - x1!);
              hardSeg(ctx, x1!, y1!, rightEdge, ye, TONES.neutral.line(0.6), TONES.neutral.halo(0.06), 0.55);
            };
            draw(d.upper);
            draw(d.lower);
            draw({ t1: (d.upper.t1 + d.lower.t1) / 2, p1: (d.upper.p1 + d.lower.p1) / 2, t2: (d.upper.t2 + d.lower.t2) / 2, p2: (d.upper.p2 + d.lower.p2) / 2 });
            break;
          }
          case "fib": {
            const x0 = xOfTime(d.t0);
            const xA = xOfTime(d.t1);
            const y0 = yOfPrice(d.p0);
            const yA = yOfPrice(d.p1);
            if ([x0, xA, y0, yA].some((v) => v === null)) return;
            hardSeg(ctx, x0!, y0!, xA!, yA!, TONES.gold.line(0.5), TONES.gold.halo(0.05), 0.6);
            const golden = [0.618, 0.786];
            const gp: number[] = [];
            for (const lv of d.levels) {
              const y = y0! + (yA! - y0!) * lv.ratio;
              if (y === null) continue;
              const isGolden = golden.includes(lv.ratio);
              hardSeg(
                ctx, Math.max(x0!, xA!), y, rightEdge, y,
                TONES.gold.line(isGolden ? 0.75 : 0.42),
                TONES.gold.halo(isGolden ? 0.07 : 0.04), isGolden ? 0.7 : 0.5,
              );
              hardText(ctx, `${lv.ratio.toFixed(3)}  ${lv.price.toFixed(digits)}`, rightEdge - 4, y - 7, isGolden ? TONES.gold.text : "rgba(148,163,158,0.7)", 8, "right");
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
            const color = d.label === "BOS" ? "rgba(52,211,153,0.9)" : "rgba(245,158,11,0.92)";
            // the break line: from the swing origin to the breaking candle
            // (classic SMC structure-break ink, reads at a glance)
            if (d.fromT != null) {
              const x0 = xOfTime(d.fromT);
              if (x0 !== null) {
                const xa = clamp(x0, -2, rightEdge);
                const xb = clamp(x + 6, xa, rightEdge);
                if (xb > xa) {
                  const bc = d.label === "BOS" ? "52,211,153" : "245,158,11";
                  hardSeg(ctx, xa, y, xb, y, `rgba(${bc},0.55)`, `rgba(${bc},0.04)`, 0.9, [4, 3]);
                }
              }
            }
            diamond(ctx, x, y, color, 4.5, color.replace("0.9", "0.25"), true);
            if (tryLabel(x, y + (d.dir === "up" ? 12 : -12), d.label, 7.5, "center")) {
              hardText(ctx, d.label, x, y + (d.dir === "up" ? 12 : -12), color, 7.5, "center");
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
            ctx.lineWidth = 1.4;
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
            const x = xOfTime(d.t);
            const y = yOfPrice(d.price);
            if (x === null || y === null) return;
            const bull = d.tag === "HH" || d.tag === "HL";
            if (tryLabel(x, y + (d.side === "high" ? -9 : 9), d.tag, 7.5, "center")) {
              hardText(ctx, d.tag, x, y + (d.side === "high" ? -9 : 9), bull ? "rgba(110,231,183,0.9)" : "rgba(252,165,165,0.9)", 7.5, "center");
            }
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
            let xs = xOfTime(d.t0) ?? rightEdge - 24;
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
            hardSeg(ctx, xs, yE, rightEdge, yE, `rgba(230,190,70,${(0.98 * inkM).toFixed(2)})`, "rgba(212,175,55,0.1)", 1.3, waiting ? [2, 3] : []);
            ctx.restore();
            hardSeg(ctx, xs, yS, rightEdge, yS, `rgba(255,120,132,${(0.92 * inkM).toFixed(2)})`, "rgba(248,113,113,0.07)", 1.0, [5, 4]);
            hardSeg(ctx, xs, yT, rightEdge, yT, `rgba(52,211,153,${(0.92 * inkM).toFixed(2)})`, "rgba(52,211,153,0.07)", 1.0, [5, 4]);
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
              // expiry countdown: bars this setup has left to resolve
              const barsSinceSetup = d.t0 ? Math.max(0, Math.floor((bs[bs.length - 1].t - d.t0) / tf)) : 0;
              const barsLeft = Math.max(0, SIGNAL_EXPIRY_BARS - barsSinceSetup);
              const meta = [
                d.entryType === "limit" ? "limit order" : "market entry",
                ageMin !== null ? `${ageMin}m ago` : null,
                d.trigger ? d.trigger.toUpperCase() : null,
                `${t("expires")} ${barsLeft} ${t("bars")}`,
              ].filter(Boolean).join(" · ");
              hardText(ctx, meta, headX, headY + 26, "rgba(164,172,182,0.85)", 8.5, "left", 500);
            }
            break;
          }
          case "magnet": {
            const y = yOfPrice(d.price);
            if (y === null) return;
            hardSeg(ctx, rightEdge - 220, y, rightEdge, y, "rgba(251,191,36,0.6)", "rgba(245,158,11,0.06)", 0.8, [2, 4]);
            const ml = `MAGNET · ${d.source}`;
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
            hardSeg(ctx, 0, y, rightEdge, y, color + (faded ? "0.32)" : "0.72)"), color + "0.06)", 0.85, faded ? [3, 4] : []);
            const state = d.state === "untouched" ? "" : d.state === "swept" ? " · SWEPT" : " · RUN";
            const ll = `${d.side} ${d.price.toFixed(digits)}${state}`;
            if (tryLabel(6, y - 8, ll, 8.5, "left")) {
              pillLabel(ctx, ll, 6, y - 8, color + (faded ? "0.55)" : "0.95)"), color + "0.5)", "left", 8.5);
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
            for (const pt of d.points) {
              const x = xOfTime(pt.t);
              const y = yOfPrice(pt.price);
              if (x === null || y === null) continue;
              ctx.save();
              ctx.beginPath();
              ctx.arc(x, y, 5.5, 0, Math.PI * 2);
              ctx.strokeStyle = "rgba(196,181,253,0.85)";
              ctx.lineWidth = 0.9;
              ctx.stroke();
              ctx.restore();
              hardText(ctx, String(pt.n), x, y, "rgba(221,214,254,0.95)", 7, "center");
            }
            if (d.neckline) {
              const x1 = xOfTime(d.neckline.t1), x2 = xOfTime(d.neckline.t2);
              const y1 = yOfPrice(d.neckline.p1), y2 = yOfPrice(d.neckline.p2);
              if ([x1, x2, y1, y2].every((v) => v !== null)) {
                hardSeg(ctx, x1!, y1!, rightEdge, y2! + (y2! - y1!) * 0.15, "rgba(167,139,250,0.6)", "rgba(167,139,250,0.05)", 0.6, [4, 4]);
              }
            }
            if (d.target != null) {
              const y = yOfPrice(d.target);
              if (y !== null) {
                hardSeg(ctx, rightEdge - 140, y, rightEdge, y, "rgba(245,158,11,0.65)", "rgba(245,158,11,0.05)", 0.7, [2, 3]);
                hardText(ctx, `${d.name} TGT ${d.target.toFixed(digits)}`, rightEdge - 4, y - 7, "rgba(251,191,36,0.85)", 7.5, "right");
              }
            }
            break;
          }
        }
      }

      // ── EMA ribbon ──
      if (layersRef.current.ema) {
        const drawEma = (vals: (number | null)[], color: string, width: number) => {
          ctx.save();
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < bs.length; i++) {
            const v = vals[i];
            if (v == null) continue;
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
        drawEma(emaRef.current.e9, "rgba(52,211,153,0.55)", 0.8);
        drawEma(emaRef.current.e21, "rgba(245,158,11,0.55)", 0.7);
        drawEma(emaRef.current.e50, "rgba(148,163,158,0.5)", 0.7);
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
              hardSeg(ctx, pts[0].x!, pts[0].y!, ex, ey, color, "rgba(226,232,230,0.08)", 0.9);
              // keep original segment solid
              hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color, "rgba(226,232,230,0.08)", 0.9);
            } else {
              hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, color, "rgba(226,232,230,0.08)", 0.9);
            }
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            break;
          }
          case "hline": {
            if (pts.length < 1 || pts[0].y === null) break;
            const y = pts[0].y!;
            hardSeg(ctx, 0, y, rightEdge, y, color, "rgba(226,232,230,0.08)", 0.9);
            hardText(ctx, `${pts[0].p.toFixed(digits)}`, rightEdge - 4, y - 7, color, 8, "right");
            hit.pts.push({ x: 80, y });
            hit.rects.push({ x1: 0, y1: y - 5, x2: rightEdge, y2: y + 5 });
            break;
          }
          case "vline": {
            if (pts.length < 1 || pts[0].x === null) break;
            const x = pts[0].x!;
            hardSeg(ctx, x, 0, x, h, color, "rgba(226,232,230,0.08)", 0.9);
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
            ctx.lineWidth = 0.8;
            ctx.strokeRect(rx, ry, rw, rh);
            hit.pts.push({ x: pts[0].x!, y: pts[0].y! }, { x: pts[1].x!, y: pts[1].y! });
            hit.rects.push({ x1: rx, y1: ry, x2: rx + rw, y2: ry + rh });
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
                "rgba(226,232,230,0.05)", golden ? 0.8 : 0.6);
              hardText(ctx, `${r.toFixed(3)}  ${price.toFixed(digits)}`, rightEdge - 4, y - 7,
                golden ? "rgba(251,191,36,0.9)" : "rgba(178,190,185,0.7)", 8, "right");
            }
            hardSeg(ctx, pts[0].x!, pts[0].y!, pts[1].x!, pts[1].y!, "rgba(226,232,230,0.5)", "rgba(226,232,230,0.04)", 0.7);
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
        if (preview.kind === "trendline" || preview.kind === "ray" || preview.kind === "fib" || preview.kind === "measure") {
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
  }, [bars, autoDrawings, userDrawings, layers, selectedId, signals, emaArrays, symbol, timeframe, drawOverlay]);

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


