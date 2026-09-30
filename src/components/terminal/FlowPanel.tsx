"use client";

/**
 * FlowPanel — the running-candle X-ray: what pro tape-readers see when they
 * "know" where the candle is going, made visible:
 *
 *   • TICK RULE    every uptick = aggressive buying, every downtick = selling
 *   • DELTA        cumulative buyers − sellers inside the LIVE candle
 *   • TAPE SPEED   ticks/sec burst = urgency
 *   • WICK X-RAY   wicks growing against the body = passive rejection
 *   • BATTLE LEVELS price buckets where the most ticks printed
 *   • VERDICT      buyers/sellers control + absorption + bull-close probability
 *
 * Updates up to ~12.5 Hz straight from the MT5 tick stream (pre-throttle).
 * Countdown & tick-age tick at rAF (60 fps) without re-rendering the panel.
 */

import { useEffect, useRef } from "react";
import { useTerminal } from "@/hooks/useTerminal";
import { useFlow, useSymbolList } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FlowPayload, FlowSignal } from "@/lib/market/types";
import { Activity, ArrowDownRight, ArrowUpRight, Minus, MoonStar, TrendingDown, TrendingUp, Zap } from "lucide-react";

const TF_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400,
};

// ── live millisecond counters (rAF, direct DOM — zero re-renders) ──

function TickAge({ ms, className }: { ms: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const age = ms ? Date.now() - ms : 0;
        el.textContent = age ? `${age} ms` : "—";
        el.style.color = age < 800 ? "" : age < 3000 ? "var(--gold)" : "var(--muted-foreground)";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ms]);
  return <span ref={ref} className={cn("tnum font-mono text-[10px]", className)} />;
}

function CandleCountdown({ barOpen, tfSec }: { barOpen: number; tfSec: number }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const left = Math.max(0, barOpen + tfSec - Date.now() / 1000);
      const m = Math.floor(left / 60);
      const s = left - m * 60;
      if (textRef.current) textRef.current.textContent = m > 0 ? `${m}:${s.toFixed(0).padStart(2, "0")}` : `${s.toFixed(1)}s`;
      if (barRef.current) barRef.current.style.width = `${Math.max(0, Math.min(100, (left / tfSec) * 100))}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [barOpen, tfSec]);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-1">
        <span ref={textRef} className="tnum font-mono text-xs font-bold tabular-nums" />
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div ref={barRef} className="h-full rounded-full bg-gold/80" style={{ width: "100%" }} />
      </div>
    </div>
  );
}

// ── verdict ──

/** rAF-driven "LIVE m:ss" hold-duration timer — 60fps, zero re-renders. */
function SinceTimer({ sinceMs }: { sinceMs: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
        const m = Math.floor(s / 60);
        el.textContent = m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sinceMs]);
  return <span ref={ref} className="tnum font-mono" />;
}

/**
 * SignalLamp — the glowing BUY/SELL light.
 *
 * GREEN lamp = the tick engine expects the market UP while it stays green.
 * RED lamp   = the tick engine expects the market DOWN while it stays red.
 * The state machine behind it (server-side, hysteresis + min-hold + cooldown)
 * makes হুটহাট flips impossible — when the colour changes, the tape really
 * changed character. Everything on the card is live: hold time, entry price
 * and points captured since entry.
 */
function SignalLamp({ p, digits }: { p: FlowPayload; digits: number }) {
  const { t } = useI18n();
  const sig = p.sig;
  const engaged = sig.state !== "neutral";
  const isBuy = sig.state === "buy";
  const pct = Math.round(sig.strength * 100);

  if (!engaged) {
    // conviction build-up — how close the tape is to engaging (strength is
    // |raw| as a fraction of the FIRE threshold, so 100% = about to light)
    const firePct = Math.min(100, Math.round(sig.strength * 100));
    const building = firePct >= 28;
    const bullSide = sig.raw >= 0;
    // honest tape-state: at Dhaka midnight the XAU book sleeps (<1.5 tps) —
    // tell the user WHY the lamp waits instead of looking frozen ("waiting
    // dekhay" bug: it was never broken, it was waiting for real flow)
    const quiet = sig.quiet === true;
    const fired = sig.stats?.fired ?? 0;
    return (
      <div
        className={cn(
          "rounded-xl border border-dashed bg-muted/20 px-3 py-2.5 text-center transition-colors duration-500",
          quiet ? "border-amber-500/40 bg-amber-500/5" : "border-border",
        )}
      >
        <div className="flex items-center justify-center gap-2">
          <span className="text-[13px] font-black uppercase tracking-widest text-muted-foreground">
            {t("sigWait")}
          </span>
          {quiet ? (
            <span className="tnum flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-mono text-[9px] font-bold text-amber-600 dark:text-amber-400">
              <MoonStar className="h-2.5 w-2.5" aria-hidden />
              {t("sigQuiet")} · {p.tps.toFixed(1)} t/s
            </span>
          ) : building ? (
            <span
              className={cn(
                "tnum rounded-full border px-1.5 py-px font-mono text-[9px] font-bold",
                bullSide ? "border-up/40 bg-up/10 text-up" : "border-down/40 bg-down/10 text-down",
              )}
            >
              {firePct}% {t("sigToFire")}
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "mt-0.5 text-[9px] font-medium",
            quiet
              ? "text-amber-600/90 dark:text-amber-400/90"
              : building
                ? (bullSide ? "text-up/80" : "text-down/80")
                : "text-muted-foreground/70",
          )}
        >
          {quiet ? t("sigQuietHint") : building ? (bullSide ? t("sigBuildingUp") : t("sigBuildingDown")) : t("sigNoEdge")}
        </div>
        {quiet && p.s.startsWith("XAU") && (
          <div className="mt-0.5 text-[8.5px] font-semibold text-muted-foreground/70">
            BTCUSDm · 24/7
          </div>
        )}
        {/* conviction bar — fills to 100% exactly at the fire threshold */}
        <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              quiet ? "bg-amber-500/60" : bullSide ? "bg-up/70" : "bg-down/70",
            )}
            style={{ width: `${firePct}%`, marginLeft: bullSide ? "0" : "auto" }}
          />
        </div>
        {/* proof the lamp is alive — session fire record under the wait */}
        {fired > 0 && (
          <div className="tnum mt-1.5 font-mono text-[9px] font-semibold text-muted-foreground/80">
            {fired} {t("sigFired").toLowerCase()} {t("sigToday")} · {sig.stats.winPct}% {t("sigWinRate").toLowerCase()} · {t("sigAvgPts")} {sig.stats.avgPts >= 0 ? "+" : ""}{sig.stats.avgPts}{t("sigPts")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${isBuy ? t("sigBuy") : t("sigSell")} ${t("sigSince")}`}
      className={cn(
        "relative overflow-hidden rounded-xl border p-3",
        isBuy ? "lamp-up border-up/60 bg-up/10" : "lamp-down border-down/60 bg-down/10",
      )}
    >
      <div className="flex items-center gap-3">
        {/* the bulb */}
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2",
            isBuy ? "lamp-dot-up border-up/70 bg-up/25 text-up" : "lamp-dot-down border-down/70 bg-down/25 text-down",
          )}
        >
          {isBuy ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
        </span>
        <div className="min-w-0">
          <div className={cn("text-lg font-black uppercase leading-none tracking-[0.2em]", isBuy ? "text-up" : "text-down")}>
            {isBuy ? t("sigBuy") : t("sigSell")}
          </div>
          <div className={cn("mt-1 text-[9px] font-bold", isBuy ? "text-up/75" : "text-down/75")}>
            {isBuy ? t("sigUpHint") : t("sigDownHint")}
          </div>
        </div>
        <div className="ml-auto shrink-0 text-right">
          <div className={cn("tnum font-mono text-base font-black leading-none", sig.pnlPts >= 0 ? "text-up" : "text-down")}>
            {sig.pnlPts >= 0 ? "+" : ""}{sig.pnlPts.toFixed(1)} <span className="text-[9px] font-bold opacity-70">{t("sigPts")}</span>
          </div>
          <div className="mt-1 flex items-center justify-end gap-1 text-[9px] font-bold text-muted-foreground">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
            {t("sigSince")} <SinceTimer sinceMs={sig.sinceMs} />
          </div>
          <div className="tnum mt-0.5 font-mono text-[9px] text-muted-foreground/80">
            {t("sigEntry")} {sig.entryPrice.toFixed(digits)}
          </div>
        </div>
      </div>
      {/* conviction bar — lamp brightness in data form */}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[8px] font-bold uppercase tracking-wide text-muted-foreground/70">{t("sigStrength")}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/70">
          <div
            className={cn("h-full rounded-full transition-all duration-300", isBuy ? "bg-up" : "bg-down")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={cn("tnum font-mono text-[9px] font-bold", isBuy ? "text-up" : "text-down")}>{pct}%</span>
      </div>
    </div>
  );
}

/** Live-tracked record of completed signals — the lamp's honest report card. */
function SignalStats({ sig }: { sig: FlowSignal }) {
  const { t } = useI18n();
  if (!sig.stats.fired) return null;
  const cells: [string, string, string?][] = [
    [t("sigFired"), String(sig.stats.fired)],
    [t("sigWinRate"), `${sig.stats.winPct}%`, sig.stats.winPct >= 50 ? "text-up" : "text-down"],
    [t("sigAvgPts"), `${sig.stats.avgPts >= 0 ? "+" : ""}${sig.stats.avgPts}`, sig.stats.avgPts >= 0 ? "text-up" : "text-down"],
    [t("sigFlips"), String(sig.flips)],
  ];
  return (
    <div className="rounded-lg border border-border bg-card/50 p-2.5">
      <div className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">{t("sigStats")}</div>
      <div className="grid grid-cols-4 gap-1.5">
        {cells.map(([label, value, tone]) => (
          <div key={label} className="min-w-0 text-center">
            <div className={cn("tnum truncate font-mono text-[12px] font-black", tone ?? "text-foreground")}>{value}</div>
            <div className="truncate text-[8px] font-bold uppercase tracking-wide text-muted-foreground/60">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const VERDICT_STYLE = {
  buyers: { border: "border-up/40", bg: "bg-up/10", text: "text-up", key: "flowVerdictBuyers" },
  sellers: { border: "border-down/40", bg: "bg-down/10", text: "text-down", key: "flowVerdictSellers" },
  absorb_top: { border: "border-gold/40", bg: "bg-gold/10", text: "text-gold", key: "flowVerdictAbsorbTop" },
  absorb_bottom: { border: "border-gold/40", bg: "bg-gold/10", text: "text-gold", key: "flowVerdictAbsorbBottom" },
  balanced: { border: "border-border", bg: "bg-muted/30", text: "text-muted-foreground", key: "flowVerdictBalanced" },
} as const;

function VerdictHero({ p }: { p: FlowPayload }) {
  const { t } = useI18n();
  const st = VERDICT_STYLE[p.score.verdict] ?? VERDICT_STYLE.balanced;
  const prob = Math.round(p.score.bullProb * 100);
  const R = 21, C = 2 * Math.PI * R;
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border p-3", st.border, st.bg)}>
      {/* bull-close probability ring */}
      <div className="relative h-14 w-14 shrink-0" role="img" aria-label={`${t("flowBullProb")} ${prob}%`}>
        <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90">
          <circle cx="24" cy="24" r={R} fill="none" strokeWidth="4.5" className="stroke-muted" />
          <circle
            cx="24" cy="24" r={R} fill="none" strokeWidth="4.5" strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - prob / 100)}
            className={prob >= 55 ? "stroke-up" : prob <= 45 ? "stroke-down" : "stroke-gold"}
            style={{ transition: "stroke-dashoffset 300ms ease, stroke 300ms ease" }}
          />
        </svg>
        <span className={cn(
          "tnum absolute inset-0 flex items-center justify-center font-mono text-[13px] font-bold",
          prob >= 55 ? "text-up" : prob <= 45 ? "text-down" : "text-gold",
        )}>
          {prob}%
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-[13px] font-black uppercase tracking-wide", st.text)}>
          {t(st.key)}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          <DriverChip ok={p.score.drivers.confirm} on={t("flowDriverConfirm")} off={t("flowDriverDiverge")} />
          <DriverChip ok={p.score.drivers.speed > 0.15} on={t("flowDriverSpeed")} neutral />
          <DriverChip ok={Math.abs(p.score.drivers.wick) > 0.25} on={t("flowDriverWick")} neutral />
          <DriverChip ok={p.score.drivers.closePos > 0.55 || p.score.drivers.closePos < 0.45} on={t("flowDriverClosePos")} neutral />
        </div>
      </div>
    </div>
  );
}

function DriverChip({ ok, on, off, neutral }: { ok: boolean; on: string; off?: string; neutral?: boolean }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide",
        ok ? (neutral ? "bg-gold/15 text-gold" : "bg-up/15 text-up") : "bg-muted/50 text-muted-foreground",
      )}
      title={off && !ok ? off : on}
    >
      {ok ? on : (off ?? on)}
    </span>
  );
}

// ── the X-ray candle ──

function CandleXray({ p, digits }: { p: FlowPayload; digits: number }) {
  const { t } = useI18n();
  const tfSec = TF_SECONDS[p.tf] ?? 60;
  const range = p.h - p.l || Math.pow(10, -digits);
  const pad = range * 0.18;
  const lo = p.l - pad, hi = p.h + pad;
  const y = (price: number) => 16 + ((hi - price) / (hi - lo)) * 188;
  const bodyTop = y(Math.max(p.o, p.c));
  const bodyBot = y(Math.min(p.o, p.c));
  const bodyH = Math.max(bodyBot - bodyTop, 3);
  const total = p.buy + p.sell;
  const buyFrac = total ? p.buy / total : 0.5;
  const bull = p.c >= p.o;
  const fmt = (x: number) => x.toFixed(digits);

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <Activity className="h-3 w-3 text-gold" />
          {t("flowTitle")}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase text-muted-foreground">{t("flowCandleLeft")}</span>
          <CandleCountdown barOpen={p.t} tfSec={tfSec} />
        </div>
      </div>
      <div className="flex items-stretch gap-3">
        <svg viewBox="0 0 120 220" className="h-52 w-24 shrink-0 overflow-visible" aria-hidden>
          {/* wicks (body colour) */}
          <line x1="60" y1={y(p.h)} x2="60" y2={bodyTop} strokeWidth="2" style={{ stroke: bull ? "var(--up)" : "var(--down)", opacity: 0.75 }} />
          <line x1="60" y1={bodyBot} x2="60" y2={y(p.l)} strokeWidth="2" style={{ stroke: bull ? "var(--up)" : "var(--down)", opacity: 0.75 }} />
          {/* X-ray body — buy/sell split */}
          <rect x="34" y={bodyTop} width="52" height={bodyH} rx="2" fill="var(--down)" opacity="0.85" style={{ transition: "y 150ms ease, height 150ms ease" }} />
          <rect
            x="34" y={bodyTop + bodyH * (1 - buyFrac)} width="52" height={bodyH * buyFrac} rx="2"
            fill="var(--up)" opacity="0.85"
            style={{ transition: "y 150ms ease, height 150ms ease" }}
          />
          {/* open marker */}
          <line x1="22" y1={y(p.o)} x2="98" y2={y(p.o)} strokeWidth="1" strokeDasharray="3 3" className="stroke-muted-foreground" opacity="0.7" />
          {/* high / low ticks */}
          <line x1="52" y1={y(p.h)} x2="68" y2={y(p.h)} strokeWidth="2" className="stroke-foreground/70" />
          <line x1="52" y1={y(p.l)} x2="68" y2={y(p.l)} strokeWidth="2" className="stroke-foreground/70" />
        </svg>
        <div className="flex min-w-0 flex-1 flex-col justify-between py-1 font-mono text-[10px]">
          <StatRow label="H" value={fmt(p.h)} tone="up" />
          <StatRow label="O" value={fmt(p.o)} tone="neutral" />
          <StatRow label="C" value={fmt(p.c)} tone={bull ? "up" : "down"} />
          <StatRow label="L" value={fmt(p.l)} tone="down" />
          <div className="mt-1 border-t border-border pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("flowLastTick")}</span>
              <TickAge ms={p.lastTickMs} />
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("flowTps")}</span>
              <span className="tnum font-bold">
                {p.tps.toFixed(1)}
                <span className="ml-0.5 text-[8px] font-normal text-muted-foreground">{t("flowTicksPerSec")}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, tone }: { label: string; value: string; tone: "up" | "down" | "neutral" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-3 text-[9px] font-bold text-muted-foreground">{label}</span>
      <span className={cn("tnum truncate", tone === "up" && "text-up", tone === "down" && "text-down", tone === "neutral" && "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

// ── pressure + delta ──

function PressureBar({ p }: { p: FlowPayload }) {
  const { t } = useI18n();
  const total = p.buy + p.sell;
  const buyPct = total ? Math.round((p.buy / total) * 100) : 50;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wide">
        <span className="text-up">{t("flowBuyers")} {buyPct}%</span>
        <span className="tnum font-mono text-[10px] font-bold text-muted-foreground">
          {p.buy} <Minus className="inline h-2.5 w-2.5" /> {p.sell}
        </span>
        <span className="text-down">{100 - buyPct}% {t("flowSellers")}</span>
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-l-full bg-up" style={{ width: `${buyPct}%`, transition: "width 200ms ease" }} />
        <div className="h-full rounded-r-full bg-down" style={{ width: `${100 - buyPct}%`, transition: "width 200ms ease" }} />
      </div>
    </div>
  );
}

function DeltaCard({ p }: { p: FlowPayload }) {
  const { t } = useI18n();
  const hist = p.deltaHist;
  const ds = hist.map((h) => h.d);
  const min = Math.min(0, ...ds), max = Math.max(0, ...ds);
  const span = max - min || 1;
  const W = 100, H = 34;
  const pts = ds.length > 1
    ? ds.map((d, i) => `${(i / (ds.length - 1)) * W},${H - 3 - ((d - min) / span) * (H - 6)}`).join(" ")
    : "";
  const pos = p.delta >= 0;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{t("flowDelta")}</div>
            <div className={cn("tnum font-mono text-lg font-black leading-none", pos ? "text-up" : "text-down")}>
              {pos ? "+" : ""}{p.delta}
            </div>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{t("flowRecent")}</div>
            <div className={cn("tnum font-mono text-sm font-bold leading-tight", p.recentDelta >= 0 ? "text-up" : "text-down")}>
              {p.recentDelta >= 0 ? "+" : ""}{p.recentDelta}
            </div>
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-10 w-32" aria-hidden>
          <line x1="0" y1={H - 3 - ((0 - min) / span) * (H - 6)} x2={W} y2={H - 3 - ((0 - min) / span) * (H - 6)} strokeWidth="0.5" strokeDasharray="2 2" className="stroke-muted-foreground" opacity="0.5" />
          {pts && <polyline points={pts} fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" className={pos ? "stroke-up" : "stroke-down"} strokeLinejoin="round" strokeLinecap="round" />}
        </svg>
      </div>
    </div>
  );
}

// ── tape ──

function TapeList({ p, digits }: { p: FlowPayload; digits: number }) {
  const { t } = useI18n();
  const rows = [...p.tape].reverse().slice(0, 14);
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("flowTape")}</span>
        <span className="tnum font-mono text-[9px] text-muted-foreground">{p.buy + p.sell + p.flat} {t("flowTicks")}</span>
      </div>
      <div className="space-y-0.5">
        {rows.length === 0 && (
          <div className="py-3 text-center text-[10px] text-muted-foreground/60">{t("flowWaiting")}</div>
        )}
        {rows.map((tk, i) => (
          <div
            key={tk.seq ?? `${tk.t}-${i}`}
            className={cn(
              "flow-flash flex items-center gap-2 rounded px-1.5 py-0.5 font-mono text-[10px]",
              i === 0 && tk.d !== 0 && (tk.d === 1 ? "bg-up/10" : "bg-down/10"),
            )}
          >
            {tk.d === 1 ? (
              <ArrowUpRight className="h-3 w-3 shrink-0 text-up" />
            ) : tk.d === -1 ? (
              <ArrowDownRight className="h-3 w-3 shrink-0 text-down" />
            ) : (
              <Minus className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("tnum font-bold", tk.d === 1 ? "text-up" : tk.d === -1 ? "text-down" : "text-muted-foreground")}>
              {tk.p.toFixed(digits)}
            </span>
            <span className="tnum ml-auto text-[9px] text-muted-foreground/70">
              {new Date(tk.t).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── battle levels (in-candle volume profile) ──

function BattleLevels({ p, digits }: { p: FlowPayload; digits: number }) {
  const { t } = useI18n();
  if (!p.nodes.length) return null;
  const maxTotal = Math.max(...p.nodes.map((n) => n.b + n.s), 1);
  const nodes = [...p.nodes].sort((a, b) => b.p - a.p).slice(0, 8);
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("flowNodes")}</span>
        <Zap className="h-3 w-3 text-gold" />
      </div>
      <div className="space-y-1">
        {nodes.map((n) => {
          const tot = n.b + n.s;
          const buyFrac = tot ? n.b / tot : 0.5;
          return (
            <div key={n.p} className="flex items-center gap-2">
              <span className="tnum w-14 shrink-0 text-right font-mono text-[9px] text-muted-foreground">
                {n.p.toFixed(digits)}
              </span>
              <div className="h-2.5 flex-1">
                <div
                  className="flex h-full overflow-hidden rounded-full bg-muted/60"
                  style={{ width: `${Math.max(6, (tot / maxTotal) * 100)}%`, transition: "width 200ms ease" }}
                >
                  <div className="h-full bg-up/80" style={{ width: `${buyFrac * 100}%`, transition: "width 200ms ease" }} />
                  <div className="h-full bg-down/80" style={{ width: `${(1 - buyFrac) * 100}%`, transition: "width 200ms ease" }} />
                </div>
              </div>
              <span className="tnum w-8 shrink-0 font-mono text-[9px] text-muted-foreground/70">{tot.toFixed(0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── previous candles context ──

function PrevCandles({ p }: { p: FlowPayload }) {
  const { t } = useI18n();
  if (!p.prev.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("flowPrevCandles")}</div>
      <div className="flex flex-wrap gap-1.5">
        {[...p.prev].reverse().map((c) => (
          <div
            key={c.t}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
              c.dir === 1 ? "bg-up/10 text-up" : "bg-down/10 text-down",
            )}
            title={`${t("flowDelta")} ${c.d >= 0 ? "+" : ""}${c.d}`}
          >
            {c.dir === 1 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            <span className={cn("tnum", c.d >= 0 ? "text-up" : "text-down")}>
              {c.d >= 0 ? "+" : ""}{c.d}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── skeleton ──

function FlowSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-3 p-3" aria-busy="true">
      <span className="sr-only">{t("flowWaiting")}</span>
      <div className="flex h-[76px] animate-pulse items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <div className="h-14 w-14 rounded-full bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-3/5 rounded bg-muted" />
          <div className="h-2.5 w-2/5 rounded bg-muted" />
        </div>
      </div>
      <div className="h-[232px] animate-pulse rounded-lg border border-border bg-muted/40 p-3">
        <div className="mx-auto h-full w-24 rounded bg-muted" />
      </div>
      <div className="h-14 animate-pulse rounded-lg bg-muted/40" />
      <div className="h-16 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}

// ── compact strip — sits under the mobile chart, one tap from the full X-ray ──

export function FlowStrip({ onOpen }: { onOpen: () => void }) {
  const { symbol, timeframe } = useTerminal();
  const flow = useFlow(symbol, timeframe);
  const { t } = useI18n();
  const has = flow && flow.h > 0;
  const total = has ? flow.buy + flow.sell : 0;
  const buyPct = total ? Math.round((flow!.buy / total) * 100) : 50;
  const st = has ? (VERDICT_STYLE[flow!.score.verdict] ?? VERDICT_STYLE.balanced) : null;
  const sig = has ? flow!.sig : null;
  const engaged = sig && sig.state !== "neutral";
  const isBuy = sig?.state === "buy";
  const quiet = !engaged && sig?.quiet === true; // tape asleep — amber moon, honest wait

  return (
    <button
      onClick={onOpen}
      aria-label={t("flowOpenDetails")}
      className="flex w-full shrink-0 items-center gap-2.5 border-t border-border bg-card/80 px-3 py-2 text-left backdrop-blur active:bg-muted/40"
    >
      {/* signal lamp — glowing when the tick engine is engaged */}
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
          engaged
            ? isBuy
              ? "lamp-dot-up border-up/70 bg-up/15 text-up"
              : "lamp-dot-down border-down/70 bg-down/15 text-down"
            : quiet
              ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : has
                ? flow!.c >= flow!.o
                  ? "border-up/30 bg-up/5 text-up/80"
                  : "border-down/30 bg-down/5 text-down/80"
                : "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        {engaged ? (
          isBuy ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />
        ) : quiet ? (
          <MoonStar className="h-4 w-4" aria-hidden />
        ) : has ? (
          flow!.c >= flow!.o ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />
        ) : (
          <Activity className="h-4 w-4 animate-pulse" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-wide">
          <span
            className={cn(
              "truncate",
              engaged
                ? isBuy ? "text-up" : "text-down"
                : quiet
                  ? "text-amber-600 dark:text-amber-400"
                  : st ? st.text : "text-muted-foreground",
            )}
          >
            {engaged
              ? `${isBuy ? t("sigBuy") : t("sigSell")} · ${sig!.pnlPts >= 0 ? "+" : ""}${sig!.pnlPts.toFixed(1)} ${t("sigPts")}`
              : quiet
                ? `${t("sigQuiet")} · ${flow!.tps.toFixed(1)} t/s`
                : has
                  ? t(st!.key)
                  : t("flowWaiting")}
          </span>
          <span className={cn("tnum shrink-0 font-mono", has && flow!.delta >= 0 ? "text-up" : "text-down")}>
            Δ {has ? (flow!.delta >= 0 ? "+" : "") + flow!.delta : "—"}
          </span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-up" style={{ width: `${buyPct}%`, transition: "width 250ms ease" }} />
          <div className="h-full bg-down" style={{ width: `${100 - buyPct}%`, transition: "width 250ms ease" }} />
        </div>
      </div>

      <span className="tnum shrink-0 font-mono text-[10px] font-bold text-muted-foreground">
        {has ? `${buyPct}/${100 - buyPct}` : ""}
      </span>
    </button>
  );
}

// ── the panel ──

export function FlowPanel() {
  const { symbol, timeframe } = useTerminal();
  const flow = useFlow(symbol, timeframe);
  const symbols = useSymbolList();
  const digits = symbols.find((s) => s.name === symbol)?.digits ?? 2;
  const { t } = useI18n();

  const hasData = flow && flow.h > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-[10px] font-black uppercase tracking-widest text-gold">
          {t("flowTitle")}
        </span>
        <span className="tnum truncate font-mono text-[10px] font-bold text-muted-foreground">
          {symbol} · {timeframe}
        </span>
      </div>
      <div className="slim-scroll min-h-0 flex-1 overflow-y-auto">
        {!hasData ? (
          <FlowSkeleton />
        ) : (
          <div className="space-y-3 p-3">
            <SignalLamp p={flow} digits={digits} />
            <SignalStats sig={flow.sig} />
            <VerdictHero p={flow} />
            <CandleXray p={flow} digits={digits} />
            <PressureBar p={flow} />
            <DeltaCard p={flow} />
            <TapeList p={flow} digits={digits} />
            <BattleLevels p={flow} digits={digits} />
            <PrevCandles p={flow} />
            <p className="px-1 pb-1 text-[9px] leading-relaxed text-muted-foreground/60">
              {t("flowExplainer")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
