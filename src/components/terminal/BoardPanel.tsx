"use client";

/**
 * BoardPanel — THE 6-AGENT AI BOARD (v21.0).
 *
 * The user's blueprint: a Multi-Agent AI roundtable that reads the live
 * market and issues ONE consensus decision. Five analysts vote in parallel
 * (Trend · SMC · Risk · Skeptic · Volatility), the Chief Trading Officer
 * weighs their votes and issues the final BUY/SELL/HOLD with entry/SL/TP —
 * and the same decision draws on the chart (overlay-clean).
 *
 *   · Run meeting — manual trigger (one real meeting per candle close)
 *   · Auto — re-run automatically on every bar close of the active tf
 *   · Agent cards — role, model, vote, confidence, বাংলা note
 *   · Decision card — the CTO's plan + consensus meter + Show on chart
 *   · History — past meetings with their won/lost outcomes (the board's
 *     own track record, resolved against real bars)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTerminal } from "@/hooks/useTerminal";
import { useBars } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { BoardAgentOut, BoardResponse, BoardSessionPayload } from "@/lib/market/types";
import {
  TrendingUp, CandlestickChart, ShieldCheck, Eye, Activity, Crown,
  Play, LineChart, Loader2, Bot,
} from "lucide-react";

const AGENT_ICONS: Record<BoardAgentOut["id"], typeof TrendingUp> = {
  trend: TrendingUp,
  smc: CandlestickChart,
  risk: ShieldCheck,
  skeptic: Eye,
  volatility: Activity,
  cto: Crown,
};

function voteChip(v: string) {
  if (v === "BUY") return "border-up/50 bg-up/15 text-up";
  if (v === "SELL") return "border-down/50 bg-down/15 text-down";
  return "border-amber-500/50 bg-amber-500/10 text-amber-400";
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function AgentCard({ a }: { a: BoardAgentOut }) {
  const Icon = AGENT_ICONS[a.id] ?? Bot;
  const isCto = a.id === "cto";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3",
        isCto
          ? "border-gold/40 bg-gradient-to-br from-gold/10 via-card to-card shadow-[0_0_20px_-8px_rgba(245,158,11,0.35)]"
          : "border-border bg-card/70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
            isCto ? "border-gold/50 bg-gold/15 text-gold" : "border-border bg-background text-muted-foreground",
          )}
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-bold leading-tight text-foreground">
            {a.roleBn}
          </div>
          <div className="truncate text-[8px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {a.roleEn}
          </div>
        </div>
        <span className="shrink-0 rounded border border-border bg-background px-1 py-px font-mono text-[7.5px] font-bold text-muted-foreground">
          {a.model}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[10px] font-black tracking-wider",
            voteChip(a.vote),
          )}
        >
          {a.vote}
        </span>
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              a.vote === "BUY" ? "bg-up" : a.vote === "SELL" ? "bg-down" : "bg-amber-400",
            )}
            style={{ width: `${Math.max(4, a.confidence)}%` }}
          />
        </div>
        <span className="tnum shrink-0 font-mono text-[9px] font-bold text-muted-foreground">
          {a.confidence}%
        </span>
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground">
        {a.note || "—"}
        {a.degraded && (
          <span className="ml-1 rounded border border-amber-500/40 px-1 font-mono text-[7px] font-bold uppercase text-amber-500/90">
            local
          </span>
        )}
      </p>
    </div>
  );
}

export function BoardPanel({ board }: { board: BoardSessionPayload | null }) {
  const { symbol, timeframe, setMainTab } = useTerminal();
  const { t } = useI18n();
  const qc = useQueryClient();
  const bars = useBars(symbol, timeframe);
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const lastBarTRef = useRef<number>(0);
  const runningRef = useRef(false);

  // auto-run persists across sessions
  useEffect(() => {
    try { setAuto(localStorage.getItem("aurum-board-auto") === "1"); } catch {}
  }, []);
  const toggleAuto = (v: boolean) => {
    setAuto(v);
    try { localStorage.setItem("aurum-board-auto", v ? "1" : "0"); } catch {}
  };

  const runMeeting = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const res = await fetch("/api/ai-board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, tf: timeframe }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({
          title: t("boardMeetFailed"),
          description: j?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const data = (await res.json()) as BoardResponse & { throttled?: boolean };
      if (data.throttled) {
        toast({ title: t("boardCooldown") });
      }
      await qc.invalidateQueries({ queryKey: ["board", symbol, timeframe] });
    } catch {
      toast({ title: t("boardMeetFailed"), variant: "destructive" });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [symbol, timeframe, qc, t]);

  // AUTO: one meeting per closed bar of the active tf
  useEffect(() => {
    if (!auto) return;
    const lastT = bars.length ? bars[bars.length - 1].t : 0;
    if (!lastT || lastT === lastBarTRef.current) return;
    const isNewBar = lastBarTRef.current !== 0 && lastT > lastBarTRef.current;
    lastBarTRef.current = lastT;
    if (isNewBar) void runMeeting();
  }, [bars, auto, runMeeting]);

  // full board data (history + stats) lives in the shared query cache — the
  // run-meeting POST and the bar-close invalidation keep it fresh
  const boardData = qc.getQueryData<BoardResponse>(["board", symbol, timeframe]);
  const history = (boardData?.history ?? []).filter((h) => h.id !== board?.id).slice(0, 12);
  const statsAll = boardData?.stats;

  const analysts = board?.agents.filter((a) => a.id !== "cto") ?? [];
  const cto = board?.agents.find((a) => a.id === "cto") ?? null;
  const dec = board?.decision ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header — run controls + the board's track record */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Crown className="h-4 w-4 text-gold" aria-hidden />
          <span className="text-xs font-black uppercase tracking-wider text-foreground">
            {t("boardTitle")}
          </span>
          <span className="font-mono text-[9px] font-bold text-muted-foreground">
            {symbol} · {timeframe}
          </span>
        </div>

        {statsAll && statsAll.total > 0 && (
          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[9px] font-bold text-muted-foreground">
            {statsAll.won}W / {statsAll.lost}L · {statsAll.winPct}%
          </span>
        )}

        <label className="ml-auto flex cursor-pointer items-center gap-1.5" title={t("boardAutoHint")}>
          <span className="text-[10px] font-semibold text-muted-foreground">{t("boardAuto")}</span>
          <Switch checked={auto} onCheckedChange={toggleAuto} />
        </label>
        <Button
          size="sm"
          className="h-7 gap-1.5 px-3 text-[11px] font-bold"
          onClick={() => void runMeeting()}
          disabled={running}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {running ? t("boardThinking") : t("boardRunMeeting")}
        </Button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto slim-scroll p-3">
        {!board && !running && (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/40 p-6 text-center">
            <Crown className="h-8 w-8 text-gold/60" aria-hidden />
            <div className="text-sm font-bold text-foreground">{t("boardEmpty")}</div>
            <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground">
              {t("boardEmptyHint")}
            </p>
            <Button size="sm" className="h-8 gap-1.5 px-4 text-[11px] font-bold" onClick={() => void runMeeting()}>
              <Play className="h-3.5 w-3.5" />
              {t("boardRunMeeting")}
            </Button>
          </div>
        )}

        {running && !board && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {["trend", "smc", "risk", "skeptic", "volatility", "cto"].map((id) => (
              <div key={id} className="h-[104px] animate-pulse rounded-lg border border-border bg-muted/30" />
            ))}
          </div>
        )}

        {board && (
          <div className="flex flex-col gap-3">
            {/* the decision — the CTO's verdict (hero card) */}
            <div
              className={cn(
                "relative overflow-hidden rounded-lg border p-4",
                dec?.action === "BUY" && "border-up/40 bg-gradient-to-br from-up/10 via-card to-card",
                dec?.action === "SELL" && "border-down/40 bg-gradient-to-br from-down/10 via-card to-card",
                dec?.action === "HOLD" && "border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-card to-card",
              )}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cn(
                    "rounded-md border px-3 py-1 font-mono text-xl font-black tracking-widest",
                    dec?.action === "BUY" && "border-up/50 bg-up/15 text-up",
                    dec?.action === "SELL" && "border-down/50 bg-down/15 text-down",
                    dec?.action === "HOLD" && "border-amber-500/50 bg-amber-500/15 text-amber-400",
                  )}
                >
                  {dec?.action ?? "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    {t("boardCtoVerdict")} · {timeAgo(board.createdAt)} {t("ago")} ·{" "}
                    {board.degraded ? t("boardDegraded") : "6 × LLM"}
                  </div>
                  <p className="text-xs leading-relaxed text-foreground">
                    {dec?.reasoning || cto?.note || "—"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-3 text-[10px] font-bold"
                  onClick={() => setMainTab("chart")}
                >
                  <LineChart className="h-3.5 w-3.5" />
                  {t("boardShowChart")}
                </Button>
              </div>

              {dec && dec.action !== "HOLD" && dec.entry != null && (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    { k: t("entry"), v: dec.entry.toFixed(2), cls: "text-gold" },
                    { k: "SL", v: dec.sl?.toFixed(2) ?? "—", cls: "text-down" },
                    { k: "TP", v: dec.tp?.toFixed(2) ?? "—", cls: "text-up" },
                    ...(dec.tp2 != null ? [{ k: "TP2", v: dec.tp2.toFixed(2), cls: "text-up" }] : []),
                    { k: "R:R", v: `1:${dec.rr?.toFixed(1) ?? "—"}`, cls: "text-foreground" },
                    ...(dec.lot != null ? [{ k: t("boardLot"), v: dec.lot.toFixed(2), cls: "text-foreground" }] : []),
                  ].map((x) => (
                    <div key={x.k} className="rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5">
                      <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">{x.k}</div>
                      <div className={cn("tnum font-mono text-sm font-bold", x.cls)}>{x.v}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* consensus meter */}
              <div className="mt-3 flex items-center gap-2">
                <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("boardConsensus")}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-400 to-gold transition-all duration-700"
                    style={{ width: `${Math.max(4, dec?.consensus ?? 0)}%` }}
                  />
                </div>
                <span className="tnum shrink-0 font-mono text-[10px] font-black text-gold">
                  {dec?.consensus ?? 0}%
                </span>
                {board.status !== "open" && (
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1.5 py-px font-mono text-[9px] font-black",
                      board.status === "won" && "border-up/50 bg-up/15 text-up",
                      board.status === "lost" && "border-down/50 bg-down/15 text-down",
                      board.status === "expired" && "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {board.status.toUpperCase()}
                    {board.resultPct != null && ` ${board.resultPct >= 0 ? "+" : ""}${board.resultPct.toFixed(2)}%`}
                  </span>
                )}
              </div>
            </div>

            {/* the five analysts */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {analysts.map((a) => (
                <AgentCard key={a.id} a={a} />
              ))}
            </div>

            {/* the market snapshot the board saw */}
            {board.context && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/50 px-3 py-2">
                <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">
                  {t("boardSaw")}
                </span>
                {[
                  t("trend") + ": " + (board.context.trend === "up" ? "▲" : board.context.trend === "down" ? "▼" : "→"),
                  `RSI ${board.context.rsi?.toFixed(0) ?? "—"}`,
                  `ATR ${board.context.atr}`,
                  `H1 ${board.context.h1Trend === "up" ? "▲" : board.context.h1Trend === "down" ? "▼" : "→"}`,
                  `H4 ${board.context.h4Trend === "up" ? "▲" : board.context.h4Trend === "down" ? "▼" : "→"}`,
                  `SPR ${board.context.spread}`,
                  board.context.session.toUpperCase(),
                  ...(board.context.structureEvent ? [board.context.structureEvent] : []),
                  ...(board.context.lastZone ? [board.context.lastZone] : []),
                ].map((chip, i) => (
                  <span
                    key={i}
                    className="rounded border border-border bg-background px-1.5 py-px font-mono text-[9px] font-semibold text-muted-foreground"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            )}

            {/* history — the board's own track record */}
            {history.length > 0 && (
              <div className="rounded-lg border border-border bg-card/50">
                <div className="border-b border-border/70 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">
                  {t("boardHistory")}
                </div>
                <div className="max-h-48 overflow-y-auto slim-scroll">
                  {history.map((h) => (
                    <div
                      key={h.id}
                      className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-0"
                    >
                      <span
                        className={cn(
                          "w-12 shrink-0 rounded border px-1 py-px text-center font-mono text-[9px] font-black",
                          voteChip(h.decision.action),
                        )}
                      >
                        {h.decision.action}
                      </span>
                      <span className="tnum shrink-0 font-mono text-[9px] text-muted-foreground">
                        {h.decision.action !== "HOLD" && h.decision.entry != null
                          ? `@${h.decision.entry.toFixed(2)}`
                          : "—"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {h.decision.reasoning || "—"}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
                        {timeAgo(h.createdAt)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1 py-px font-mono text-[8px] font-black",
                          h.status === "won" && "border-up/50 bg-up/15 text-up",
                          h.status === "lost" && "border-down/50 bg-down/15 text-down",
                          h.status === "open" && "border-gold/50 bg-gold/10 text-gold",
                          h.status === "expired" && "border-border bg-muted text-muted-foreground",
                        )}
                      >
                        {h.status.toUpperCase()}
                        {h.resultPct != null && ` ${h.resultPct >= 0 ? "+" : ""}${h.resultPct.toFixed(2)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
