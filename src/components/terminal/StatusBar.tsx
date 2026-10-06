"use client";

import { useEffect, useState } from "react";
import { useStatus, useSymbolList, useTrader } from "@/hooks/useFeed";
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
  const trader = useTrader();
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
  const isDemo = source === "demo";
  // v16.3 TRUE UTC: serverTime is BROKER wall-clock (UTC + offsetSec —
  // Exness runs GMT+2/+3). The old code fed it straight into sessionOf() and
  // printed it with a "UTC" suffix: sessions mislabeled ~6h/day (TOKYO read
  // as LONDON, NY's last hours as OFF HOURS) and the clock was 2–3h fast.
  const serverTime = status?.serverTime ?? Math.floor(Date.now() / 1000);
  const utcSec = serverTime - (status?.offsetSec ?? 0);
  const session = sessionOf(utcSec);
  const majorSession = session === "LONDON" || session === "NEW YORK";
  const offline = source === "disconnected" && !connected;
  // v16: live account numbers in the status bar (owner sockets only — the
  // stream is private; anonymous viewers simply don't see the block). The
  // trader stream is the freshest (push-driven balance + live-computed
  // equity); the status event's account is the fallback while it boots.
  const bal = trader?.balance ?? status?.account?.balance ?? null;
  const equ = trader?.equity ?? status?.account?.equity ?? null;
  const posCount = trader?.positions?.length ?? null;
  const ccy = trader?.currency ?? status?.account?.currency ?? "";
  const sourceLabel =
    offline ? t("mt5Offline")
    : isDemo ? "DEMO DATA"
    : connected ? `MT5 ${t("live").toUpperCase()}`
    : t("connecting").toUpperCase();
  const sourceClass = offline ? "text-red-500" : isDemo ? "text-amber-400" : connected ? "text-up" : "text-amber-500";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-card/80 px-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1 font-semibold">
        {connected ? (
          <ShieldCheck className={cn("h-3 w-3", sourceClass)} />
        ) : offline ? (
          <ShieldAlert className="h-3 w-3 text-red-500" />
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
      {bal != null && (
        <span className="hidden sm:inline" aria-label="Account balance">
          <span className="uppercase text-muted-foreground">BAL</span>{" "}
          <span className="tnum font-mono text-foreground">{bal.toFixed(2)}{ccy ? ` ${ccy}` : ""}</span>
        </span>
      )}
      {equ != null && (
        <span className="hidden sm:inline" aria-label="Account equity">
          <span className="uppercase text-muted-foreground">EQU</span>{" "}
          <span className="tnum font-mono text-foreground">{equ.toFixed(2)}</span>
        </span>
      )}
      {posCount != null && (
        <span className="hidden lg:inline" aria-label="Open positions">
          <span className="uppercase text-muted-foreground">POS</span>{" "}
          <span className={cn("tnum font-mono", posCount > 0 ? "text-primary font-semibold" : "text-foreground")}>
            {posCount}
          </span>
        </span>
      )}
      <span aria-label="Local time">
        <span className="uppercase text-muted-foreground">LOCAL</span>{" "}
        <span className="tnum font-mono text-foreground">
          {localNow.toTimeString().slice(0, 8)}
        </span>
      </span>
      <span>
        {t("serverTime")}{" "}
        <span className="tnum font-mono text-foreground">
          {new Date(utcSec * 1000).toISOString().slice(11, 19)} UTC
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
