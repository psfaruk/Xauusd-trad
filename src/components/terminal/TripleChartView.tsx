"use client";

/**
 * TripleChartView — the combined three-chart view behind the AREA tab:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ ✕ ৩টি চার্ট একসাথে | XAUUSDm | M15  [toggle] │  header — THE pair display
 *   ├──────────────────────────────────────────────┤
 *   │ O 4128.2 H … L … C … +0.4 VOL 12k SPR 0.12  │  OHLC legend strip (outside)
 *   ├──────────────────────────────────────────────┤
 *   │  AREA chart                       30%        │  FocusAreaChart — clean
 *   ├──────────────────────────────────────────────┤     canvas + outside strip
 *   │  MICRO Δ (2-candle delta)         30%        │  DeltaMicroStrip — clean
 *   ├──────────────────────────────────────────────┤     canvas + outside strips
 *   │  CANDLESTICK                      40%        │  TradingChart — BARE
 *   └──────────────────────────────────────────────┘   (no drawings/legend)
 *
 * User spec: "এরিয়া চার্ট ট্যাব এ ক্লিক করলে তিনটি চার্ট একসাথে ওপেন হবে" —
 * the Area tab opens this view directly. "সকল চার্ট এর উপর থেকে নির্দেশক
 * প্রতীক গুলো সরিয়ে দাও" — every chart surface is clean; the pair name and
 * the OHLC legend live ONCE in the strips above, each chart keeps its own
 * independent zoom.
 */

import { useEffect, type ReactNode } from "react";
import type { Layers } from "@/hooks/useTerminal";
import { useTerminal } from "@/hooks/useTerminal";
import { useSymbolList, useBars, useQuote } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import FocusAreaChart from "./FocusAreaChart";
import DeltaMicroStrip from "./DeltaMicroStrip";
import TradingChart from "./TradingChart";
import { X } from "lucide-react";

/** every ink layer OFF — only candles + ghost volume remain */
const BARE_LAYERS: Layers = {
  ema: false, killzones: false, zones: false, levels: false,
  structure: false, momentum: false, volume: true, setup: false, signals: false, ai: false,
};

function fmtCompact(v: number) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** the OHLC legend that used to float on the candle chart — now a strip */
function CandleLegend() {
  const { symbol, timeframe } = useTerminal();
  const symbols = useSymbolList();
  const quote = useQuote(symbol);
  const bars = useBars(symbol, timeframe);
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? 2;
  const lb = bars[bars.length - 1];
  if (!lb) return null;
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const up = lb.c >= lb.o;
  const chg = prev ? lb.c - prev.c : 0;
  const chgPct = prev ? (chg / prev.c) * 100 : 0;
  const col = up ? "text-up" : "text-down";
  return (
    <div className="flex h-5 shrink-0 items-center gap-2 overflow-hidden border-b border-border/60 bg-card/20 px-2 font-mono text-[9px] font-bold tracking-wide">
      <span className="flex items-center gap-1" aria-label="open">
        <span className="text-muted-foreground/70">O</span>
        <span className={col}>{lb.o.toFixed(digits)}</span>
      </span>
      <span className="flex items-center gap-1" aria-label="high">
        <span className="text-muted-foreground/70">H</span>
        <span className={col}>{lb.h.toFixed(digits)}</span>
      </span>
      <span className="flex items-center gap-1" aria-label="low">
        <span className="text-muted-foreground/70">L</span>
        <span className={col}>{lb.l.toFixed(digits)}</span>
      </span>
      <span className="flex items-center gap-1" aria-label="close">
        <span className="text-muted-foreground/70">C</span>
        <span className={col}>{lb.c.toFixed(digits)}</span>
      </span>
      <span className={cn("tnum", col)}>
        {chg >= 0 ? "+" : ""}{chg.toFixed(digits)} ({chgPct >= 0 ? "+" : ""}{chgPct.toFixed(2)}%)
      </span>
      <span className="flex items-center gap-1">
        <span className="text-muted-foreground/70">VOL</span>
        <span className="text-muted-foreground">{fmtCompact(lb.v)}</span>
      </span>
      {quote && (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground/70">SPR</span>
          <span className="text-muted-foreground">{(quote.ask - quote.bid).toFixed(digits)}</span>
        </span>
      )}
    </div>
  );
}

interface Props {
  onExit: () => void;
  /** slot for the chart-type toggle (desktop) — lives in the slim header */
  headerRight?: ReactNode;
}

export default function TripleChartView({ onExit, headerRight }: Props) {
  const { symbol, timeframe } = useTerminal();
  const symbols = useSymbolList();
  const { t } = useI18n();
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? 2;

  // ESC closes the combined view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" role="region" aria-label={t("trioTitle")}>
      {/* slim header — exit ✕, the ONE pair display, the type toggle */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card/40 px-2">
        <button
          type="button"
          onClick={onExit}
          aria-label={t("trioExit")}
          title={t("trioExit")}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card/80 text-muted-foreground transition-colors hover:border-red-400/60 hover:text-red-400"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span className="text-gold">{t("trioTitle")}</span>
          <span className="text-border">|</span>
          <span className="text-foreground">{symbol}</span>
          <span className="text-border">|</span>
          <span>{timeframe}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden font-mono text-[8px] uppercase tracking-wider text-muted-foreground/50 sm:block">
            {t("trioAreaLabel")} 30% · {t("flowRecent")} 30% · {t("trioCandleLabel")} 40%
          </span>
          {headerRight}
        </span>
      </div>

      {/* OHLC legend strip — the ONE legend, outside every chart */}
      <CandleLegend />

      {/* the three charts — 30 / 30 / 40, each with its own zoom */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-[3] border-b border-border">
          <FocusAreaChart onActivate={onExit} />
        </div>
        <div className="min-h-0 flex-[3] border-b border-border">
          <DeltaMicroStrip />
        </div>
        <div className="min-h-0 flex-[4]">
          <TradingChart
            key={`${symbol}|${timeframe}|bare`}
            symbol={symbol}
            timeframe={timeframe}
            digits={digits}
            layers={BARE_LAYERS}
            tool="cursor"
            onToolDone={() => {}}
            autoDrawings={[]}
            signals={[]}
            selectedSignalId={null}
            userDrawings={[]}
            onCreateDrawing={() => {}}
            onUpdateDrawing={() => {}}
            onDeleteDrawing={() => {}}
            bare
          />
        </div>
      </div>
    </div>
  );
}
