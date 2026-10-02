"use client";

import { useEffect, useState } from "react";
import type { AnalysisResponse, SignalPayload } from "@/lib/market/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/hooks/useTerminal";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowUpRight,
  ArrowDownRight,
  Check,
  X,
  Zap,
  Activity,
  Crosshair,
} from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  won: "bg-up/15 text-up border-up/30",
  lost: "bg-down/15 text-down border-down/30",
  active: "bg-gold/15 text-gold border-gold/30",
  pending: "bg-primary/15 text-primary border-primary/30",
  expired: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-muted/60 text-muted-foreground/80 border-border/70",
};

/** ticking "updated Xs ago" heartbeat chip */
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
        "flex items-center gap-1 font-mono text-[9px]",
        fresh ? "text-up" : "text-muted-foreground",
      )}
      title={t("lastUpdate")}
    >
      <span className={cn("h-1 w-1 rounded-full", fresh ? "bg-up live-dot" : "bg-muted-foreground/50")} />
      {t("lastUpdate")} {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}
    </span>
  );
}

export function SignalsPanel({ analysis }: { analysis: AnalysisResponse | null }) {
  const { t } = useI18n();
  const { selectedSignalId, setSelectedSignalId } = useTerminal();
  const signals = ((analysis as any)?.signals ?? []) as SignalPayload[];
  const sig = analysis?.signal ?? null;
  const digits = analysis?.digits ?? 2;

  const won = signals.filter((s) => s.status === "won").length;
  const lost = signals.filter((s) => s.status === "lost").length;
  const totalR = signals.reduce((a, s) => a + (s.resultR ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider">
          <Zap className="h-3.5 w-3.5 text-gold" />
          {t("signalAnalysis")}
        </span>
        <span className="flex items-center gap-2">
          {/* v16.4 (audit §2.2/§8): the feed's honesty chip — the last closed
              candle is old (weekend / stalled service) → say so instead of
              presenting frozen data as live. */}
          {analysis?.dataFreshness && !analysis.dataFreshness.fresh && (
            <span
              title={`${t("staleFeed")} — ${Math.round(analysis.dataFreshness.ageSec / 60)}m`}
              className="rounded border border-gold/40 bg-gold/10 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wider text-gold"
            >
              {t("staleFeed")}
            </span>
          )}
          {/* v16.4.1 (audit §10): a PARTIAL feed — the engine wanted all six
              timeframes but some are unavailable; the MTF bias is running
              degraded. Honest ink instead of a silently weaker read. */}
          {analysis?.missingTimeframes && analysis.missingTimeframes.length > 0 && (
            <span
              title={`${t("feedPartialHint")} ${analysis.missingTimeframes.join(" · ")}`}
              className="rounded border border-gold/40 bg-gold/10 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wider text-gold/90"
            >
              {t("feedPartial")} {analysis.missingTimeframes.join("·")}
            </span>
          )}
          <UpdatedAgo at={analysis?.generatedAt} />
          <span className="tnum font-mono text-[10px] text-muted-foreground">
            {won}W / {lost}L · {totalR >= 0 ? "+" : ""}{totalR.toFixed(1)}R
          </span>
        </span>
      </div>
      <ScrollArea className="slim-scroll min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {sig ? (
            <SignalCard
              sig={sig}
              digits={digits}
              selected={selectedSignalId === sig.id}
              onSelect={() => setSelectedSignalId(selectedSignalId === sig.id ? null : sig.id ?? null)}
            />
          ) : analysis === null ? (
            // loading skeleton — engine still warming up
            <div className="space-y-2" aria-busy>
              <div className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
              <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/30" />
              <div className="h-10 animate-pulse rounded-lg border border-border bg-muted/20" />
            </div>
          ) : analysis?.nextSetup ? (
            // the planned next entry — no live signal yet, but the three
            // numbers (entry / SL / target) are already on the chart
            <div className="rounded-lg border border-gold/30 border-dashed bg-gold/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black tracking-wider",
                    analysis.nextSetup.dir === "BUY" ? "bg-up text-background" : "bg-down text-background",
                  )}
                >
                  {analysis.nextSetup.dir === "BUY" ? (
                    <ArrowUpRight className="h-3 w-3" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3" />
                  )}
                  {analysis.nextSetup.dir === "BUY" ? t("buy") : t("sell")}
                </span>
                <span className="flex items-center gap-1 rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                  <Crosshair className="h-3 w-3" />
                  {t("nextSetup")}
                </span>
                <span className="ml-auto rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                  {analysis.nextSetup.source}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <LabeledValue label={t("entry")} value={analysis.nextSetup.entry.toFixed(digits)} className="text-gold" />
                <LabeledValue label={t("stopLoss")} value={analysis.nextSetup.sl.toFixed(digits)} className="text-down" />
                <LabeledValue label={t("takeProfit")} value={analysis.nextSetup.tp.toFixed(digits)} className="text-up" />
                <LabeledValue label={t("riskReward")} value={`1:${analysis.nextSetup.rr.toFixed(1)}`} className="text-foreground" />
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                {analysis.nextSetup.reason} · {t("nextSetupHint")}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-4">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">{t("noSignal")}</div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">{t("noSignalHint")}</p>
              {analysis?.nearMiss?.length ? (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                    {t("whyNoSignal")}
                  </div>
                  <ul className="space-y-1">
                    {analysis.nearMiss.slice(0, 6).map((m, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <X className="mt-0.5 h-3 w-3 shrink-0 text-down/70" />
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          {sig?.checks?.length ? (
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                {t("checks")}
              </div>
              <ul className="space-y-1">
                {sig.checks.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px]">
                    {c.ok ? (
                      <Check className="h-3 w-3 shrink-0 text-up" />
                    ) : (
                      <X className="h-3 w-3 shrink-0 text-down" />
                    )}
                    <span className="flex-1 text-muted-foreground">{c.name}</span>
                    <span className="tnum font-mono text-[10px] text-foreground">{c.value}</span>
                  </li>
                ))}
              </ul>
              {sig.factors?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {sig.factors.map((f) => (
                    <span key={f} className="rounded border border-border bg-muted/50 px-1 py-px font-mono text-[9px] text-muted-foreground">
                      {f}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
              <Activity className="h-3 w-3" />
              {t("history")}
            </div>
            <div className="space-y-1">
              {signals.length === 0 && (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground/60">
                  —
                </div>
              )}
              {signals.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSignalId(selectedSignalId === s.id ? null : s.id ?? null)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
                    selectedSignalId === s.id && "border-gold/40 bg-gold/5",
                  )}
                >
                  {s.direction === "BUY" ? (
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-up" />
                  ) : (
                    <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-down" />
                  )}
                  <span className="tnum font-mono text-[10px] text-muted-foreground">
                    {new Date((s.barTime ? s.barTime * 1000 : (s.createdAt ?? Date.now())) as any).toISOString().slice(5, 16).replace("T", " ")}
                  </span>
                  <span className="tnum font-mono text-[10px] text-muted-foreground">
                    E {s.entry.toFixed(digits)}
                  </span>
                  <span
                    className={cn(
                      "rounded border px-1 py-px font-mono text-[9px] font-bold uppercase",
                      STATUS_STYLE[s.status] ?? STATUS_STYLE.expired,
                    )}
                  >
                    {t(s.status)}
                    {s.resultR != null ? ` ${s.resultR >= 0 ? "+" : ""}${s.resultR.toFixed(1)}R` : ""}
                  </span>
                  <span className="tnum ml-auto font-mono text-[10px] text-muted-foreground">
                    {(s.confidence * 100).toFixed(0)}%
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function SignalCard({
  sig,
  digits,
  selected,
  onSelect,
}: {
  sig: SignalPayload;
  digits: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const bull = sig.direction === "BUY";
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        bull ? "border-up/30 bg-up/5" : "border-down/30 bg-down/5",
        selected && "ring-1 ring-gold/60",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black tracking-wider",
            bull ? "bg-up text-background" : "bg-down text-background",
          )}
        >
          {bull ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
          {t(sig.direction === "BUY" ? "buy" : "sell")}
        </span>
        <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {sig.trigger}
        </span>
        <span className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {sig.entryType}
        </span>
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase",
            STATUS_STYLE[sig.status] ?? STATUS_STYLE.expired,
          )}
        >
          {t(sig.status)}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <LabeledValue label={t("entry")} value={sig.entry.toFixed(digits)} className="text-gold" />
        <LabeledValue label={t("stopLoss")} value={sig.sl.toFixed(digits)} className="text-down" />
        <LabeledValue label={t("takeProfit")} value={sig.tp.toFixed(digits)} className="text-up" />
        <LabeledValue label={t("riskReward")} value={`1:${sig.rr.toFixed(1)}`} className="text-foreground" />
      </div>
      <div className="mt-2.5">
        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
          {/* v16.4 (audit §10): the engine's number is a confluence SCORE, not
              a calibrated win probability — label it honestly. */}
          <span>{t("score")}</span>
          <span className="tnum font-mono">{(sig.confidence * 100).toFixed(0)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", bull ? "bg-up" : "bg-down")}
            style={{ width: `${Math.round(sig.confidence * 100)}%` }}
          />
        </div>
      </div>
      {sig.entryNote && (
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground">{sig.entryNote}</p>
      )}
      {sig.targetNote && (
        <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">
          {t("takeProfit")}: {sig.targetNote}
        </p>
      )}
    </button>
  );
}

function LabeledValue({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">{label}</div>
      <div className={cn("tnum font-mono text-xs font-bold", className)}>{value}</div>
    </div>
  );
}
