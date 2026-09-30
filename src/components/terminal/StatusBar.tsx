"use client";

import { useEffect, useState } from "react";
import { useStatus, useSymbolList } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert } from "lucide-react";

function sessionOf(tsSec: number): string {
  const h = new Date(tsSec * 1000).getUTCHours();
  if (h < 7) return "TOKYO";
  if (h < 13) return "LONDON";
  if (h < 20) return "NEW YORK";
  return "OFF HOURS";
}

export function StatusBar() {
  const status = useStatus();
  const { symbol } = useTerminal();
  const symbols = useSymbolList();
  const { t } = useI18n();
  const [localNow, setLocalNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setLocalNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const q = symbols.find((s) => s.name === symbol);
  const digits = q?.digits ?? 2;

  const source = status?.source ?? "mt5";
  const connected = status?.connected ?? false;
  const serverTime = status?.serverTime ?? Math.floor(Date.now() / 1000);
  const session = sessionOf(serverTime);
  const majorSession = session === "LONDON" || session === "NEW YORK";
  const sourceLabel =
    source === "sim" ? t("simulated").toUpperCase()
    : connected ? `MT5 ${t("live").toUpperCase()}`
    : t("connecting").toUpperCase();
  const sourceClass = source === "sim" ? "text-amber-500" : connected ? "text-up" : "text-amber-500";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-card/80 px-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1 font-semibold">
        {connected || source === "sim" ? (
          <ShieldCheck className={cn("h-3 w-3", sourceClass)} />
        ) : (
          <ShieldAlert className="h-3 w-3 text-amber-500" />
        )}
        {connected && source === "mt5" && (
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" aria-hidden="true" />
        )}
        <span className={sourceClass}>{sourceLabel}</span>
        <span className="hidden text-muted-foreground/70 sm:inline">
          · {status?.server ?? "Exness-MT5Trial6"}
        </span>
      </span>
      <span className="hidden md:inline">
        {t("latency")} <span className="tnum text-foreground">{status?.latencyMs != null ? `${status.latencyMs}ms` : "—"}</span>
      </span>
      <span className="hidden md:inline">
        {t("session")}{" "}
        <span
          className={cn(
            "rounded px-1.5",
            majorSession
              ? "bg-accent/60 text-accent-foreground"
              : "bg-muted/60 text-muted-foreground",
          )}
        >
          {session}
        </span>
      </span>
      <span aria-label="Local time">
        <span className="uppercase text-muted-foreground">LOCAL</span>{" "}
        <span className="tnum font-mono text-foreground">
          {localNow.toTimeString().slice(0, 8)}
        </span>
      </span>
      <span>
        {t("serverTime")}{" "}
        <span className="tnum font-mono text-foreground">
          {new Date(serverTime * 1000).toISOString().slice(11, 19)} UTC
        </span>
      </span>
      <span className="hidden lg:inline">
        {t("spread")}{" "}
        <span className="tnum text-foreground">
          {q?.spread ? `${(q.spread).toFixed(digits)} (${Math.round(q.spread * 10 ** digits)} pts)` : "—"}
        </span>
      </span>
      <span className="ml-auto hidden shrink-0 text-muted-foreground/60 sm:inline">
        AURUM Terminal v1.0 · data © MetaQuotes / Exness
      </span>
    </footer>
  );
}
