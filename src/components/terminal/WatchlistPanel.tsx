"use client";

import { useStatus, useSymbolList } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";

export function WatchlistPanel({ showAccount = true }: { showAccount?: boolean }) {
  const symbols = useSymbolList();
  const status = useStatus();
  const { symbol: active, setSymbol } = useTerminal();
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-wider">{t("watchlist")}</span>
        <span className="font-mono text-[9px] uppercase text-muted-foreground">
          {status == null ? "…" : status.source === "mt5" ? "MT5 direct" : "sim"}
        </span>
      </div>
      <ScrollArea className="slim-scroll min-h-0 flex-1">
        <div className="p-1.5">
          {symbols.map((s) => {
            const activeRow = s.name === active;
            return (
              <button
                key={s.name}
                onClick={() => setSymbol(s.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  activeRow ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/60",
                )}
                aria-pressed={activeRow}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    s.live ? "bg-up live-dot" : "bg-muted-foreground/30",
                  )}
                />
                <span
                  className={cn(
                    "w-20 shrink-0 truncate font-mono text-[11px] font-bold",
                    activeRow ? "text-primary" : "text-foreground",
                  )}
                >
                  {s.name}
                </span>
                <span className="tnum ml-auto font-mono text-[11px] text-foreground transition-colors duration-300">
                  {s.mid ? s.mid.toFixed(s.digits) : "—"}
                </span>
                <span
                  className={cn(
                    "tnum w-16 text-right font-mono text-[10px] transition-colors duration-300",
                    s.changePct > 0 ? "text-up" : s.changePct < 0 ? "text-down" : "text-muted-foreground",
                  )}
                >
                  {s.changePct !== 0 &&
                    (s.changePct > 0 ? (
                      <TrendingUp className="mr-0.5 inline h-3 w-3" />
                    ) : (
                      <TrendingDown className="mr-0.5 inline h-3 w-3" />
                    ))}
                  {s.changePct >= 0 ? "+" : ""}
                  {s.changePct.toFixed(2)}%
                </span>
              </button>
            );
          })}
          {symbols.length === 0 && (
            <div className="space-y-1" aria-busy="true">
              <span className="sr-only">{t("loading")}</span>
              {Array.from({ length: 7 }, (_, i) => (
                <div
                  key={i}
                  className="flex h-9 animate-pulse items-center gap-2 rounded-md bg-muted/40 px-2"
                >
                  <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
                  <div className="h-3 w-20 rounded bg-muted" />
                  <div className="ml-auto h-3 w-10 rounded bg-muted" />
                  <div className="h-3 w-14 rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      {showAccount && status?.account && (
        <div className="border-t border-border p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <Wallet className="h-3 w-3" />
            {t("account")} · {t("demoAccount")}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[9px] uppercase text-muted-foreground/60">{t("balance")}</div>
              <div className="tnum font-mono text-sm font-bold text-foreground">
                {status.account.balance.toFixed(2)}{" "}
                <span className="text-[9px] text-muted-foreground">{status.account.currency}</span>
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase text-muted-foreground/60">{t("equity")}</div>
              <div className="tnum font-mono text-sm font-bold text-foreground">
                {status.account.equity.toFixed(2)}{" "}
                <span className="text-[9px] text-muted-foreground">{status.account.currency}</span>
              </div>
            </div>
          </div>
          <div className="mt-2 font-mono text-[9px] text-muted-foreground/60">
            {status.server ?? "Exness-MT5Trial6"}
          </div>
        </div>
      )}
    </div>
  );
}
