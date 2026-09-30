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
  | "fib"
  | "text"
  | "measure";

export type MainTab = "home" | "chart" | "auto" | "settings";
export type ChartView = "price" | "flow" | "xray";
export type AutoView = "brain" | "signals" | "backtest";
export interface Layers {
  ema: boolean;
  killzones: boolean;
  zones: boolean;
  levels: boolean;
  structure: boolean;
  volume: boolean;
  setup: boolean;
  signals: boolean;
  ai: boolean;
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
  ema: true, killzones: true, zones: true, levels: true,
  structure: true, volume: true, setup: true, signals: true, ai: true,
};

const savedLayers = (): Layers => {
  if (typeof window === "undefined") return DEFAULT_LAYERS;
  try {
    const raw = localStorage.getItem("aurum-layers");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layers>;
      // migrate: old `smc` key → zones+levels+structure+setup
      const smc = (parsed as Record<string, unknown>).smc;
      if (typeof smc === "boolean" && !("zones" in parsed)) {
        parsed.zones = parsed.levels = parsed.structure = parsed.setup = smc;
      }
      return { ...DEFAULT_LAYERS, ...parsed };
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
  if (typeof window === "undefined") return "brain";
  try {
    const v = localStorage.getItem("aurum-auto-view") as AutoView | null;
    if (v === "brain" || v === "signals" || v === "backtest") return v;
  } catch {}
  return "brain";
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
