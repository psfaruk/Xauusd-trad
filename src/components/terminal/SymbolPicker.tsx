"use client";

/**
 * Symbol picker — ONE dropdown with every market, grouped by category
 * (user directive D-076: "সব পেয়ার গুলো একটি ড্রপ ডাউন বক্সে থাকবে").
 */

import { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useSymbolList, useQuote } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ChevronsUpDown, TrendingUp, TrendingDown, Search } from "lucide-react";

/** market categories — everything unlisted lands in Forex */
const CATEGORY_OF: Record<string, string> = {
  XAUUSDm: "Metals", XAUUSD247m: "Metals", XAGUSDm: "Metals",
  USOILm: "Energy", UKOILm: "Energy",
  USTECm: "Indices", USTEC_x100m: "Indices", US500m: "Indices", US500_x100m: "Indices",
  BTCUSDm: "Crypto", ETHUSDm: "Crypto", SOLUSDm: "Crypto",
};

/** friendly display label (×100 multipliers etc.) */
const LABEL_OF: Record<string, string> = {
  USTEC_x100m: "USTEC ×100",
  US500_x100m: "US500 ×100",
  XAUUSD247m: "XAUUSD 24/7",
  USTECm: "USTEC",
  US500m: "US500",
};

const CATEGORY_ORDER = ["Metals", "Energy", "Indices", "Crypto", "Forex"];

const CATEGORY_BN: Record<string, string> = {
  Metals: "মেটাল",
  Energy: "এনার্জি",
  Indices: "ইনডেক্স",
  Crypto: "ক্রিপ্টো",
  Forex: "ফরেক্স",
};

export function SymbolPicker({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { symbol, setSymbol } = useTerminal();
  const symbols = useSymbolList();
  const quote = useQuote(symbol);
  const { t, locale } = useI18n();
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? quote?.digits ?? 2;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof symbols>();
    for (const s of symbols) {
      const cat = CATEGORY_OF[s.name] ?? "Forex";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [symbols]);

  const label = (name: string) => LABEL_OF[name] ?? name.replace(/m$/, "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-border bg-card/60 font-semibold hover:bg-muted",
            compact ? "h-7 px-2" : "px-2 py-1 text-xs",
          )}
          aria-label={t("searchSymbol")}
        >
          <span className={cn("font-mono", compact ? "text-[11px]" : "text-xs")}>
            {label(symbol)}
          </span>
          {quote && (
            <span
              className={cn(
                "tnum font-mono text-[10px]",
                quote.change >= 0 ? "text-up" : "text-down",
              )}
            >
              {quote.mid.toFixed(digits)}
            </span>
          )}
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <CommandInput placeholder={t("searchSymbol")} className="h-9" />
          </div>
          <CommandList className="slim-scroll max-h-[min(62vh,26rem)]">
            <CommandEmpty>—</CommandEmpty>
            {grouped.map(([cat, list]) => (
              <CommandGroup
                key={cat}
                heading={locale === "bn" ? CATEGORY_BN[cat] : cat}
              >
                {list.map((s) => (
                  <CommandItem
                    key={s.name}
                    value={`${s.name} ${label(s.name)}`}
                    onSelect={() => {
                      setSymbol(s.name);
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <span className="flex-1 font-mono text-xs font-bold">{label(s.name)}</span>
                    <span className="tnum font-mono text-[11px] text-foreground">
                      {s.mid ? s.mid.toFixed(s.digits) : "—"}
                    </span>
                    {s.changePct !== 0 && (
                      <span
                        className={cn(
                          "tnum flex items-center gap-0.5 font-mono text-[10px]",
                          s.changePct >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {s.changePct >= 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : (
                          <TrendingDown className="h-3 w-3" />
                        )}
                        {Math.abs(s.changePct).toFixed(2)}%
                      </span>
                    )}
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        s.live ? "bg-up live-dot" : "bg-muted-foreground/40",
                      )}
                      aria-label={s.live ? "live" : "closed"}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {/* scroll affordance — mobile users must SEE there are more markets */}
          <div className="pointer-events-none sticky bottom-0 flex items-center justify-center gap-1 border-t border-border/60 bg-popover/95 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70 backdrop-blur">
            <ChevronsUpDown className="h-2.5 w-2.5" />
            {symbols.length} {locale === "bn" ? "মার্কেট · স্ক্রল করুন" : "markets · scroll"}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
