"use client";

/**
 * Timeframe selector — a dropdown button (user directive: options in
 * dropdowns are easier to use and save space, on every layout).
 * Plus the ChartTypeToggle — Candles ↔ Area (2-bar focus view).
 */

import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronsUpDown, ChartCandlestick, ChartArea, ScanEye } from "lucide-react";

export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

const TF_LABEL: Record<string, string> = {
  M1: "1 minute",
  M5: "5 minutes",
  M15: "15 minutes",
  M30: "30 minutes",
  H1: "1 hour",
  H4: "4 hours",
  D1: "1 day",
};

export function TimeframeBar({ compact = false }: { compact?: boolean }) {
  const { timeframe, setTimeframe } = useTerminal();
  const { t, locale } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1 rounded-md border border-border bg-card/60 font-mono font-bold hover:bg-muted",
            compact ? "h-7 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
          )}
          aria-label={t("timeframes")}
          aria-expanded={undefined}
        >
          <span>{timeframe}</span>
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
          {locale === "bn" ? "টাইমফ্রেম" : "Timeframe"}
        </div>
        {TIMEFRAMES.map((tf) => (
          <DropdownMenuItem
            key={tf}
            onClick={() => setTimeframe(tf)}
            className={cn(
              "flex items-center justify-between gap-2 font-mono text-xs font-bold",
              timeframe === tf && "bg-primary/10",
            )}
          >
            <span>{tf}</span>
            <span className="flex items-center gap-1.5">
              <span className="font-sans text-[10px] font-normal text-muted-foreground">
                {TF_LABEL[tf]}
              </span>
              {timeframe === tf && <Check className="h-3 w-3 text-primary" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Chart view switch — the 3 chart folders inside the CHART tab:
 *  Price (candlestick + tools) · Flow (area trio 30/30/40) · X-Ray (order flow). */
export function ChartViewToggle() {
  const { chartView, setChartView } = useTerminal();
  const { locale } = useI18n();
  const items = [
    { id: "price" as const, icon: ChartCandlestick, title: locale === "bn" ? "প্রাইস · ক্যান্ডেলস্টিক" : "Price · candlestick" },
    { id: "flow" as const, icon: ChartArea, title: locale === "bn" ? "ফ্লো · ৩ চার্ট একসাথে" : "Flow · 3 charts together" },
    { id: "xray" as const, icon: ScanEye, title: locale === "bn" ? "এক্স-রে · অর্ডার ফ্লো" : "X-Ray · order flow" },
  ];
  return (
    <div
      className="flex h-7 items-center rounded-md border border-border bg-card/60 p-0.5"
      role="group"
      aria-label={locale === "bn" ? "চার্ট ভিউ" : "chart view"}
    >
      {items.map(({ id, icon: Icon, title }) => {
        const active = chartView === id;
        return (
          <button
            key={id}
            onClick={() => setChartView(id)}
            aria-pressed={active}
            title={title}
            className={cn(
              "flex h-6 w-8 items-center justify-center rounded transition-colors",
              active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
