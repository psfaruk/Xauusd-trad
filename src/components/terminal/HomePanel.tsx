"use client";

/** HomePanel — the market overview tab.
 *
 *  Everything "where do I stand" lives here, in Binance-dashboard style:
 *    • account & connection card (balance / equity / server / latency / session)
 *    • today's AI-trading summary (trades · win% · P/L · open positions)
 *    • watchlist (every symbol live — tap once → straight to the chart)
 *    • session roadmap (the day's structure, collapsed by default on mobile)
 */

import { useEffect, useState } from "react";
import type { AnalysisResponse } from "@/lib/market/types";
import { useStatus } from "@/hooks/useFeed";
import { useTrader } from "@/hooks/useFeed";
import { useTerminal } from "@/hooks/useTerminal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WatchlistPanel } from "./WatchlistPanel";
import { RoadmapPanel } from "./RoadmapPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Wallet, Activity, ShieldCheck, ShieldAlert, Clock } from "lucide-react";

function sessionOf(tsSec: number): string {
  const h = new Date(tsSec * 1000).getUTCHours();
  if (h < 7) return "TOKYO";
  if (h < 13) return "LONDON";
  if (h < 20) return "NEW YORK";
  return "OFF HOURS";
}

export function HomePanel({ analysis }: { analysis: AnalysisResponse | null }) {
  const status = useStatus();
  const trader = useTrader();
  const { openChart } = useTerminal();
  const { t } = useI18n();
  const [localNow, setLocalNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setLocalNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const connected = status?.connected ?? false;
  const source = status?.source ?? "mt5";
  const isDemo = source === "demo";
  const offline = source === "disconnected" && !connected;
  const today = trader?.today;
  const hasTrade = !!today && (today.wins + today.losses) > 0;
  const mem = trader?.memory;

  return (
    <div className="slim-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {/* ── account & connection ── */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Wallet className="h-3.5 w-3.5 text-primary" />
              {t("accountCard")}
            </CardTitle>
            <span
              className={cn(
                "flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider",
                offline
                  ? "border-red-500/40 bg-red-500/10 text-red-500"
                  : isDemo
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : connected
                      ? "border-up/40 bg-up/10 text-up"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-500",
              )}
              title={isDemo ? "Demo data — connect your MT5 account in Settings for live prices" : undefined}
            >
              {connected && !isDemo ? (
                <ShieldCheck className="h-3 w-3" />
              ) : (
                <ShieldAlert className="h-3 w-3" />
              )}
              {isDemo ? "DEMO DATA" : connected ? t("live") : offline ? t("mt5Offline") : t("connecting")}
            </span>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 py-3 sm:grid-cols-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("balance")}</div>
              <div className="tnum font-mono text-lg font-bold text-foreground">
                {/* v16: trader stream is the freshest (push-driven); the status
                    event's account fills the gap while the stream boots */}
                {(trader?.balance ?? status?.account?.balance) != null
                  ? (trader?.balance ?? status?.account?.balance)!.toFixed(2)
                  : "—"}
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">{trader?.currency ?? status?.account?.currency ?? "USD"}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("equity")}</div>
              <div className="tnum font-mono text-lg font-bold text-foreground">
                {(trader?.equity ?? status?.account?.equity) != null
                  ? (trader?.equity ?? status?.account?.equity)!.toFixed(2)
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("latency")}</div>
              <div className="tnum font-mono text-sm font-semibold text-foreground">
                {status?.latencyMs != null ? `${status.latencyMs} ms` : "—"}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {status?.server ?? "Exness-MT5Trial6"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("session")}</div>
              <div className="flex items-center gap-1 text-sm font-semibold">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {/* v16.3: one clock for BOTH the highlight and the label, in
                    TRUE UTC (serverTime is broker wall-clock = UTC+offsetSec).
                    The old code computed the className from serverTime??0 and
                    the label from Date.now() — they could disagree, and 0 is
                    midnight UTC (TOKYO) which never styles as OFF HOURS. */}
                {(() => {
                  const utcSec = (status?.serverTime ?? Math.floor(Date.now() / 1000))
                    - (status?.offsetSec ?? 0);
                  const s = sessionOf(utcSec);
                  return (
                    <span className={cn("rounded px-1.5 text-[10px] font-bold", s === "OFF HOURS" ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
                      {s}
                    </span>
                  );
                })()}
              </div>
              <div className="tnum font-mono text-[10px] text-muted-foreground">
                {localNow.toTimeString().slice(0, 8)} ·{" "}
                {new Date(((status?.serverTime ?? Math.floor(Date.now() / 1000)) - (status?.offsetSec ?? 0)) * 1000).toISOString().slice(11, 16)} UTC
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── today's AI trading summary ── */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Activity className="h-3.5 w-3.5 text-primary" />
              {t("todayAI")}
            </CardTitle>
            <span className="font-mono text-[9px] uppercase text-muted-foreground">
              {trader?.enabled ? "ARMED" : "STANDBY"}
            </span>
          </CardHeader>
          <CardContent className="py-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("tradesToday")}</div>
                <div className="tnum font-mono text-lg font-bold">{today?.trades ?? 0}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("winRate")}</div>
                <div className={cn("tnum font-mono text-lg font-bold", hasTrade && today!.winPct >= 50 ? "text-up" : hasTrade ? "text-down" : "")}>
                  {hasTrade ? `${today!.winPct}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("profitToday")}</div>
                <div className={cn("tnum font-mono text-lg font-bold", (today?.pnl ?? 0) > 0 ? "text-up" : (today?.pnl ?? 0) < 0 ? "text-down" : "")}>
                  {today ? `${today.pnl >= 0 ? "+" : ""}${today.pnl.toFixed(2)}` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("openPositions")}</div>
                <div className="tnum font-mono text-lg font-bold">{trader?.positions?.length ?? 0}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("lifetimeWin")}</div>
                <div className="tnum font-mono text-lg font-bold">
                  {mem?.tradesAnalyzed
                    ? `${Math.round(mem.winRate * 100)}%`
                    : "—"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {mem?.tradesAnalyzed ?? 0} {t("learnedTrades")}
                </div>
              </div>
            </div>
            {(trader?.positions?.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
                {(trader?.positions ?? []).map((p) => (
                  <button
                    key={p.ticket}
                    onClick={() => openChart(p.symbol)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] font-bold transition-colors",
                      p.pnl >= 0
                        ? "border-up/40 bg-up/10 text-up hover:bg-up/20"
                        : "border-down/40 bg-down/10 text-down hover:bg-down/20",
                    )}
                  >
                    <span>{p.symbol}</span>
                    <span>{p.side === "buy" ? "▲" : "▼"}</span>
                    <span className="tnum">
                      {p.pnl >= 0 ? "+" : ""}{p.pnl.toFixed(2)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── watchlist ── */}
        <Card className="flex flex-col overflow-hidden border-border bg-card">
          <div className="min-h-0">
            <WatchlistPanel showAccount={false} />
          </div>
        </Card>

        {/* ── roadmap (collapsible) ── */}
        <Collapsible defaultOpen className="rounded-lg border border-border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2.5">
            <span className="text-xs font-bold uppercase tracking-wider">{t("tabRoadmap")}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border">
              <RoadmapPanel analysis={analysis} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
