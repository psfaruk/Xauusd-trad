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
  Layers,
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
  const signals = analysis?.signals ?? [];
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
              liveSpread={analysis?.spread}
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

          {analysis?.tfSetups?.length ? (
            // v16.7 — PER-TIMEFRAME ENTRY SETUPS (user spec): every TF's own
            // plan — live signal if active on that TF, else its price-anchored
            // projection. Entries sit near the live price by contract.
            <div className="rounded-lg border border-border bg-muted/20 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <Layers className="h-3 w-3" />
                {t("tfSetups")}
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto slim-scroll pr-0.5">
                {analysis.tfSetups.map((s) => (
                  <div key={s.tf} className="flex items-center gap-1.5 text-[10px] leading-none">
                    <span className="w-8 shrink-0 rounded bg-muted px-1 py-1 text-center font-mono text-[9px] font-bold text-foreground/80">
                      {s.tf}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11px] font-bold",
                        s.dir === "BUY" ? "text-up" : "text-down",
                      )}
                    >
                      {s.dir === "BUY" ? "▲" : "▼"} {s.entry.toFixed(digits)}
                    </span>
                    <span className="truncate font-mono text-[9px] text-muted-foreground">
                      SL {s.sl.toFixed(digits)} · TP {s.tp.toFixed(digits)}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <span className="font-mono text-[9px] text-muted-foreground/80">
                        {s.rr.toFixed(1)}R
                      </span>
                      <span
                        className={cn(
                          "rounded px-1 py-0.5 font-mono text-[8px] font-bold uppercase",
                          s.kind === "signal" ? "bg-up/15 text-up" : "bg-gold/10 text-gold",
                        )}
                      >
                        {s.kind === "signal" ? t("liveChip") : t("planChip")}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] leading-snug text-muted-foreground/70">
                {t("tfSetupsHint")}
              </p>
            </div>
          ) : null}

          {sig && Array.isArray(sig.checks) && sig.checks.length > 0 ? (
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
              {Array.isArray(sig.factors) && sig.factors.length > 0 ? (
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
  liveSpread,
  selected,
  onSelect,
}: {
  sig: SignalPayload;
  digits: number;
  /** v17.0: the analysis payload's live spread — shown next to the
   *  spread captured at signal time so cost drift is visible */
  liveSpread?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const bull = sig.direction === "BUY";
  const risk = Math.abs(sig.entry - sig.sl);
  const spreadAt = sig.spreadAt ?? liveSpread;
  const spreadLive = liveSpread != null && sig.spreadAt != null && Math.abs((liveSpread ?? 0) - sig.spreadAt) > 1e-9
    ? liveSpread
    : null;
  const fmtT = (sec: number) =>
    new Date(sec * 1000).toISOString().slice(11, 16) + " UTC";
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
        {/* v17.0: source TF + creation time — the audit's "timestamp, source" */}
        <span className="tnum ml-auto font-mono text-[9px] text-muted-foreground">
          {sig.timeframe} · {(sig.createdAt ?? new Date().toISOString()).slice(5, 16).replace("T", " ")}
        </span>
      </div>
      {/* v17.0: lifecycle sentence — what keeps this signal alive */}
      {(sig.status === "active" || sig.status === "pending") && (
        <p className="mb-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {sig.status === "active"
            ? t("cardHolding")
            : `${t("cardPending")}${sig.expiryBars != null ? ` · ${sig.expiryBars} ${t("cardBars")}` : ""}`}
        </p>
      )}
      {/* v16.9 (audit §5.5): the partial TP ladder — TP2 (runner) rides next
          to the bank target when the signal carries one */}
      <div className={cn("grid gap-2", sig.tp2 != null ? "grid-cols-5" : "grid-cols-4")}>
        <LabeledValue label={t("entry")} value={sig.entry.toFixed(digits)} className="text-gold" />
        <LabeledValue label={t("stopLoss")} value={sig.sl.toFixed(digits)} className="text-down" />
        <LabeledValue label={t("takeProfit")} value={sig.tp.toFixed(digits)} className="text-up" />
        {sig.tp2 != null && (
          <LabeledValue label="TP2" value={sig.tp2.toFixed(digits)} className="text-[#2dd4bf]" />
        )}
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

      {/* ── v17.0 (audit P2): WHY / INVALIDATION / COSTS / SOURCE ── */}
      {sig.entryNote && (
        <div className="mt-2.5 rounded-md border border-border/70 bg-muted/20 px-2 py-1.5">
          <div className="mb-0.5 text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">
            {t("cardWhy")}
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">{sig.entryNote}</p>
        </div>
      )}
      <div className="mt-2 rounded-md border border-down/20 bg-down/5 px-2 py-1.5">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/70">
            {t("cardInvalidation")}
          </span>
          <span className="tnum font-mono text-[10px] font-bold text-down">{sig.sl.toFixed(digits)}</span>
        </div>
        <p className="text-[9px] leading-snug text-muted-foreground/80">{t("cardInvalidationHint")}</p>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 rounded-md border border-border/70 bg-card/40 px-2 py-1.5">
        <div>
          <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/60">{t("cardSpread")}</div>
          <div className="tnum font-mono text-[10px] font-bold text-foreground">
            {spreadAt != null ? spreadAt.toFixed(digits) : "—"}
            {spreadLive != null && (
              <span className="ml-1 font-normal text-muted-foreground" title={t("cardSpreadLive")}>
                ({spreadLive.toFixed(digits)})
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/60">{t("cardAtr")}</div>
          <div className="tnum font-mono text-[10px] font-bold text-foreground">
            {sig.atrAt != null ? (
              <>
                {sig.atrAt.toFixed(digits)}
                <span className="ml-1 font-normal text-muted-foreground">({(risk / sig.atrAt).toFixed(1)}×ATR)</span>
              </>
            ) : (
              `1R ${risk.toFixed(digits)}`
            )}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground/60">{t("cardRiskPerTrade")}</div>
          <div className="tnum font-mono text-[10px] font-bold text-foreground">1R = {risk.toFixed(digits)}</div>
        </div>
      </div>
      {sig.sourceBar && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/10 px-2 py-1">
          <span className="shrink-0 text-[8px] font-bold uppercase tracking-wider text-muted-foreground/60">
            {t("cardSourceBar")}
          </span>
          <span className="tnum truncate font-mono text-[9px] text-muted-foreground">
            {fmtT(sig.sourceBar.t)} · O {sig.sourceBar.o.toFixed(digits)} H {sig.sourceBar.h.toFixed(digits)} L {sig.sourceBar.l.toFixed(digits)} C {sig.sourceBar.c.toFixed(digits)}
          </span>
        </div>
      )}
      {sig.targetNote && (
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground/70">
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
