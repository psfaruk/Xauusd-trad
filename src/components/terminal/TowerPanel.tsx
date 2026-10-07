"use client";

/**
 * TowerPanel — THE CONTROL TOWER (v22.0).
 *
 * প্রত্যেকটি এজেন্ট রিয়েল টাইমে পুরো অ্যাপটিকে ফলোআপ করে — this panel is the
 * supervisor's console the agents report into:
 *
 *   · Follow-ups — every OPEN board decision vs the live price: progress
 *     meter (entry → TP / SL), distances in price + ATR, near_tp / near_sl
 *     warnings
 *   · MTF confluence — the bias grid for M5…H4 (fresh AI Board meeting when
 *     there is one, the deterministic board brain otherwise) + the verdict
 *   · News radar — live web headlines + high-impact window flag
 *   · Agent activity — the rolling event feed (what the agents noticed)
 *   · Health — feed status, the board's W/L record
 *
 * Polls every 15s (the server caches a scan for 8s, so this is cheap) and
 * refreshes immediately on every bar close.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTerminal } from "@/hooks/useTerminal";
import { useBars } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TowerState } from "@/lib/ai/tower";
import {
  Radar, Crosshair, Newspaper, HeartPulse, History, Loader2,
  TrendingUp, TrendingDown, Minus, Bot, ExternalLink,
} from "lucide-react";

async function fetchTower(symbol: string, tf: string): Promise<TowerState> {
  const res = await fetch(`/api/ai/tower?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
  if (!res.ok) throw new Error(`tower ${res.status}`);
  return res.json();
}

function biasChip(bias: string) {
  if (bias === "BUY") return "border-up/50 bg-up/15 text-up";
  if (bias === "SELL") return "border-down/50 bg-down/15 text-down";
  return "border-amber-500/50 bg-amber-500/10 text-amber-400";
}

function timeAgoShort(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const EVENT_TONE: Record<string, string> = {
  up: "border-up/40 bg-up/10 text-up",
  down: "border-down/40 bg-down/10 text-down",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  info: "border-border bg-muted/40 text-muted-foreground",
};

export function TowerPanel() {
  const { symbol, timeframe } = useTerminal();
  const { t } = useI18n();
  const qc = useQueryClient();
  const bars = useBars(symbol, timeframe);

  const towerQ = useQuery({
    queryKey: ["tower", symbol, timeframe],
    queryFn: () => fetchTower(symbol, timeframe),
    refetchInterval: 15_000,
    retry: 1,
    staleTime: 8_000,
  });

  // refresh on every bar close of the active tf — the follow-ups must never
  // lag a fresh candle
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["tower", symbol, timeframe] });
  }, [bars.length, qc, symbol, timeframe]);

  const state = towerQ.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Radar className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-xs font-black uppercase tracking-wider text-foreground">
            {t("towerTitle")}
          </span>
          <span className="font-mono text-[9px] font-bold text-muted-foreground">
            {symbol} · {timeframe}
          </span>
        </div>

        {state && (
          <div className="ml-auto flex items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold",
                state.health.feed === "ok"
                  ? "border-up/40 bg-up/10 text-up"
                  : "border-down/40 bg-down/10 text-down",
              )}
            >
              <HeartPulse className="h-3 w-3" aria-hidden />
              {state.health.feed === "ok" ? t("towerFeedOk") : t("towerFeedDown")}
            </span>
            {state.health.total > 0 && (
              <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[9px] font-bold text-muted-foreground">
                {t("towerBoard")} {state.health.winPct}% · {state.health.total}
              </span>
            )}
            {towerQ.isFetching && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>
        )}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto slim-scroll p-3">
        {towerQ.isLoading && (
          <div className="flex flex-col gap-2">
            <div className="h-24 animate-pulse rounded-lg border border-border bg-muted/30" />
            <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/30" />
            <div className="h-40 animate-pulse rounded-lg border border-border bg-muted/30" />
          </div>
        )}

        {towerQ.isError && (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-down/40 bg-down/5 p-6 text-center">
            <Radar className="h-7 w-7 text-down/60" aria-hidden />
            <div className="text-sm font-bold text-foreground">{t("towerScanFailed")}</div>
            <p className="text-[11px] text-muted-foreground">{t("towerScanFailedHint")}</p>
          </div>
        )}

        {state && (
          <div className="flex flex-col gap-3">
            {/* ── follow-ups: open decisions vs live price ── */}
            <section aria-label={t("towerFollowups")} className="rounded-lg border border-border bg-card/60">
              <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
                <Crosshair className="h-3.5 w-3.5 text-gold" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("towerFollowups")}
                </span>
                <span className="ml-auto font-mono text-[10px] font-bold text-foreground">
                  {state.price != null ? state.price : "—"}
                </span>
              </div>

              {state.followUps.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  {t("towerNoOpen")}
                </div>
              ) : (
                <div className="flex flex-col">
                  {state.followUps.map((f) => {
                    const pct = f.progressPct ?? 0;
                    // progress bar: SL ← entry → TP mapped to −100..+100
                    const width = Math.min(100, Math.abs(pct));
                    return (
                      <div key={f.id} className="border-b border-border/40 px-3 py-2 last:border-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "shrink-0 rounded border px-1.5 py-px font-mono text-[9px] font-black",
                              biasChip(f.action),
                            )}
                          >
                            {f.action} · {f.tf}
                          </span>
                          <span className="tnum font-mono text-[9px] text-muted-foreground">
                            E {f.entry.toFixed(2)} · SL {f.sl.toFixed(2)} · TP {f.tp.toFixed(2)}
                          </span>
                          <span
                            className={cn(
                              "ml-auto shrink-0 rounded border px-1.5 py-px font-mono text-[8px] font-black uppercase",
                              f.state === "near_tp" && "border-up/50 bg-up/15 text-up",
                              f.state === "near_sl" && "border-amber-500/50 bg-amber-500/15 text-amber-400",
                              f.state === "profit" && "border-up/30 bg-up/10 text-up/90",
                              f.state === "loss" && "border-down/30 bg-down/10 text-down/90",
                              f.state === "waiting" && "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            {t(`towerState_${f.state}`)}
                          </span>
                        </div>

                        <div className="mt-1.5 flex items-center gap-2">
                          {/* SL ←── entry ──→ TP meter */}
                          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                            <div
                              className={cn(
                                "absolute inset-y-0 rounded-full transition-all duration-700",
                                pct >= 0 ? "left-1/2 bg-up" : "right-1/2 bg-down",
                              )}
                              style={{ width: `${width / 2}%` }}
                            />
                          </div>
                          <span
                            className={cn(
                              "tnum shrink-0 font-mono text-[9px] font-bold",
                              pct >= 0 ? "text-up" : "text-down",
                            )}
                          >
                            {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                          </span>
                        </div>

                        <div className="mt-1 flex items-center gap-3 font-mono text-[9px] text-muted-foreground">
                          <span>
                            TP ← <span className="tnum text-up/90">{f.distTp ?? "—"}{f.distTpAtr != null ? ` (${f.distTpAtr}×ATR)` : ""}</span>
                          </span>
                          <span>
                            SL ← <span className="tnum text-down/90">{f.distSl ?? "—"}{f.distSlAtr != null ? ` (${f.distSlAtr}×ATR)` : ""}</span>
                          </span>
                          <span className="ml-auto">{timeAgoShort(f.createdAt)} {t("ago")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── MTF confluence ── */}
            <section aria-label={t("towerMtf")} className="rounded-lg border border-border bg-card/60">
              <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-primary" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("towerMtf")}
                </span>
              </div>
              <div className="p-3">
                <div className="grid grid-cols-5 gap-1.5">
                  {state.mtf.map((c) => {
                    const Icon = c.bias === "BUY" ? TrendingUp : c.bias === "SELL" ? TrendingDown : Minus;
                    return (
                      <div
                        key={c.tf}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-md border px-1 py-2",
                          c.bias === "BUY" && "border-up/40 bg-up/10",
                          c.bias === "SELL" && "border-down/40 bg-down/10",
                          c.bias === "HOLD" && "border-border bg-muted/30",
                        )}
                      >
                        <span className="font-mono text-[9px] font-black text-muted-foreground">{c.tf}</span>
                        <Icon
                          className={cn(
                            "h-4 w-4",
                            c.bias === "BUY" && "text-up",
                            c.bias === "SELL" && "text-down",
                            c.bias === "HOLD" && "text-amber-400",
                          )}
                          aria-hidden
                        />
                        <span
                          className={cn(
                            "rounded border px-1 py-px font-mono text-[8px] font-black",
                            biasChip(c.bias),
                          )}
                        >
                          {c.bias}
                        </span>
                        <span
                          className="rounded border border-border bg-background px-1 py-px font-mono text-[7px] font-bold uppercase text-muted-foreground/80"
                          title={c.source === "ai" ? t("towerSourceAi") : t("towerSourceLocal")}
                        >
                          {c.source === "ai" ? "AI" : "APP"} {c.consensus > 0 ? `${c.consensus}%` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2.5 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2 text-[11px] font-semibold leading-snug text-foreground">
                  {state.confluence.verdictBn}
                </p>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] font-bold">
                  <span className="text-up">↑ {state.confluence.buy}</span>
                  <span className="text-down">↓ {state.confluence.sell}</span>
                  <span className="text-amber-400">→ {state.confluence.hold}</span>
                  <span className="ml-auto font-normal text-muted-foreground/70">{t("towerMtfHint")}</span>
                </div>
              </div>
            </section>

            {/* ── news radar ── */}
            <section aria-label={t("towerNews")} className="rounded-lg border border-border bg-card/60">
              <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
                <Newspaper className="h-3.5 w-3.5 text-primary" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("towerNews")}
                </span>
                {state.news.riskWindow && (
                  <span className="rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-px font-mono text-[8px] font-black uppercase text-amber-400">
                    {t("towerNewsRisk")}
                  </span>
                )}
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/70">
                  {timeAgoShort(state.news.fetchedAt)} {t("ago")}
                </span>
              </div>
              <div className="max-h-44 overflow-y-auto slim-scroll">
                {state.news.items.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {state.news.error ? t("towerNewsError") : t("towerNewsEmpty")}
                  </div>
                ) : (
                  state.news.items.map((n, i) => (
                    <a
                      key={i}
                      href={n.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-start gap-2 border-b border-border/40 px-3 py-2 last:border-0 hover:bg-muted/40"
                    >
                      <span className="mt-0.5 shrink-0 rounded border border-border bg-background px-1 py-px font-mono text-[7px] font-bold uppercase text-muted-foreground">
                        {n.source || "web"}
                      </span>
                      <span className="min-w-0 flex-1 text-[10px] leading-snug text-foreground/90 group-hover:text-foreground">
                        {n.title}
                      </span>
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden />
                    </a>
                  ))
                )}
              </div>
            </section>

            {/* ── agent activity feed ── */}
            <section aria-label={t("towerEvents")} className="rounded-lg border border-border bg-card/60">
              <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
                <History className="h-3.5 w-3.5 text-primary" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("towerEvents")}
                </span>
              </div>
              <div className="max-h-52 overflow-y-auto slim-scroll">
                {state.events.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
                    <Bot className="h-4 w-4" aria-hidden />
                    {t("towerEventsEmpty")}
                  </div>
                ) : (
                  state.events.map((ev, i) => (
                    <div
                      key={`${ev.at}-${i}`}
                      className="flex items-start gap-2 border-b border-border/40 px-3 py-2 last:border-0"
                    >
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1.5 py-px font-mono text-[8px] font-bold",
                          EVENT_TONE[ev.tone] ?? EVENT_TONE.info,
                        )}
                      >
                        {ev.agent}
                      </span>
                      <span className="min-w-0 flex-1 text-[10px] leading-snug text-foreground/90">
                        {ev.text}
                      </span>
                      <span className="shrink-0 font-mono text-[8px] text-muted-foreground/60">
                        {timeAgoShort(ev.at)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
