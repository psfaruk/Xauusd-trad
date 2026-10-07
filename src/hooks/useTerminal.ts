"use client";

/** Terminal UI state — low-frequency (symbol, tf, tools, layers, tabs).
 *
 *  4 main tabs (Binance-style): home · chart · auto · settings
 *    chart → view: price (candles) | flow (area trio) | xray (order-flow)
 *    auto  → view: brain | signals | backtest
 */

import { create } from "zustand";

export type ToolId =
  | "cursor"
  | "trendline"
  | "ray"
  | "hline"
  | "vline"
  | "rect"
  | "triangle"
  | "fib"
  | "text"
  | "measure";

export type MainTab = "home" | "chart" | "auto" | "settings";
export type ChartView = "price" | "flow" | "xray";
export type AutoView = "board" | "brain" | "signals" | "backtest";
/** v21.0 — the CLEAN layer set. The old set (zones / momentum / narrative /
 *  ai levels) fed the 19-kind auto-ink pipeline the user called
 * "এলোমেলো" — that pipeline is deleted; what remains is exactly what a
 * clean trading chart needs, each layer earning its ink on demand. */
export interface Layers {
  ema: boolean;
  killzones: boolean;
  /** swing pivots (HH/HL/LH/LL) + the single zigzag spine */
  structure: boolean;
  /** the two key levels: nearest R above + nearest S below */
  levels: boolean;
  volume: boolean;
  /** the AI Board's decision ink — entry/SL/TP + OB + trendline */
  setup: boolean;
  /** BUY/SELL signal markers on the candles */
  signals: boolean;
}

interface TerminalState {
  symbol: string;
  timeframe: string;
  mainTab: MainTab;
  chartView: ChartView;
  autoView: AutoView;
  tool: ToolId;
  layers: Layers;
  selectedSignalId: string | null;
  setSymbol: (s: string) => void;
  setTimeframe: (tf: string) => void;
  setMainTab: (t: MainTab) => void;
  setChartView: (v: ChartView) => void;
  setAutoView: (v: AutoView) => void;
  /** Home/watchlist convenience: pick a symbol AND land on the chart */
  openChart: (symbol?: string) => void;
  setTool: (t: ToolId) => void;
  toggleLayer: (k: keyof Layers) => void;
  setSelectedSignalId: (id: string | null) => void;
}

const DEFAULT_LAYERS: Layers = {
  ema: true, killzones: true, structure: true, levels: true,
  volume: true, setup: true, signals: true,
};

const savedLayers = (): Layers => {
  if (typeof window === "undefined") return DEFAULT_LAYERS;
  try {
    const raw = localStorage.getItem("aurum-layers");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layers>;
      // v21 migration: drop the retired layer keys — only the clean set ships
      const { zones: _z, momentum: _m, narrative: _n, ai: _a, ...keep } = parsed as Record<string, unknown>;
      void _z; void _m; void _n; void _a;
      return { ...DEFAULT_LAYERS, ...(keep as Partial<Layers>) };
    }
  } catch {}
  return DEFAULT_LAYERS;
};

/** persisted chart view (migrates the old aurum-chart-type "area" value) */
const savedChartView = (): ChartView => {
  if (typeof window === "undefined") return "price";
  try {
    const v = localStorage.getItem("aurum-chart-view") as ChartView | null;
    if (v === "price" || v === "flow" || v === "xray") return v;
    // migration: old key held "area" (the trio view)
    if (localStorage.getItem("aurum-chart-type") === "area") return "flow";
  } catch {}
  return "price";
};

const savedAutoView = (): AutoView => {
  if (typeof window === "undefined") return "board";
  try {
    const v = localStorage.getItem("aurum-auto-view") as AutoView | null;
    if (v === "board" || v === "brain" || v === "signals" || v === "backtest") return v;
  } catch {}
  return "board";
};

export const useTerminal = create<TerminalState>((set, get) => ({
  symbol: "XAUUSDm",
  timeframe: "M15",
  mainTab: "chart",
  chartView: savedChartView(),
  autoView: savedAutoView(),
  tool: "cursor",
  layers: savedLayers(),
  selectedSignalId: null,
  setSymbol: (symbol) => set({ symbol, selectedSignalId: null }),
  setTimeframe: (timeframe) => set({ timeframe }),
  setMainTab: (mainTab) => set({ mainTab }),
  setChartView: (chartView) => {
    try { localStorage.setItem("aurum-chart-view", chartView); } catch {}
    set({ chartView });
  },
  setAutoView: (autoView) => {
    try { localStorage.setItem("aurum-auto-view", autoView); } catch {}
    set({ autoView });
  },
  openChart: (symbol) => {
    if (symbol) get().setSymbol(symbol);
    set({ mainTab: "chart" });
  },
  setTool: (tool) => set({ tool }),
  toggleLayer: (k) => {
    const layers = { ...get().layers, [k]: !get().layers[k] };
    try {
      localStorage.setItem("aurum-layers", JSON.stringify(layers));
    } catch {}
    set({ layers });
  },
  setSelectedSignalId: (selectedSignalId) => set({ selectedSignalId }),
}));
