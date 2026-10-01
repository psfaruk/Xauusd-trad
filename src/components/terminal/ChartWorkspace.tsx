"use client";

/** ChartWorkspace — the CHART tab: three chart folders in one place.
 *
 *    Price — full candlestick chart + drawing tools + layers + AI read
 *    Flow  — the combined trio view (area 30% · Micro Δ 30% · candles 40%)
 *    X-Ray — the running-candle order-flow panel (full)
 *
 *  One header strip (view toggle · timeframe · layers · drawings · AI read),
 *  identical on mobile and desktop — nothing hidden, nothing duplicated.
 */

import { useState } from "react";
import type { AnalysisResponse, SignalPayload, UserDrawing } from "@/lib/market/types";
import type { Layers, ToolId } from "@/hooks/useTerminal";
import { useTerminal } from "@/hooks/useTerminal";
import { useStatus, useSymbolList } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import TradingChart from "./TradingChart";
import TripleChartView from "./TripleChartView";
import { DrawingToolbar } from "./DrawingToolbar";
import { TimeframeBar, ChartViewToggle } from "./TimeframeBar";
import { FlowPanel } from "./FlowPanel";
import { LayersPopover } from "./TopBar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AnalysisPanel } from "./AnalysisPanel";
import { PencilRuler, X, Sparkles, Unplug, Settings } from "lucide-react";

interface Props {
  analysis: AnalysisResponse | null;
  userDrawings: UserDrawing[];
  onCreateDrawing: (d: Omit<UserDrawing, "id" | "createdAt">) => void;
  onUpdateDrawing: (id: string, points: UserDrawing["points"], style: UserDrawing["style"]) => void;
  onDeleteDrawing: (id: string) => void;
  onClearDrawings: () => void;
  mobile?: boolean;
}

export function ChartWorkspace({
  analysis,
  userDrawings,
  onCreateDrawing,
  onUpdateDrawing,
  onDeleteDrawing,
  onClearDrawings,
  mobile = false,
}: Props) {
  const { symbol, timeframe, chartView, tool, setTool, setMainTab, layers, selectedSignalId } = useTerminal();
  const symbols = useSymbolList();
  const status = useStatus();
  const { t } = useI18n();
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? 2;
  const [sheetOpen, setSheetOpen] = useState(false);

  const signals = ((analysis as any)?.signals ?? []) as SignalPayload[];
  const isPrice = chartView === "price";
  const offline = status?.source === "disconnected" && !(status?.connected ?? false);

  const chart = !isPrice ? (
    chartView === "flow" ? (
      <TripleChartView
        onExit={() => useTerminal.getState().setChartView("price")}
        headerRight={mobile ? undefined : undefined}
      />
    ) : (
      <FlowPanel />
    )
  ) : (
    <TradingChart
      key={`${symbol}|${timeframe}`}
      symbol={symbol}
      timeframe={timeframe}
      digits={digits}
      layers={layers}
      tool={tool}
      onToolDone={() => setTool("cursor")}
      autoDrawings={analysis?.drawings ?? []}
      signals={signals}
      selectedSignalId={selectedSignalId}
      userDrawings={userDrawings}
      onCreateDrawing={onCreateDrawing}
      onUpdateDrawing={onUpdateDrawing}
      onDeleteDrawing={onDeleteDrawing}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── one control strip: view folders · tf · layers · drawings · AI read ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-2">
        <ChartViewToggle />
        <TimeframeBar compact />
        {/* layers & drawings belong to the price chart only — the trio and
            X-ray views render their charts BARE (no drawing overlays) */}
        {isPrice && <LayersPopover />}
        {isPrice && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "ml-auto h-7 gap-1 px-2 text-[10px] font-bold",
                  tool !== "cursor" && "border-primary/50 bg-primary/10 text-primary",
                )}
              >
                <PencilRuler className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("drawingTools")}</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-2xl px-4 pb-8 pt-3">
              <SheetHeader className="mb-2 px-0">
                <SheetTitle className="text-xs uppercase tracking-wider">
                  {t("drawingTools")}
                </SheetTitle>
              </SheetHeader>
              <DrawingToolbar
                variant="horizontal"
                onClearAll={() => {
                  onClearDrawings();
                  setSheetOpen(false);
                }}
              />
              <p className="mt-3 text-center text-[10px] text-muted-foreground/60">
                {tool !== "cursor" ? t("toolTrendline") + " / " + tool + " — tap chart to place" : t("toolCursor")}
              </p>
            </SheetContent>
          </Sheet>
        )}
        {isPrice && tool !== "cursor" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setTool("cursor")}
            aria-label="cancel tool"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        {/* AI read — the brain's structural read of the active chart (any view) */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn("h-7 gap-1 px-2 text-[10px] font-bold", !isPrice && "ml-auto")}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="hidden sm:inline">{t("aiRead")}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side={mobile ? "top" : "bottom"}
            className="w-[min(92vw,400px)] max-h-[70vh] overflow-y-auto slim-scroll p-0"
          >
            <AnalysisPanel analysis={analysis} />
          </PopoverContent>
        </Popover>
      </div>

      {/* ── chart body ── */}
      <div className="flex min-h-0 flex-1">
        {isPrice && (
          <div className="hidden shrink-0 items-start justify-center border-r border-border bg-card/40 p-1.5 pt-3 md:flex">
            <DrawingToolbar variant="vertical" onClearAll={onClearDrawings} />
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          {chart}
          {/* offline banner — MT5 not connected: no market data. Non-blocking:
              the chart stays visible/usable behind it, only the card eats clicks */}
          {offline && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
              <div className="pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 rounded-lg border border-red-500/40 bg-card/95 px-5 py-4 text-center shadow-lg backdrop-blur-sm">
                <Unplug className="h-4 w-4 text-red-500" aria-hidden="true" />
                <div className="text-[11px] font-semibold leading-relaxed text-foreground">
                  {t("chartNoData")}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-red-500/40 text-[10px] font-bold text-red-500 hover:bg-red-500/10 hover:text-red-500"
                  onClick={() => setMainTab("settings")}
                >
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("openSettings")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
