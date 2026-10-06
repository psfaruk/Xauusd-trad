"use client";

/**
 * BacktestPanel — walk-forward backtest of the live signal engine over the
 * real MT5 history for the active market + timeframe (GET /api/backtest).
 * Auto-runs on mount and re-runs fresh whenever the symbol/timeframe changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, type Variants } from "framer-motion";
import type { AnalysisResponse, SignalPayload } from "@/lib/market/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/hooks/useTerminal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  FlaskConical,
  Play,
  Loader2,
  RotateCcw,
  History,
  Target,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  CandlestickChart,
} from "lucide-react";

/** GET /api/backtest payload (mirror of the API route shape). */
interface TriggerStat {
  n: number;
  won: number;
  lost: number;
  totalR: number;
}

interface BacktestStats {
  signals: number;
  won: number;
  lost: number;
  expired: number;
  cancelled: number;
  winPct: number;
  totalR: number;
  expectancy: number;
  avgRR: number;
  byTrigger: Record<string, TriggerStat>;
}

interface BacktestResponse {
  symbol: string;
  tf: string;
  digits: number;
  scanned: number;
  stats: BacktestStats;
  /** v19.0 — the candle-engine walk-forward stats on the same bars */
  candles: import("@/lib/market/types").CandleBacktest;
  signals: SignalPayload[];
  generatedAt: number;
}

const STATUS_STYLE: Record<string, string> = {
  won: "bg-up/15 text-up border-up/30",
  lost: "bg-down/15 text-down border-down/30",
  active: "bg-gold/15 text-gold border-gold/30",
  pending: "bg-primary/15 text-primary border-primary/30",
  expired: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-muted/60 text-muted-foreground/80 border-border/60",
};

const CONTAINER_V: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.03 } },
};

const ITEM_V: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
};

const rTone = (v: number) =>
  v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground";
const fmtR = (v: number, dp = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(dp)}R`;

export function BacktestPanel({ analysis }: { analysis?: AnalysisResponse | null }) {
  const { t } = useI18n();
  const { symbol, timeframe } = useTerminal();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  // v19.0: plain fetch + state (the app's own convention — useFeed does the
  // same). This panel was the app's ONLY React-Query consumer and its
  // useMutation never settled under React 19 dev (the mutationFn resolved —
  // fetch 200, JSON parsed — but isPending stayed true forever, leaving the
  // panel on an eternal "BACKTESTING…" skeleton; verified in-browser).
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setIsPending(true);
    setIsError(false);
    setError(null);
    try {
      const res = await fetch(
        `/api/backtest?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(timeframe)}`,
      );
      if (!res.ok) throw new Error(`backtest ${res.status}`);
      setData((await res.json()) as BacktestResponse);
    } catch (e) {
      setIsError(true);
      setError(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setIsPending(false);
    }
  }, [symbol, timeframe]);

  // auto-run once on mount + a fresh run whenever the market/timeframe
  // changes (the ref dedupes strict-mode double effects; retries on error
  // go through the run/retry buttons)
  const attemptedRef = useRef<string>("");
  useEffect(() => {
    const key = `${symbol}|${timeframe}`;
    if (attemptedRef.current === key) return;
    attemptedRef.current = key;
    void run();
  }, [symbol, timeframe, run]);

  // only show results that belong to the CURRENT market + timeframe —
  // a stale result (symbol/tf just switched) is treated as a reset
  const fresh = data && data.symbol === symbol && data.tf === timeframe ? data : null;
  const digits = fresh?.digits ?? analysis?.digits ?? 2;
  const st = fresh?.stats;
  const winTone =
    st == null ? "" : st.winPct >= 45 ? "text-up" : st.winPct >= 35 ? "text-gold" : "text-down";

  const doRun = () => void run();

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider">
            <FlaskConical className="h-3.5 w-3.5 text-gold" />
            {t("backtestTitle")}
          </span>
          <span className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {symbol} · {timeframe}
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground/70">{t("backtestHint")}</p>
      </div>

      <ScrollArea className="slim-scroll min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {/* run button */}
          <Button
            size="sm"
            className="h-8 w-full gap-1.5 text-[11px] font-bold uppercase tracking-wider"
            disabled={isPending}
            onClick={doRun}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {isPending ? t("backtestRunning") : t("backtestRun")}
          </Button>

          {/* loading skeleton */}
          {isPending && !fresh && (
            <div aria-busy="true">
              <span className="sr-only">{t("loading")}</span>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/40" />
                  <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/40" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-11 animate-pulse rounded-lg border border-border bg-muted/40" />
                  ))}
                </div>
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted/40" />
                <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/40" />
                <div className="space-y-1.5">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-7 animate-pulse rounded-md bg-muted/40" />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* error */}
          {isError && !fresh && (
            <div className="rounded-lg border border-down/30 bg-down/5 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-down">
                <AlertTriangle className="h-3.5 w-3.5" />
                {error ?? "backtest failed"}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[10px] font-bold uppercase tracking-wider"
                onClick={doRun}
              >
                <RotateCcw className="h-3 w-3" />
                {t("retry")}
              </Button>
            </div>
          )}

          {/* not enough history */}
          {fresh && st && st.signals === 0 && (
            <div className="rounded-lg border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground/70">
              {t("backtestNoData")}
            </div>
          )}

          {/* results */}
          {fresh && st && st.signals > 0 && (
            <motion.div
              key={`${fresh.symbol}|${fresh.tf}|${fresh.generatedAt}`}
              variants={CONTAINER_V}
              initial="hidden"
              animate="show"
              className="space-y-3"
            >
              {/* hero stats — win rate + total R */}
              <div className="grid grid-cols-2 gap-2">
                <motion.div variants={ITEM_V} className="rounded-lg border border-border bg-card/50 p-2.5">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
                    {t("backtestWinRate")}
                  </div>
                  <div className={cn("tnum font-mono text-2xl font-black leading-tight", winTone)}>
                    {st.winPct.toFixed(0)}%
                  </div>
                  <div className="tnum font-mono text-[10px]">
                    <span className="text-up">{st.won}W</span>
                    <span className="text-muted-foreground/50"> · </span>
                    <span className="text-down">{st.lost}L</span>
                  </div>
                </motion.div>
                <motion.div variants={ITEM_V} className="rounded-lg border border-border bg-card/50 p-2.5">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
                    {t("backtestTotalR")}
                  </div>
                  <div className={cn("tnum font-mono text-2xl font-black leading-tight", rTone(st.totalR))}>
                    {fmtR(st.totalR)}
                  </div>
                  <div className="tnum font-mono text-[10px] text-muted-foreground">
                    {t("backtestExpectancy")} {fmtR(st.expectancy, 2)}
                  </div>
                </motion.div>
              </div>

              {/* secondary stats */}
              <div className="grid grid-cols-3 gap-2">
                <motion.div variants={ITEM_V}>
                  <MiniStat label={t("backtestAvgRR")} value={`1:${st.avgRR.toFixed(1)}`} tone="text-gold" />
                </motion.div>
                <motion.div variants={ITEM_V}>
                  <MiniStat label={t("backtestSignals")} value={String(st.signals)} />
                </motion.div>
                <motion.div variants={ITEM_V}>
                  <MiniStat label={t("backtestScanned")} value={String(fresh.scanned)} />
                </motion.div>
              </div>

              {/* outcome chips */}
              <motion.div variants={ITEM_V} className="flex flex-wrap items-center gap-1">
                {(
                  [
                    ["won", st.won],
                    ["lost", st.lost],
                    ["expired", st.expired],
                    ["cancelled", st.cancelled],
                  ] as const
                ).map(([k, n]) => (
                  <span
                    key={k}
                    className={cn(
                      "rounded border px-1.5 py-px font-mono text-[9px] font-bold uppercase",
                      STATUS_STYLE[k],
                    )}
                  >
                    {n} {t(k)}
                  </span>
                ))}
              </motion.div>

              {/* per-trigger breakdown */}
              <motion.div variants={ITEM_V} className="rounded-lg border border-border bg-card/50 p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                  <Target className="h-3 w-3" />
                  {t("backtestByTrigger")}
                </div>
                <div className="space-y-1">
                  {Object.entries(st.byTrigger)
                    .sort((a, b) => b[1].n - a[1].n)
                    .map(([name, s]) => (
                      <div key={name} className="flex items-center gap-2 font-mono text-[10px]">
                        <span className="w-16 shrink-0 truncate uppercase text-muted-foreground">{name}</span>
                        <span className="tnum w-7 shrink-0 text-muted-foreground/70">{s.n}×</span>
                        <span className="tnum flex-1">
                          <span className="text-up">{s.won}W</span>
                          <span className="text-muted-foreground/50"> / </span>
                          <span className="text-down">{s.lost}L</span>
                        </span>
                        <span className={cn("tnum shrink-0 font-bold", rTone(s.totalR))}>
                          {fmtR(s.totalR)}
                        </span>
                      </div>
                    ))}
                </div>
              </motion.div>

              {/* v19.0 — the candle-engine backtest (confirmation-entry fills) */}
              {fresh.candles && fresh.candles.overall.fired > 0 && (
                <motion.div variants={ITEM_V} className="rounded-lg border border-gold/25 bg-gold/[0.03] p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                    <CandlestickChart className="h-3 w-3 text-gold" />
                    {t("candleBtTitle")}
                  </div>
                  <p className="mb-1.5 text-[9px] leading-snug text-muted-foreground/80">{t("candleBtHint")}</p>
                  <div className="mb-2 flex flex-wrap items-center gap-1 font-mono text-[10px]">
                    <span className="rounded border border-border bg-muted/40 px-1.5 py-px text-muted-foreground">
                      {fresh.candles.overall.fired}×
                    </span>
                    <span className="text-up">{fresh.candles.overall.won}W</span>
                    <span className="text-muted-foreground/50">/</span>
                    <span className="text-down">{fresh.candles.overall.lost}L</span>
                    <span className={cn("tnum ml-1 font-bold", rTone(fresh.candles.overall.totalR))}>
                      {fmtR(fresh.candles.overall.totalR)}
                    </span>
                    <span className="ml-auto text-muted-foreground/70">
                      {fresh.candles.overall.winPct}% · avg {fmtR(fresh.candles.overall.avgR)}
                    </span>
                  </div>
                  {/* by candle count — which N works on this tape */}
                  <div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
                    {t("candleByCount")}
                  </div>
                  <div className="mb-2 grid grid-cols-5 gap-1">
                    {fresh.candles.byN.map((n) => (
                      <div key={n.n} className="rounded border border-border bg-muted/30 p-1 text-center">
                        <div className="font-mono text-[9px] text-muted-foreground">{n.n}×</div>
                        <div className={cn("tnum font-mono text-[10px] font-bold", n.winPct >= 45 ? "text-up" : "text-muted-foreground")}>
                          {n.winPct}%
                        </div>
                        <div className={cn("tnum font-mono text-[8px]", rTone(n.avgR))}>{fmtR(n.avgR, 2)}</div>
                      </div>
                    ))}
                  </div>
                  {/* per-pattern table */}
                  <div className="space-y-0.5">
                    {fresh.candles.byCode.slice(0, 8).map((c) => (
                      <div key={c.code} className="flex items-center gap-2 font-mono text-[10px]">
                        <span className="w-3 shrink-0 text-center">{c.side === "bull" ? "▲" : "▼"}</span>
                        <span className="w-20 shrink-0 truncate text-muted-foreground">{c.code}</span>
                        <span className="tnum w-7 shrink-0 text-muted-foreground/70">{c.fired}×</span>
                        <span className="tnum flex-1">
                          <span className="text-up">{c.won}W</span>
                          <span className="text-muted-foreground/50"> / </span>
                          <span className="text-down">{c.lost}L</span>
                        </span>
                        <span className="tnum w-9 shrink-0 text-muted-foreground/80">{c.winPct}%</span>
                        <span className={cn("tnum w-14 shrink-0 text-right font-bold", rTone(c.totalR))}>
                          {fmtR(c.totalR)}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* signal history */}
              <motion.div variants={ITEM_V}>
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                  <History className="h-3 w-3" />
                  {t("history")}
                </div>
                <div className="space-y-1">
                  {fresh.signals.map((s, i) => {
                    const open = openIdx === i;
                    return (
                      <div key={`${s.barTime}-${i}`}>
                        <button
                          onClick={() => setOpenIdx(open ? null : i)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
                            open && "border-gold/40 bg-gold/5",
                          )}
                        >
                          {s.direction === "BUY" ? (
                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-up" />
                          ) : (
                            <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-down" />
                          )}
                          <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">
                            {new Date(s.barTime * 1000).toISOString().slice(5, 16).replace("T", " ")}
                          </span>
                          <span className="tnum min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                            E {s.entry.toFixed(digits)}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded border px-1 py-px font-mono text-[9px] font-bold uppercase",
                              STATUS_STYLE[s.status] ?? STATUS_STYLE.expired,
                            )}
                          >
                            {t(s.status)}
                            {s.resultR != null ? ` ${s.resultR >= 0 ? "+" : ""}${s.resultR.toFixed(1)}R` : ""}
                          </span>
                          <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">
                            {(s.confidence * 100).toFixed(0)}%
                          </span>
                        </button>
                        {open && (
                          <div className="mx-2 mb-1 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                {s.trigger}
                              </span>
                              <span className="rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                {s.entryType}
                              </span>
                              <span className="rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                R:R 1:{s.rr.toFixed(1)}
                              </span>
                              <span className="tnum rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] text-gold">
                                {t("entry")} {s.entry.toFixed(digits)}
                              </span>
                              <span className="tnum rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] text-down">
                                {t("stopLoss")} {s.sl.toFixed(digits)}
                              </span>
                              <span className="tnum rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] text-up">
                                {t("takeProfit")} {s.tp.toFixed(digits)}
                              </span>
                            </div>
                            {s.entryNote && (
                              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{s.entryNote}</p>
                            )}
                            {s.targetNote && (
                              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">
                                {s.targetNote}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>

              <div className="tnum pt-0.5 text-center font-mono text-[9px] text-muted-foreground/50">
                {new Date(fresh.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
              </div>
            </motion.div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card/50 p-2">
      {/* two-line label reservation keeps values aligned across cells when a
          long label (e.g. "BARS SCANNED" / বাংলা) wraps */}
      <div className="min-h-[22px] text-[9px] font-bold uppercase leading-tight tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <div className={cn("tnum mt-auto font-mono text-sm font-bold leading-tight", tone ?? "text-foreground")}>
        {value}
      </div>
    </div>
  );
}
