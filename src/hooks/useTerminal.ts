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
export type AutoView = "brain" | "signals" | "backtest";
export interface Layers {
  ema: boolean;
  killzones: boolean;
  zones: boolean;
  levels: boolean;
  structure: boolean;
  /** v17.1 — the momentum ribbon + structure/momentum state pills */
  momentum: boolean;
  volume: boolean;
  setup: boolean;
  signals: boolean;
  ai: boolean;
}

/** v17.0 (audit §dedup) — the ink filters: how much auto-ink the chart
 *  shows. Layers are coarse on/off switches; these are the fine controls
 *  for the level-clustering pass: the visible-level budget, HTF-sourced
 *  ink, faded/stale ink, and absorbed merge duplicates. */
export interface InkFilters {
  /** how many clustered level winners show at once (rank-ordered, 1 =
   *  nearest to price) — the audit's "default visible count সীমাবদ্ধ" */
  maxLevels: number;
  /** show H1/H4-sourced drawings on the active chart */
  htf: boolean;
  /** show faded/mitigated/broken/swept ink */
  faded: boolean;
  /** show the duplicates the clustering absorbed (default: hidden) */
  merged: boolean;
}

interface TerminalState {
  symbol: string;
  timeframe: string;
  mainTab: MainTab;
  chartView: ChartView;
  autoView: AutoView;
  tool: ToolId;
  layers: Layers;
  ink: InkFilters;
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
  setInk: (patch: Partial<InkFilters>) => void;
  setSelectedSignalId: (id: string | null) => void;
}

const DEFAULT_LAYERS: Layers = {
  ema: true, killzones: true, zones: true, levels: true,
  structure: true, momentum: true, volume: true, setup: true, signals: true, ai: true,
};

const DEFAULT_INK: InkFilters = {
  maxLevels: 8, htf: true, faded: true, merged: false,
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

/** persisted ink filters (v17.0) — same pattern as layers */
const savedInk = (): InkFilters => {
  if (typeof window === "undefined") return DEFAULT_INK;
  try {
    const raw = localStorage.getItem("aurum-ink");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<InkFilters>;
      return {
        ...DEFAULT_INK,
        ...parsed,
        maxLevels: Math.min(16, Math.max(3, Number(parsed.maxLevels ?? DEFAULT_INK.maxLevels) || DEFAULT_INK.maxLevels)),
      };
    }
  } catch {}
  return DEFAULT_INK;
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
  ink: savedInk(),
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
  setInk: (patch) => {
    const ink = { ...get().ink, ...patch };
    try {
      localStorage.setItem("aurum-ink", JSON.stringify(ink));
    } catch {}
    set({ ink });
  },
  setSelectedSignalId: (selectedSignalId) => set({ selectedSignalId }),
}));
