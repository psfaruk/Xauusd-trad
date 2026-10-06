"use client";

import { useEffect, useState } from "react";
import { motion, type Variants } from "framer-motion";
import type { AnalysisResponse } from "@/lib/market/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Activity, Waves, CandlestickChart, ChevronDown } from "lucide-react";
import type { CandlePattern, CandlePatternStat } from "@/lib/market/types";

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

function UpdatedAgo({ at }: { at: number | undefined }) {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  const fresh = s < 35;
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 font-mono text-[9px] normal-case",
        fresh ? "text-up" : "text-muted-foreground",
      )}
      title={t("lastUpdate")}
    >
      <span
        className={cn("h-1 w-1 rounded-full", fresh ? "live-dot bg-up" : "bg-muted-foreground/50")}
        aria-hidden="true"
      />
      {t("lastUpdate")} · {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}
    </span>
  );
}

// ═══════════════ v19.0 — the candlestick strategy section ═══════════════
//
// User spec: "কোনো টাইম ফ্রেমে কোনো ক্যান্ডেল, মার্কেটের কোনো পজিশনে হলে এটার
// লজিক কি? মার্কেট আপ যাবে নাকি ডাউন?" — every detected 1–5 candle setup
// with its WHY logic, the predicted direction, the priced plan and the
// pattern's OWN verified win rate from the walk-forward backtest.

const CANDLE_STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  fresh: { dot: "bg-gold", label: "candleWatch" },
  confirmed: { dot: "bg-up", label: "candleConfirmed" },
  failed: { dot: "bg-down", label: "candleFailed" },
  expired: { dot: "bg-muted-foreground/50", label: "candleNoConfirm" },
};

function CandleCard({
  p,
  stat,
  digits,
}: {
  p: CandlePattern;
  stat?: CandlePatternStat;
  digits: number;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const bull = p.side === "bull";
  const st = CANDLE_STATUS_STYLE[p.status] ?? CANDLE_STATUS_STYLE.expired;
  const logic = locale === "bn" ? p.logicBn : p.logicEn;
  const name = locale === "bn" ? p.nameBn : p.nameEn;
  const outcome =
    p.status === "confirmed"
      ? p.outcome === "won"
        ? t("candleWon")
        : p.outcome === "lost"
          ? t("candleLost")
          : p.outcome === "open"
            ? t("candleOpen")
            : null
      : null;
  // the market-position context line — mono codes, language-neutral
  const ctxBits: string[] = [];
  ctxBits.push(p.context.trendInto === "up" ? "↑ leg" : p.context.trendInto === "down" ? "↓ leg" : "→ leg");
  if (p.context.atLevel) ctxBits.push(`${p.context.atLevel === "support" ? "S" : "R"} ${p.context.levelPrice?.toFixed(digits)}`);
  ctxBits.push(p.context.structure);
  if (p.context.rsi != null) ctxBits.push(`RSI ${p.context.rsi.toFixed(0)}`);
  if (p.context.volZ >= 1.5) ctxBits.push(`vol +${p.context.volZ.toFixed(1)}σ`);

  return (
    <div
      className={cn(
        "rounded-lg border p-2 transition-colors",
        p.status === "expired" || p.status === "failed"
          ? "border-border/60 bg-card/30 opacity-75"
          : bull
            ? "border-up/25 bg-up/[0.04]"
            : "border-down/25 bg-down/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot)} aria-hidden="true" />
        <span className="truncate text-[11px] font-bold">{name}</span>
        <span className="shrink-0 rounded border border-border bg-muted/40 px-1 font-mono text-[8px] text-muted-foreground">
          {p.n}×
        </span>
        <span className={cn("shrink-0 font-mono text-[10px] font-bold", bull ? "text-up" : "text-down")}>
          {bull ? "▲" : "▼"}
        </span>
        <span className="tnum shrink-0 font-mono text-[9px] text-muted-foreground">{p.confidence}%</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {outcome && (
            <span
              className={cn(
                "rounded px-1 font-mono text-[8px] font-bold uppercase",
                p.outcome === "won" ? "bg-up/15 text-up" : p.outcome === "lost" ? "bg-down/15 text-down" : "bg-gold/15 text-gold",
              )}
            >
              {outcome}
            </span>
          )}
          <span className="font-mono text-[8px] uppercase text-muted-foreground/70">{t(st.label)}</span>
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground/60 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      <div className="mt-1 flex items-center gap-2 font-mono text-[9px]">
        <span className="text-muted-foreground/70">
          {t("entry")} <span className="tnum font-bold text-foreground">{p.entry.toFixed(digits)}</span>
          {p.status === "fresh" && <span className="text-gold"> ({t("candlePendingEntry")})</span>}
        </span>
        <span className="text-muted-foreground/70">
          {t("stopLoss")} <span className="tnum text-down">{p.sl.toFixed(digits)}</span>
        </span>
        <span className="text-muted-foreground/70">
          {t("takeProfit")} <span className="tnum text-up">{p.tp.toFixed(digits)}</span>
        </span>
        <span className="ml-auto tnum text-muted-foreground">{p.rr.toFixed(2)}R</span>
      </div>
      {open && (
        <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
          <div className="font-mono text-[8.5px] text-muted-foreground/80">{ctxBits.join("  ·  ")}</div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">{t("candleWhy")}</div>
          <ul className="space-y-0.5">
            {logic.map((l, i) => (
              <li key={i} className="flex gap-1 text-[10px] leading-snug text-foreground/85">
                <span className={cn("shrink-0 font-bold", bull ? "text-up" : "text-down")} aria-hidden="true">›</span>
                {l}
              </li>
            ))}
          </ul>
          {stat && stat.fired >= 3 && (
            <div className="font-mono text-[8.5px] text-muted-foreground/80">
              {t("candleVerified")}: {stat.fired}× · {stat.winPct}% {t("candleWin")} ·{" "}
              <span className={stat.totalR >= 0 ? "text-up" : "text-down"}>
                {stat.totalR >= 0 ? "+" : ""}{stat.totalR}R
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalysisPanel({ analysis }: { analysis: AnalysisResponse | null }) {
  const { t } = useI18n();
  const s = analysis?.snapshot;
  const digits = analysis?.digits ?? 2;

  const rsiTone =
    s == null
      ? "text-foreground"
      : s.rsi >= 70
        ? "text-down"
        : s.rsi <= 30
          ? "text-up"
          : "text-foreground";
  const macdTone = s == null ? "text-foreground" : s.macdHist > 0 ? "text-up" : "text-down";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-bold uppercase tracking-wider">
        <Activity className="h-3.5 w-3.5 text-gold" />
        {t("indicators")}
        <UpdatedAgo at={analysis?.generatedAt} />
      </div>
      {s ? (
        <ScrollArea className="slim-scroll min-h-0 flex-1">
          <motion.div
            variants={listVariants}
            initial="hidden"
            animate="show"
            className="space-y-3 p-3"
          >
          {/* trend per TF */}
          {/* v19.0 — the candlestick strategy read (the headline section) */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="mb-2 flex items-center gap-1.5">
              <CandlestickChart className="h-3 w-3 text-gold" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {t("candleStrategy")}
              </span>
              {analysis!.candleBacktest && analysis!.candleBacktest.overall.fired > 0 && (
                <span className="ml-auto flex items-center gap-1.5 font-mono text-[8.5px]">
                  <span className="text-muted-foreground/70">{analysis!.candleBacktest.overall.fired}×</span>
                  <span className={analysis!.candleBacktest.overall.winPct >= 45 ? "text-up" : "text-muted-foreground"}>
                    {analysis!.candleBacktest.overall.winPct}% {t("candleWin")}
                  </span>
                  <span className={analysis!.candleBacktest.overall.totalR >= 0 ? "text-up" : "text-down"}>
                    {analysis!.candleBacktest.overall.totalR >= 0 ? "+" : ""}{analysis!.candleBacktest.overall.totalR}R
                  </span>
                </span>
              )}
            </div>
            {analysis!.candles.length ? (
              <div className="space-y-1.5">
                {analysis!.candles.map((p) => (
                  <CandleCard
                    key={p.id}
                    p={p}
                    stat={analysis!.candleBacktest?.byCode.find((c) => c.code === p.code)}
                    digits={digits}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">{t("candleNoSetups")}</p>
            )}
          </motion.div>

          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
              {t("trend")}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {([
                ["M5", s.trendM5],
                ["M15", s.trendM15],
                ["H1", s.trendH1],
                ["H4", s.trendH4],
              ] as const).map(([tf, tr]) => (
                <div key={tf} className="rounded-md border border-border bg-muted/30 p-1.5 text-center">
                  <div className="font-mono text-[9px] text-muted-foreground">{tf}</div>
                  <div
                    className={cn(
                      "text-[10px] font-bold",
                      tr === "bullish" ? "text-up" : tr === "bearish" ? "text-down" : "text-muted-foreground",
                    )}
                  >
                    {tr === "bullish" ? "BULL" : tr === "bearish" ? "BEAR" : "FLAT"}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* battle bar */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {/* v16.4 (audit §2.4): MT5 gives TICK volume — label it so the
                    buy/sell split is never read as exchange consolidated flow. */}
                CANDLE BATTLE · {t("tickVol")}
              </span>
              <span className="font-mono text-[9px] uppercase text-muted-foreground">{s.battle.state}</span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full">
              <div className="bg-up/80" style={{ width: `${s.battle.buyPct}%` }} />
              <div className="bg-down/80" style={{ width: `${s.battle.sellPct}%` }} />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px]">
              <span className="text-up">{t("buyers")} {s.battle.buyPct.toFixed(0)}%</span>
              <span className="text-down">{t("sellers")} {s.battle.sellPct.toFixed(0)}%</span>
            </div>
          </motion.div>

          {/* indicator grid */}
          <motion.div variants={itemVariants} className="grid grid-cols-2 gap-1.5">
            <Stat label="RSI 14" value={s.rsi.toFixed(1)} tone={rsiTone} bar={s.rsi} />
            <Stat label="ATR 14" value={s.atr.toFixed(digits)} />
            <Stat label="ADX 14" value={s.adx.toFixed(1)} tone={s.adx >= 28 ? "text-gold" : "text-foreground"} />
            <Stat label="Kaufman ER" value={s.er.toFixed(2)} />
            <Stat label="MACD hist" value={s.macdHist.toFixed(digits)} tone={macdTone} />
            <Stat label="Stoch %K/%D" value={`${s.stochK.toFixed(0)}/${s.stochD.toFixed(0)}`} />
            <Stat label="BB %B" value={s.bbPctB.toFixed(2)} />
            <Stat label="Vol z-score" value={s.volZ.toFixed(1)} tone={s.volZ >= 2.2 ? "text-gold" : "text-foreground"} />
          </motion.div>

          {/* EMA stack */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
              EMA STACK
            </div>
            {([
              ["EMA 9", s.ema9, "text-up"],
              ["EMA 21", s.ema21, "text-gold"],
              ["EMA 50", s.ema50, "text-muted-foreground"],
            ] as const).map(([label, v, tone]) => (
              <div key={label} className="flex items-center gap-2 py-0.5">
                <span className="w-14 text-[10px] text-muted-foreground">{label}</span>
                <div className="h-0.5 flex-1 rounded" style={{ background: "var(--border)" }}>
                  <div
                    className={cn("h-full rounded", tone)}
                    style={{
                      width: `${Math.min(100, Math.max(4, ((v - analysis!.price * 0.995) / (analysis!.price * 0.01)) * 100))}%`,
                    }}
                  />
                </div>
                <span className={cn("tnum w-16 text-right font-mono text-[10px] font-bold", tone)}>
                  {v.toFixed(digits)}
                </span>
              </div>
            ))}
          </motion.div>

          {/* regime */}
          <motion.div variants={itemVariants} className="rounded-lg border border-border bg-card/50 p-2.5">
            <div className="mb-1 flex items-center gap-1.5">
              <Waves className="h-3 w-3 text-gold" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {t("regime")}
              </span>
              <span className="ml-auto rounded border border-gold/30 bg-gold/10 px-1.5 py-px font-mono text-[9px] font-bold uppercase text-gold">
                {s.regime}
              </span>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">{s.regimeNote}</p>
          </motion.div>

          {/* whale */}
          {s.whale && (
            <motion.div variants={itemVariants} className="rounded-lg border border-gold/30 bg-gold/5 p-2.5">
              <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                WHALE PULSE · {s.whale.bias}
              </div>
              <p className="text-[10px] text-muted-foreground">{s.whale.note}</p>
            </motion.div>
          )}
          </motion.div>
        </ScrollArea>
      ) : (
        <ScrollArea className="slim-scroll min-h-0 flex-1">
          <div className="space-y-3 p-3" aria-busy="true">
            <span className="sr-only">{t("loading")}</span>
            {/* trend per TF */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="mb-2 h-2.5 w-14 rounded bg-muted" />
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-9 rounded-md border border-border bg-muted/30" />
                ))}
              </div>
            </div>
            {/* battle bar */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <div className="h-2.5 w-24 rounded bg-muted" />
                <div className="h-2.5 w-10 rounded bg-muted" />
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                <div className="w-2/3 bg-muted-foreground/20" />
              </div>
            </div>
            {/* indicator grid */}
            <div className="grid grid-cols-2 gap-1.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-md border border-border bg-muted/40" />
              ))}
            </div>
            {/* EMA stack */}
            <div className="animate-pulse rounded-lg border border-border bg-muted/40 p-2.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 py-1">
                  <div className="h-2.5 w-12 rounded bg-muted" />
                  <div className="h-0.5 flex-1 rounded bg-muted" />
                  <div className="h-2.5 w-12 rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  bar,
}: {
  label: string;
  value: string;
  tone?: string;
  bar?: number;
}) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-2">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">{label}</div>
      <div className={cn("tnum font-mono text-sm font-bold", tone ?? "text-foreground")}>{value}</div>
      {bar != null && (
        <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", bar >= 70 ? "bg-down" : bar <= 30 ? "bg-up" : "bg-gold")}
            style={{ width: `${Math.min(100, Math.max(2, bar))}%` }}
          />
        </div>
      )}
    </div>
  );
}
