"use client";

/**
 * AutoTradePanel — the cockpit of the AI auto-trading brain.
 *
 *   • master ARM switch (with confirmation — real money moves)
 *   • risk mode (conservative / balanced / aggressive)
 *   • per-pair rules the user manages from the frontend:
 *     which symbols trade, lot size, max concurrent positions
 *   • live positions with the brain's own management (BE/trail marks,
 *     live P/L in R, close / close-all)
 *   • today's honest stats + trade journal + the thinking log
 *   • AI feelings (per-symbol mood gauges) — the "tick sense" layer
 *   • LLM deep-think card (calls /api/ai-brain every 60s while open)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feed, useSymbolList, useTrader } from "@/hooks/useFeed";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AiFeel, SymbolEdgeStat, TraderHistoryEntry, TraderJournalEntry, TraderLesson, TraderPendingOrder, TraderRiskMode, TraderState, TraderSymbolRule } from "@/lib/market/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Brain, Bot, TrendingUp, TrendingDown, Gauge, ShieldAlert, ShieldCheck, Wallet, X,
  FlaskConical, Sparkles, RefreshCw, Plus, Trash2, Clock, Activity, User,
  BookOpenText, Zap, GraduationCap, CalendarDays, Infinity as InfinityIcon, Landmark,
} from "lucide-react";

// ── helpers ──

function fmtMoney(n: number, cur = "USD") {
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)} ${cur}`;
}

function ageText(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** compact price for chips — trims float noise (90.52799999999999 → 90.528) */
function fmtPrice(n: number) {
  return Number(n.toFixed(5)).toString();
}

/** rough $/point/lot estimate for the pending-distance chip — DISPLAY ONLY
 *  (the backend's deal-calibrated cm table stays the money authority) */
function cmEstimate(symbol: string, price: number): number | null {
  const s = symbol.toUpperCase().replace(/M$/, "");
  if (s.startsWith("XAU")) return 100;
  if (s.startsWith("XAG")) return 5000;
  if (/^(USOIL|UKOIL|BRENT|WTI)/.test(s)) return 1000;
  if (s.startsWith("BTC")) return 1;
  if (/^USTEC.*X100/.test(s)) return 100;
  if (s.startsWith("USTEC")) return 1;
  if (/JPY$/.test(s)) return price > 0 ? 100000 / price : null; // JPY-quoted FX: ≈100000/price
  if (/(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(s)) return 100000; // standard FX
  return null;
}

/** + ORDER form type choice — "market" or the MT5 pending order codes
 *  (2=BUY LIMIT 3=SELL LIMIT 4=BUY STOP 5=SELL STOP) */
type OrderTypeChoice = "market" | "2" | "3" | "4" | "5";

const MOOD_ICON: Record<AiFeel["mood"], string> = {
  greedy: "🤑", fearful: "😨", calm: "😌", excited: "🔥", nervous: "😬", asleep: "😴",
};
const MOOD_LABEL: Record<AiFeel["mood"], { en: string; bn: string }> = {
  greedy: { en: "Greedy", bn: "লোভী" },
  fearful: { en: "Fearful", bn: "ভীত" },
  calm: { en: "Calm", bn: "শান্ত" },
  excited: { en: "Excited", bn: "উত্তেজিত" },
  nervous: { en: "Nervous", bn: "অস্থির" },
  asleep: { en: "Asleep", bn: "ঘুমন্ত" },
};

// journal exit-kind chips — colored badges for HOW a trade ended (TP hit,
// SL hit, flow flip, …) so the journal reads like a trade log, not a fog
type ExitKind = NonNullable<TraderJournalEntry["exitKind"]>;
const EXIT_CHIP: Record<ExitKind, { cls: string; label: string; titleKey: string }> = {
  TP: { cls: "bg-up/15 text-up", label: "TP ✅", titleKey: "traderExitTp" },
  SL: { cls: "bg-down/15 text-down", label: "SL ❌", titleKey: "traderExitSl" },
  FLIP: { cls: "bg-gold/15 text-gold", label: "FLIP", titleKey: "traderExitFlip" },
  ADVERSE: { cls: "bg-gold/15 text-gold", label: "ADVERSE", titleKey: "traderExitAdverse" },
  TIME: { cls: "bg-gold/15 text-gold", label: "TIME", titleKey: "traderExitTime" },
  AI: { cls: "border border-up/30 text-up", label: "AI", titleKey: "traderExitAi" },
  MANUAL: { cls: "bg-muted text-muted-foreground", label: "MANUAL", titleKey: "traderExitManual" },
  PARTIAL: { cls: "bg-up/10 text-up", label: "PARTIAL", titleKey: "traderExitPartial" },
};

/** re-render the caller every `intervalMs` — a clock tick that powers the
 *  LIVE SYNC age (kept inside the tiny chip so the heavy panel never
 *  re-renders on the timer, only the chip itself does) */
function useNowTick(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── v11 LIVE SYNC — the millisecond mirror made VISIBLE: age of the last
//    successful broker positions-sync, re-computed every 500ms (green <1.5s,
//    amber <8s, red beyond / never synced) ──
function LiveSyncChip({ lastSyncAt }: { lastSyncAt: number }) {
  const { t } = useI18n();
  const now = useNowTick(500);
  const age = lastSyncAt > 0 ? Math.max(0, now - lastSyncAt) : -1;
  const tone = age < 0 || age >= 8000 ? "text-down" : age >= 1500 ? "text-gold" : "text-up";
  const ageTxt = age < 0
    ? t("traderLiveSyncNever")
    : age < 10000 ? `${age}ms` : `${(age / 1000).toFixed(1)}s`;
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-card/60 px-2"
      title={`${t("traderLiveSync")}: ${ageTxt} — ${t("traderLiveSyncHint")}`}
    >
      <span className="text-[10px] leading-none" aria-hidden>⇄</span>
      <span className={cn("tnum font-mono text-[10px] font-bold", tone)}>{ageTxt}</span>
    </div>
  );
}

// ── v11 WHO opened it — the mystery-order answer on every trade: the AI
//    brain (violet, Bot) vs the user's own hand (muted, User) ──
function OriginChip({ origin }: { origin: "brain" | "manual" }) {
  const { t } = useI18n();
  if (origin === "brain") {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-violet-500/60 bg-violet-500/10 px-1 font-mono text-[8px] font-bold text-violet-500 dark:text-violet-300"
        title={t("traderOriginBrain")}
      >
        <Bot className="h-2.5 w-2.5" />
        AI
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-border bg-muted/70 px-1 font-mono text-[8px] font-bold text-muted-foreground"
      title={t("traderOriginManual")}
    >
      <User className="h-2.5 w-2.5" />
      {t("traderOriginYou")}
    </span>
  );
}

// ── balance sparkline — every balance change the session recorded, as one
//    tiny line (green when the account grew since the first point, red when
//    it bled) — the user's “ব্যালেন্স কমছে বাড়ছে” answered at a glance ──
function BalSpark({ hist }: { hist?: { at: number; balance: number }[] }) {
  const pts = (hist ?? []).filter((h) => Number.isFinite(h.balance));
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.balance);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 44, H = 14;
  const span = hi - lo || 1;
  const path = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - ((p.balance - lo) / span) * (H - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden>
      <path d={path} fill="none" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function GaugeBar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="tnum font-mono text-[10px] font-bold text-muted-foreground">{Math.round(value * 100)}%</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
    </div>
  );
}

// ── feelings card ──

function FeelCard({ feel, locale }: { feel: AiFeel; locale: string }) {
  const biasTone = feel.bias === "buy" ? "text-up" : feel.bias === "sell" ? "text-down" : "text-muted-foreground";
  const mom = feel.momentum ?? 0;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none" aria-hidden>{MOOD_ICON[feel.mood]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold">{feel.symbol}</span>
        <span
          className={cn(
            "font-mono text-[10px] font-bold",
            mom > 0.1 ? "text-up" : mom < -0.1 ? "text-down" : "text-muted-foreground/70",
          )}
          title={locale === "bn" ? "টিক-মোমেন্টাম (শেষ ~২০ সেকেন্ড)" : "Tick momentum (last ~20s)"}
        >
          <Zap className="mr-0.5 inline h-2.5 w-2.5" />
          {mom > 0 ? "+" : ""}{Math.round(mom * 100)}%
        </span>
        <span className={cn("font-mono text-[10px] font-bold uppercase", biasTone)}>
          {feel.bias === "none" ? "—" : feel.bias}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {locale === "bn" ? MOOD_LABEL[feel.mood].bn : MOOD_LABEL[feel.mood].en}
      </div>
      <div className="mt-2 flex gap-2">
        <GaugeBar label={locale === "bn" ? "আত্মবিশ্বাস" : "Conf"} value={feel.confidence} tone="bg-up/80" />
        <GaugeBar label={locale === "bn" ? "ভয়" : "Fear"} value={feel.fear} tone="bg-down/80" />
        <GaugeBar label={locale === "bn" ? "লোভ" : "Greed"} value={feel.greed} tone="bg-gold/80" />
      </div>
    </div>
  );
}

// ── LLM deep-think card — EVENT-DRIVEN: rethinks whenever the brain logs a
// new thought, a position opens/closes, or ANY journal event lands (open /
// close / skip / manage — length + last id), plus a 45s fallback heartbeat.
// Event/heartbeat calls send force:true so the server's time-cache is busted
// and the read is never STALE right after something happened. Resilient: a
// failed fetch keeps the last successful read on screen with a muted
// reconnecting line; when only the local narrator could answer (LLM down)
// an amber LOCAL badge shows next to the title. ──

interface AiBrainRead { read: string; bias: string; risk: string; plan: string; at: number; degraded?: boolean }

function AiThinkCard({ state }: { state: TraderState }) {
  const { t } = useI18n();
  const [data, setData] = useState<AiBrainRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);
  const lastFetchRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchBrain = useCallback(async (force = false) => {
    const now = Date.now();
    if (busyRef.current) return;
    if (!force && now - lastFetchRef.current < 15_000) return; // min spacing
    busyRef.current = true;
    lastFetchRef.current = now;
    setLoading(true);
    try {
      const res = await fetch("/api/ai-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: stateRef.current, force }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j?.read) {
        setData({
          read: j.read, bias: j.bias ?? "", risk: j.risk ?? "", plan: j.plan ?? "",
          at: Date.now(), degraded: j.degraded === true,
        });
        setErr(null);
      } else {
        throw new Error(j?.error ?? "empty");
      }
    } catch (e) {
      // keep the LAST successful read rendered — the muted reconnecting line
      // below signals the retry; only a panel that never answered shows the
      // full error state
      setErr((e as Error).message);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  }, []);

  // signature of "something changed" — last thought, position count, journal
  // (length + last id ⇒ every open/close/skip/manage), W/L count, halt flag,
  // balance (external deposits/manual-trade closes trigger a rethink too),
  // v11: pending orders (length + head ticket ⇒ fills/cancels) and broker
  // history (length + latest close ⇒ every new close, even at the 30-cap)
  const signature = `${state.brain[state.brain.length - 1]?.at ?? 0}:${state.positions.length}:${state.journal.length}:${state.journal[state.journal.length - 1]?.id ?? 0}:${state.today.wins + state.today.losses}:${state.haltedToday ? 1 : 0}:${(state.balance ?? 0).toFixed(2)}:${state.pendingOrders?.length ?? 0}:${state.pendingOrders?.[0]?.ticket ?? 0}:${state.recentHistory?.length ?? 0}:${state.recentHistory?.[0]?.closedAt ?? 0}`;
  const lastSigRef = useRef("");
  useEffect(() => {
    if (signature !== lastSigRef.current) {
      const first = lastSigRef.current === "";
      lastSigRef.current = signature;
      if (!first) fetchBrain(true); // forced rethink the moment a trade event lands
    }
  }, [signature, fetchBrain]);

  useEffect(() => {
    fetchBrain(true);
    const id = setInterval(() => fetchBrain(true), 45_000);
    return () => clearInterval(id);
  }, [fetchBrain]);

  return (
    <section className="rounded-lg border border-gold/25 bg-gradient-to-b from-gold/[0.06] to-transparent p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-gold" />
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-gold">
          {t("traderAiThink")}
        </h3>
        <Badge variant="outline" className="h-4 border-up/30 px-1.5 text-[8px] font-bold text-up">
          <Zap className="mr-0.5 h-2.5 w-2.5" />
          {t("traderAiInstant")}
        </Badge>
        {data?.degraded && (
          <Badge variant="outline" className="h-4 border-gold/40 bg-gold/10 px-1.5 text-[8px] font-bold text-gold">
            {t("traderLocalMode")}
          </Badge>
        )}
        <Button
          variant="ghost" size="sm"
          className="ml-auto h-6 w-6 p-0" onClick={() => fetchBrain(true)} disabled={loading}
          aria-label="refresh ai thinking"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </Button>
      </div>
      {data ? (
        <div className="mt-2 space-y-2 text-[11px] leading-relaxed">
          {data.bias && (
            <p><span className="font-bold text-gold">{t("traderAiBias")}: </span><span className="text-foreground/90">{data.bias}</span></p>
          )}
          <p className="text-foreground/90">{data.read}</p>
          {data.risk && (
            <p><span className="font-bold text-gold">{t("traderAiRisk")}: </span><span className="text-foreground/90">{data.risk}</span></p>
          )}
          {data.plan && (
            <p><span className="font-bold text-gold">{t("traderAiPlan")}: </span><span className="text-foreground/90">{data.plan}</span></p>
          )}
          {err && (
            <p className="text-[9px] text-muted-foreground/70" title={err}>
              {t("traderReconnecting")}
            </p>
          )}
          <p className="text-right font-mono text-[9px] text-muted-foreground/60">
            {new Date(data.at).toLocaleTimeString()}
          </p>
        </div>
      ) : err ? (
        <p className="mt-2 text-[10px] text-muted-foreground">{t("traderAiErr")} ({err})</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="h-2.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-4/6 animate-pulse rounded bg-muted" />
        </div>
      )}
    </section>
  );
}

// ── REAL AI MODEL — the LLM judge's live verdicts (it decides entries and
// reviews open positions; these are its actual decisions, flowing in from the
// brain through the socket). ──

function verdictChipClass(decision: string) {
  switch (decision) {
    case "buy": return "border-up/40 bg-up/15 text-up";
    case "sell": return "border-down/40 bg-down/15 text-down";
    case "pass": case "offline": return "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
    case "tighten": return "border-gold/40 bg-gold/15 text-gold";
    case "close": return "border-down/40 bg-down/10 text-down";
    default: return "border-border bg-muted/40 text-muted-foreground"; // hold
  }
}

function RealAiCard({ state }: { state: TraderState }) {
  const { locale, t } = useI18n();
  const verdicts = state.ai?.verdicts ?? [];
  const stats = state.ai?.stats;

  return (
    <section className="rounded-lg border border-up/25 bg-gradient-to-b from-up/[0.05] to-transparent p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-up" />
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-up">
          {t("traderRealAi")}
        </h3>
        <Badge variant="outline" className="h-4 border-up/30 px-1.5 text-[8px] font-bold text-up">
          {t("traderRealAiLive")}
        </Badge>
        {stats && stats.ok + stats.fail > 0 && (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            {stats.ok}✓{stats.fail > 0 ? `/${stats.fail}✗` : ""} · {stats.avgMs}ms
          </span>
        )}
      </div>
      {/* execution speed — the user's question, answered live:
          how fast from signal to order? */}
      {state.ai?.exec && state.ai.exec.n > 0 && (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-gold/30 bg-gold/[0.07] px-2 py-1">
          <Zap className="h-3 w-3 shrink-0 text-gold" />
          <span className="text-[9.5px] font-semibold text-gold">
            {locale === "bn" ? "এক্সিকিউশন স্পিড" : "Execution speed"}:
          </span>
          <span className="tnum font-mono text-[10px] font-bold text-foreground">
            {locale === "bn" ? "শেষ" : "last"} {state.ai.exec.lastMs}ms · {locale === "bn" ? "গড়" : "avg"} {state.ai.exec.avgMs}ms · {state.ai.exec.n}×
          </span>
        </div>
      )}
      <p className="mt-1 text-[9.5px] leading-snug text-muted-foreground/80">
        {locale === "bn" ? "ভেতরের AI মডেল (GLM) প্রতিটি এন্ট্রি যাচাই করে আর খোলা ট্রেড রিভিউ করে — নিচে তার সিদ্ধান্ত লাইভ:" : "The AI model inside (GLM) verifies every entry and reviews open trades — its live decisions below:"}
      </p>
      {verdicts.length ? (
        <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
          {[...verdicts].reverse().map((v) => (
            <div
              key={v.at}
              className="flex items-start gap-2 rounded-md border border-border/60 bg-card/40 px-2 py-1.5"
            >
              <span className="shrink-0 pt-0.5 font-mono text-[8.5px] text-muted-foreground/50">
                {new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="shrink-0 font-mono text-[10px] font-bold text-foreground/90">{v.symbol.replace(/m$/, "")}</span>
              <span className="shrink-0 rounded px-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground/70">
                {v.kind === "entry" ? t("traderAiEntry") : t("traderAiReview")}
              </span>
              <span className={cn("shrink-0 rounded border px-1.5 text-[9px] font-bold uppercase", verdictChipClass(v.decision))}>
                {v.decision}
              </span>
              {v.conf > 0 && (
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{v.conf}%</span>
              )}
              <span className={cn("min-w-0 flex-1 text-[10px] leading-snug", v.applied ? "text-foreground/90" : "text-muted-foreground/70")}>
                {v.note}
                {!v.applied && v.decision !== "pass" && v.decision !== "offline" && (
                  <span className="ml-1 text-muted-foreground/50">·</span>
                )}
              </span>
              {v.applied && <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-up" aria-label="applied" />}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground/60">
          {locale === "bn" ? "AI জাজ প্রস্তুত — সিগন্যাল এলে সিদ্ধান্ত দেখাবে…" : t("traderAiWaiting")}
        </p>
      )}
      {stats?.lastError && (
        <p className="mt-1 truncate text-[9px] text-down/80" title={stats.lastError}>
          ⚠ {stats.lastError}
        </p>
      )}
    </section>
  );
}

// ── main panel ──

export function AutoTradePanel() {
  const { t, locale } = useI18n();
  const state = useTrader();
  const symbols = useSymbolList();
  const [confirmArm, setConfirmArm] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [pending, setPending] = useState(false);

  const post = useCallback(async (path: string, body?: unknown) => {
    setPending(true);
    try { return await feed.postTrader(path, body); }
    finally { setPending(false); }
  }, []);

  const patchConfig = useCallback((patch: Record<string, unknown>) => {
    return post("/api/trader/config", patch);
  }, [post]);

  // TP$ — fixed-dollar profit target draft (commits on blur/Enter, clamped 0.1..50)
  const [tpDraft, setTpDraft] = useState<string | null>(null);
  const commitTp = useCallback((raw: string | null) => {
    setTpDraft(null);
    if (raw === null) return; // untouched — nothing to commit
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0.1, Math.min(50, Math.round(n * 100) / 100));
    if (state && Math.abs(clamped - (state.tpUsd ?? 0)) < 0.005) return; // unchanged
    patchConfig({ tpUsd: clamped });
  }, [state, patchConfig]);

  // BE$ — breakeven trigger draft (0 = AUTO: 60% of the TP target)
  const [beDraft, setBeDraft] = useState<string | null>(null);
  const commitBe = useCallback((raw: string | null) => {
    setBeDraft(null);
    if (raw === null) return;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(1000, Math.round(n * 100) / 100));
    if (state && Math.abs(clamped - (state.beUsd ?? 0)) < 0.005) return;
    patchConfig({ beUsd: clamped });
  }, [state, patchConfig]);

  // DAY — v10 daily trade cap (0 = ∞ UNLIMITED — the user's "যত মন চাই তত" rule).
  // Free input, no hidden ceiling: the backend accepts 0..10000.
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  const commitDay = useCallback((raw: string | null) => {
    setDayDraft(null);
    if (raw === null) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(10000, n));
    if (state && clamped === (state.maxDailyTrades ?? 0)) return;
    patchConfig({ maxDailyTrades: clamped });
  }, [state, patchConfig]);

  // ── v9 per-position SL/TP customization — drafts + last modify error ──
  const [modDrafts, setModDrafts] = useState<Record<string, string>>({});
  const [modErr, setModErr] = useState<{ ticket: number; msg: string } | null>(null);
  const commitMod = useCallback((ticket: number, field: "sl" | "tp", raw: string | null) => {
    if (raw === null) return; // untouched
    setModDrafts((d) => { const n = { ...d }; delete n[`${ticket}:${field}`]; return n; });
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) return;
    setModErr(null);
    post("/api/trader/modify", { ticket, [field]: v }).then((r: { ok?: boolean; error?: string } | undefined) => {
      if (r && r.ok === false) setModErr({ ticket, msg: String(r.error ?? "failed") });
    });
  }, [post]);
  const moveBe = useCallback((ticket: number) => {
    setModErr(null);
    post("/api/trader/modify", { ticket, be: true }).then((r: { ok?: boolean; error?: string } | undefined) => {
      if (r && r.ok === false) setModErr({ ticket, msg: String(r.error ?? "failed") });
    });
  }, [post]);

  // ── v11 pending-order cancel — optimistic ✕ (row dims, mirror refreshes
  //    within a beat); a 400 surfaces the brain's human-readable reason ──
  const [cancelErr, setCancelErr] = useState<{ ticket: number; msg: string } | null>(null);
  const [cancellingTickets, setCancellingTickets] = useState<number[]>([]);
  const cancelPending = useCallback((ticket: number) => {
    setCancelErr(null);
    setCancellingTickets((xs) => [...xs, ticket]);
    post("/api/trader/cancel-pending", { ticket }).then((r: { ok?: boolean; error?: string } | undefined) => {
      setCancellingTickets((xs) => xs.filter((x) => x !== ticket));
      if (r && r.ok === false) setCancelErr({ ticket, msg: String(r.error ?? "failed") });
    });
  }, [post]);

  // ── v11 + ORDER — app→MT5 manual trading (market / limit / stop) ──
  const [orderOpen, setOrderOpen] = useState(false);
  const [ordSymbol, setOrdSymbol] = useState("");
  const [ordSide, setOrdSide] = useState<"buy" | "sell">("buy");
  const [ordLots, setOrdLots] = useState("0.01");
  const [ordType, setOrdType] = useState<OrderTypeChoice>("market");
  const [ordPrice, setOrdPrice] = useState("");
  const [ordSl, setOrdSl] = useState("");
  const [ordTp, setOrdTp] = useState("");
  const [ordErr, setOrdErr] = useState<string | null>(null);
  const [ordBusy, setOrdBusy] = useState(false);

  // local rules draft state (edits apply on blur/enter)
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const commitDraft = useCallback((symbol: string, field: "lots" | "maxPositions", raw: string) => {
    const rule = state?.rules.find((r) => r.symbol === symbol);
    if (!rule) return;
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) { setDrafts((d) => { const n = { ...d }; delete n[`${symbol}:${field}`]; return n; }); return; }
    const clamped = field === "lots"
      ? Math.max(0.01, Math.min(100, Math.round(num * 100) / 100))
      : Math.max(1, Math.min(500, Math.round(num)));
    // v10 no-op guard: Enter can fire the commit twice (keydown + the blur
    // after it) — the second call reads the CLEARED draft's fallback and
    // would silently revert the first (maxPositions 9 → 10 round-trip bug
    // caught live in the browser). Never PATCH an unchanged value.
    const current = field === "lots" ? rule.lots : rule.maxPositions;
    setDrafts((d) => { const n = { ...d }; delete n[`${symbol}:${field}`]; return n; });
    if (Math.abs(clamped - current) < 1e-9) return;
    const next: Record<string, unknown> = {
      symbols: state!.rules.map((r) =>
        r.symbol === symbol
          ? { ...r, [field]: clamped }
          : r,
      ),
    };
    patchConfig(next);
  }, [state, patchConfig]);

  const availableSymbols = useMemo(
    () => symbols.map((s) => s.name).filter((n) => !state?.rules.some((r) => r.symbol === n)).slice(0, 60),
    [symbols, state],
  );

  if (!state) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Bot className="h-8 w-8 animate-pulse text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">{t("traderConnecting")}</p>
      </div>
    );
  }

  const enabledRules = state.rules.filter((r) => r.enabled);
  const hasOpenPositions = state.positions.length > 0;
  const tpUsd = state.tpUsd ?? 0;
  const beUsd = state.beUsd ?? 0;
  const maxDailyTrades = state.maxDailyTrades ?? 0;
  const accountLogin = state.accountLogin ?? 0;
  const serverName = state.serverName ?? "";
  // v11 mirror fields — old payloads may not carry them (guard with ?? [])
  const pendingOrders: TraderPendingOrder[] = state.pendingOrders ?? [];
  const recentHistory: TraderHistoryEntry[] = state.recentHistory ?? [];

  // + ORDER form plumbing — symbols come from the trader rules; the effective
  // symbol falls back to the first enabled rule so the form is ready at once
  const orderSymbols = state.rules.map((r) => r.symbol);
  const effSymbol = ordSymbol || state.rules.find((r) => r.enabled)?.symbol || orderSymbols[0] || "";
  const switchOrdSide = (side: "buy" | "sell") => {
    setOrdSide(side);
    if (ordType !== "market") {
      // keep the same family on the new side: limit↔limit, stop↔stop
      setOrdType(side === "buy" ? (ordType === "3" ? "2" : "4") : (ordType === "2" ? "3" : "5"));
    }
  };
  const placeOrder = async () => {
    setOrdErr(null);
    const lots = parseFloat(ordLots);
    if (!effSymbol) { setOrdErr(t("traderOrderErrSymbol")); return; }
    if (!Number.isFinite(lots) || lots < 0.01) { setOrdErr(t("traderOrderErrLots")); return; }
    const sl = parseFloat(ordSl);
    const tp = parseFloat(ordTp);
    const slU = ordSl.trim() !== "" && Number.isFinite(sl) && sl > 0 ? sl : undefined;
    const tpU = ordTp.trim() !== "" && Number.isFinite(tp) && tp > 0 ? tp : undefined;
    const isMarket = ordType === "market";
    let price: number | undefined;
    if (!isMarket) {
      const p = parseFloat(ordPrice);
      if (!Number.isFinite(p) || p <= 0) { setOrdErr(t("traderOrderErrPrice")); return; }
      price = p;
    }
    setOrdBusy(true);
    try {
      const body = isMarket
        ? { symbol: effSymbol, side: ordSide, lots, sl: slU, tp: tpU }
        : { symbol: effSymbol, orderType: Number(ordType) as 2 | 3 | 4 | 5, lots, price, sl: slU, tp: tpU };
      const r = await post(isMarket ? "/api/trader/order" : "/api/trader/pending", body);
      if (r && r.ok === false) { setOrdErr(String(r.error ?? "failed")); return; } // 400: the brain's reason, inline in red
      const typeLabel = isMarket
        ? t("traderOrderMarket")
        : ({ "2": t("traderOrderBuyLimit"), "3": t("traderOrderSellLimit"), "4": t("traderOrderBuyStop"), "5": t("traderOrderSellStop") } as Record<string, string>)[ordType] ?? "";
      toast({
        title: `✅ ${t("traderOrderPlaced")}`,
        description: `${effSymbol} ${ordSide.toUpperCase()} ${lots} · ${typeLabel}${!isMarket && price ? ` @ ${fmtPrice(price)}` : ""}`,
      });
      setOrderOpen(false);
      setOrdPrice(""); setOrdSl(""); setOrdTp("");
    } finally {
      setOrdBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: master switch + account */}
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all",
              state.enabled
                ? "border-up/40 bg-up/10 text-up shadow-[0_0_18px_rgba(14,203,129,0.25)]"
                : "border-border bg-card/60 text-muted-foreground",
            )}
          >
            <Brain className={cn("h-5 w-5", state.enabled && "animate-pulse")} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-bold tracking-tight">{t("traderTitle")}</h2>
              {state.connected ? (
                <Badge variant="outline" className="h-4 border-up/40 px-1.5 text-[8px] font-bold text-up">MT5</Badge>
              ) : (
                <Badge variant="outline" className="h-4 border-down/40 px-1.5 text-[8px] font-bold text-down">OFFLINE</Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {state.enabled ? t("traderArmedHint") : t("traderDisarmedHint")}
            </p>
          </div>

          {/* ARM switch (with confirmation when arming) */}
          {state.enabled ? (
            <Button
              variant="destructive" size="sm" disabled={pending}
              className="h-8 gap-1.5 px-3 text-[11px] font-bold"
              onClick={() => patchConfig({ enabled: false })}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              {t("traderDisarm")}
            </Button>
          ) : (
            <AlertDialog open={confirmArm} onOpenChange={setConfirmArm}>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm" disabled={pending || state.noFunds || !state.connected}
                  className="h-8 gap-1.5 bg-up px-3 text-[11px] font-bold text-[#04150d] hover:bg-up/90"
                >
                  <Bot className="h-3.5 w-3.5" />
                  {t("traderArm")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-sm">{t("traderArmConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription className="text-xs leading-relaxed">
                    {t("traderArmConfirmBody")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="h-8 text-xs">{t("traderCancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    className="h-8 bg-up text-[11px] font-bold text-[#04150d] hover:bg-up/90"
                    onClick={() => patchConfig({ enabled: true })}
                  >
                    {t("traderArmGo")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {/* account + risk mode row — v9: live balance (trend + sparkline),
            live equity (balance + floating), floating P/L chip */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <div
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-card/60 px-2"
            title={(() => {
              const s0 = state.sessionStartBalance;
              if (s0 == null || s0 <= 0) return t("traderBalance");
              const d = state.balance - s0;
              return `${t("traderBalTrend")}: ${d >= 0 ? "+" : "−"}$${Math.abs(d).toFixed(2)} (${d >= 0 ? t("traderBalUp") : t("traderBalDown")})`;
            })()}
          >
            <Wallet className="h-3 w-3 text-gold" />
            <span className="tnum font-mono text-[10px] font-bold">
              {fmtMoney(state.balance, state.currency)}
            </span>
            {(() => {
              const s0 = state.sessionStartBalance;
              if (s0 == null || s0 <= 0 || Math.abs(state.balance - s0) < 0.005) return null;
              const up = state.balance > s0;
              const d = Math.abs(state.balance - s0);
              return (
                <span className={cn("flex items-center gap-0.5 font-mono text-[9px] font-bold", up ? "text-up" : "text-down")}>
                  {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                  {up ? "+" : "−"}{d.toFixed(2)}
                </span>
              );
            })()}
            <BalSpark hist={state.balanceHist} />
          </div>
          <div
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-card/60 px-2"
            title={locale === "bn" ? "লাইভ ইকুইটি = ব্যালেন্স + ওপেন ট্রেডের P/L (প্রতি টিকে আপডেট)" : "Live equity = balance + open-position P/L (updated every tick)"}
          >
            <Activity className="h-3 w-3 text-up" />
            <span className="tnum font-mono text-[10px] font-bold">
              {fmtMoney(state.equity, state.currency)}
            </span>
            <span className="text-[9px] text-muted-foreground">{t("traderEquity")}</span>
          </div>
          {state.positions.length > 0 && (
            <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-card/60 px-2"
              title={locale === "bn" ? "ওপেন ট্রেডের মোট চলমান P/L" : "Running P/L across all open positions"}
            >
              <span className={cn("tnum font-mono text-[10px] font-bold", (state.floatingPnl ?? 0) >= 0 ? "text-up" : "text-down")}>
                {(state.floatingPnl ?? 0) >= 0 ? "+" : "−"}${Math.abs(state.floatingPnl ?? 0).toFixed(2)}
              </span>
              <span className="text-[9px] text-muted-foreground">{t("traderFloating")}</span>
            </div>
          )}
          {/* v10: WHICH account the brain follows — the user can verify it
              matches the account open in their MT5 app (same login = same
              dollars, tick for tick) */}
          {accountLogin > 0 && (
            <div
              className="flex h-7 items-center gap-1 rounded-md border border-border bg-card/60 px-2"
              title={locale === "bn"
                ? `অ্যাপ এই MT5 অ্যাকাউন্ট ফলো করছে: #${accountLogin}${serverName ? ` (${serverName})` : ""} — MT5 অ্যাপে একই অ্যাকাউন্ট খোলা থাকলে হুবহু একই সংখ্যা দেখাবে`
                : `This app follows MT5 account #${accountLogin}${serverName ? ` (${serverName})` : ""} — open the same account in your MT5 app to see identical numbers`}
            >
              <Landmark className="h-3 w-3 text-gold" />
              <span className="tnum font-mono text-[10px] font-bold">#{accountLogin}</span>
            </div>
          )}
          {/* v11 LIVE SYNC — the millisecond mirror made visible: how old the
              app's copy of the broker account is (re-computed every 500ms) */}
          <LiveSyncChip lastSyncAt={state.lastSyncAt ?? 0} />
          {/* v11 + ORDER — place a market / limit / stop order from the app */}
          <Popover open={orderOpen} onOpenChange={(o) => { setOrderOpen(o); if (!o) setOrdErr(null); }}>
            <PopoverTrigger asChild>
              <Button
                variant="outline" size="sm" disabled={!state.connected}
                className="h-7 gap-1 px-2 text-[10px] font-bold" aria-label={t("traderNewOrder")}
              >
                <Plus className="h-3 w-3" />
                {t("traderNewOrder")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-3">
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5 text-gold" />
                  <h4 className="text-[11px] font-bold uppercase tracking-wider">{t("traderNewOrder")}</h4>
                  <Badge variant="outline" className="h-4 px-1.5 text-[8px] font-bold text-gold">MT5</Badge>
                </div>
                {/* symbol — the pairs the brain trades */}
                <Select value={effSymbol} onValueChange={setOrdSymbol}>
                  <SelectTrigger className="h-8 border-border bg-card/60 px-2 font-mono text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {orderSymbols.map((s) => (
                      <SelectItem key={s} value={s} className="font-mono text-[11px]">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* BUY / SELL */}
                <div className="grid grid-cols-2 gap-1.5">
                  <Button
                    type="button" variant="outline" onClick={() => switchOrdSide("buy")}
                    className={cn("h-8 gap-1 text-[11px] font-bold", ordSide === "buy" ? "border-up/50 bg-up/15 text-up" : "text-muted-foreground")}
                  >
                    <TrendingUp className="h-3.5 w-3.5" />BUY
                  </Button>
                  <Button
                    type="button" variant="outline" onClick={() => switchOrdSide("sell")}
                    className={cn("h-8 gap-1 text-[11px] font-bold", ordSide === "sell" ? "border-down/50 bg-down/15 text-down" : "text-muted-foreground")}
                  >
                    <TrendingDown className="h-3.5 w-3.5" />SELL
                  </Button>
                </div>
                {/* lots + order type */}
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1" aria-label={t("traderLots")}>
                    <span className="text-[8px] font-semibold uppercase text-muted-foreground">{t("traderLots")}</span>
                    <Input
                      value={ordLots}
                      onChange={(e) => setOrdLots(e.target.value)}
                      inputMode="decimal"
                      className="tnum h-8 w-16 border-border bg-card/60 px-1.5 text-center font-mono text-[10px]"
                    />
                  </label>
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    <span className="shrink-0 text-[8px] font-semibold uppercase text-muted-foreground">{t("traderOrderType")}</span>
                    <Select
                      value={ordType}
                      onValueChange={(v) => {
                        const nv = v as OrderTypeChoice;
                        setOrdType(nv);
                        if (nv === "2" || nv === "4") setOrdSide("buy");
                        else if (nv === "3" || nv === "5") setOrdSide("sell");
                      }}
                    >
                      <SelectTrigger className="h-8 min-w-0 flex-1 border-border bg-card/60 px-2 text-[10px] font-bold">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="market" className="text-xs">{t("traderOrderMarket")}</SelectItem>
                        <SelectItem value="2" className="text-xs">{t("traderOrderBuyLimit")}</SelectItem>
                        <SelectItem value="3" className="text-xs">{t("traderOrderSellLimit")}</SelectItem>
                        <SelectItem value="4" className="text-xs">{t("traderOrderBuyStop")}</SelectItem>
                        <SelectItem value="5" className="text-xs">{t("traderOrderSellStop")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {/* trigger price — pending orders only */}
                {ordType !== "market" && (
                  <Input
                    value={ordPrice}
                    onChange={(e) => setOrdPrice(e.target.value)}
                    inputMode="decimal"
                    placeholder={t("traderTriggerPrice")}
                    aria-label={t("traderTriggerPrice")}
                    className="tnum h-8 border-border bg-card/60 px-2 font-mono text-[10px]"
                  />
                )}
                {/* optional SL / TP (mono) */}
                <div className="grid grid-cols-2 gap-1.5">
                  <Input
                    value={ordSl}
                    onChange={(e) => setOrdSl(e.target.value)}
                    inputMode="decimal"
                    placeholder="SL"
                    aria-label="SL"
                    className="tnum h-8 border-border bg-card/60 px-2 text-center font-mono text-[10px]"
                  />
                  <Input
                    value={ordTp}
                    onChange={(e) => setOrdTp(e.target.value)}
                    inputMode="decimal"
                    placeholder="TP"
                    aria-label="TP"
                    className="tnum h-8 border-border bg-card/60 px-2 text-center font-mono text-[10px]"
                  />
                </div>
                {ordErr && <p className="text-[9px] font-semibold text-down">⚠ {ordErr}</p>}
                <Button
                  type="button" onClick={() => placeOrder()}
                  disabled={ordBusy || !effSymbol || !state.connected}
                  className={cn(
                    "h-8 w-full gap-1 text-[11px] font-bold",
                    ordSide === "buy" ? "bg-up text-[#04150d] hover:bg-up/90" : "bg-down text-white hover:bg-down/90",
                  )}
                >
                  {ordBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {t("traderPlaceOrder")}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Select
            value={state.riskMode}
            onValueChange={(v) => patchConfig({ riskMode: v as TraderRiskMode })}
          >
            <SelectTrigger className="h-7 w-auto gap-1 border-border bg-card/60 px-2 text-[10px] font-bold">
              <Gauge className="h-3 w-3 text-gold" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="conservative" className="text-xs">{t("traderRiskConservative")}</SelectItem>
              <SelectItem value="balanced" className="text-xs">{t("traderRiskBalanced")}</SelectItem>
              <SelectItem value="aggressive" className="text-xs">{t("traderRiskAggressive")}</SelectItem>
            </SelectContent>
          </Select>
          {/* TP$ — fixed-dollar profit target (0 = R-multiple mode) */}
          <div
            className="flex h-7 items-center gap-1 rounded-md border border-border bg-card/60 px-2"
            title={tpUsd > 0
              ? `${t("traderTpTarget")} — ${t("traderTpActive")} +$${tpUsd.toFixed(2)}`
              : `${t("traderTpTarget")} — ${t("traderTpModeR")}`}
          >
            <span className="text-[9px] font-bold uppercase text-muted-foreground">TP$</span>
            <Input
              value={tpDraft ?? String(tpUsd)}
              onChange={(e) => setTpDraft(e.target.value)}
              onBlur={() => commitTp(tpDraft)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              disabled={pending}
              inputMode="decimal"
              step={0.05}
              aria-label={t("traderTpTarget")}
              className="tnum h-5 w-12 border-0 bg-transparent px-0.5 text-center font-mono text-[10px] shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            {tpUsd > 0 && (
              <span className="tnum font-mono text-[9px] font-bold text-up" title={t("traderTpActive")}>
                ✓ ${tpUsd.toFixed(2)}
              </span>
            )}
          </div>
          {/* BE$ — breakeven trigger (0 = AUTO: 60% of the TP target). When live
              profit reaches it the SL jumps to entry (+$0.05 lock) and a
              $-lock trail protects the peak from then on. */}
          <div
            className="flex h-7 items-center gap-1 rounded-md border border-border bg-card/60 px-2"
            title={beUsd > 0
              ? `${t("traderBeTrigger")} — +$${beUsd.toFixed(2)}: ${t("traderBeHint")}`
              : `${t("traderBeTrigger")} — ${t("traderBeAuto")}`}
          >
            <ShieldCheck className="h-3 w-3 text-gold" />
            <span className="text-[9px] font-bold uppercase text-muted-foreground">BE$</span>
            <Input
              value={beDraft ?? String(beUsd)}
              onChange={(e) => setBeDraft(e.target.value)}
              onBlur={() => commitBe(beDraft)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              disabled={pending}
              inputMode="decimal"
              step={0.25}
              aria-label={t("traderBeTrigger")}
              className="tnum h-5 w-12 border-0 bg-transparent px-0.5 text-center font-mono text-[10px] shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            {beUsd > 0 && (
              <span className="tnum font-mono text-[9px] font-bold text-up" title={t("traderBeHint")}>
                ✓ ${beUsd.toFixed(2)}
              </span>
            )}
            {beUsd === 0 && (
              <span className="font-mono text-[8.5px] font-bold text-gold/80" title={t("traderBeAuto")}>
                AUTO
              </span>
            )}
          </div>
          {/* DAY — v10 daily trade cap (0 = ∞ UNLIMITED — “যত মন চাই তত”).
              Free input, no hidden ceiling; raising it auto-resumes a
              count-halted brain. */}
          <div
            className="flex h-7 items-center gap-1 rounded-md border border-border bg-card/60 px-2"
            title={t("traderDayHint")}
          >
            <CalendarDays className="h-3 w-3 text-gold" />
            <span className="text-[9px] font-bold uppercase text-muted-foreground">{t("traderDayShort")}</span>
            <Input
              value={dayDraft ?? String(maxDailyTrades)}
              onChange={(e) => setDayDraft(e.target.value)}
              onBlur={() => commitDay(dayDraft)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              disabled={pending}
              inputMode="numeric"
              aria-label={t("traderDayHint")}
              className="tnum h-5 w-10 border-0 bg-transparent px-0.5 text-center font-mono text-[10px] shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            {maxDailyTrades === 0 ? (
              <span className="flex items-center font-mono text-[9px] font-bold text-gold" title={t("traderDayUnlimited")}>
                <InfinityIcon className="h-3 w-3" />
              </span>
            ) : (
              <span className="tnum font-mono text-[9px] font-bold text-muted-foreground">
                {state.today.trades}/{maxDailyTrades}
              </span>
            )}
          </div>
          {state.haltedToday && (
            <Badge variant="outline" className="h-6 border-down/40 px-2 text-[9px] font-bold text-down">
              <Clock className="mr-1 h-3 w-3" />
              {t("traderHalted")}: {state.haltReason}
            </Badge>
          )}
        </div>

        {/* no-funds warning */}
        {state.noFunds && (
          <div className="mt-2.5 rounded-lg border border-gold/30 bg-gold/[0.07] p-2.5">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-gold">{t("traderNoFundsTitle")}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                  {t("traderNoFundsBody")}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* scrollable body */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* live positions */}
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("traderPositions")}
            </h3>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{state.positions.length}</Badge>
            {hasOpenPositions && (
              <Button
                variant="outline" size="sm" disabled={pending}
                className="ml-auto h-6 gap-1 px-2 text-[9px] font-bold text-down hover:border-down/40 hover:bg-down/10"
                onClick={() => post("/api/trader/close-all")}
              >
                <X className="h-3 w-3" />
                {t("traderCloseAll")}
              </Button>
            )}
          </div>
          {state.positions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-center text-[10px] text-muted-foreground/70">
              {t("traderNoPositions")}
            </p>
          ) : (
            <div className="space-y-1.5">
              {state.positions.map((p) => {
                const win = p.pnl >= 0;
                const slDraftVal = modDrafts[`${p.ticket}:sl`];
                const tpDraftVal = modDrafts[`${p.ticket}:tp`];
                return (
                  <div key={p.ticket} className="rounded-lg border border-border bg-card/60 p-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[9px] font-bold",
                          p.side === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down",
                        )}
                      >
                        {p.side === "buy" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {p.side.toUpperCase()}
                      </span>
                      <span className="font-mono text-[11px] font-bold">{p.symbol}</span>
                      <span className="font-mono text-[9px] text-muted-foreground">{p.lots} lots</span>
                      {/* v11: WHO opened it — AI brain vs the user */}
                      {p.origin && <OriginChip origin={p.origin} />}
                      <span
                        className={cn(
                          "tnum ml-auto font-mono text-[11px] font-bold",
                          win ? "text-up" : "text-down",
                        )}
                      >
                        {win ? "+" : ""}{p.pnl.toFixed(2)}
                        <span className="ml-1 text-[9px] opacity-70">({p.pnlR >= 0 ? "+" : ""}{p.pnlR.toFixed(2)}R)</span>
                      </span>
                      <Button
                        variant="ghost" size="sm" disabled={pending}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-down"
                        onClick={() => post("/api/trader/close", { ticket: p.ticket })}
                        aria-label={t("traderClose")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9px] text-muted-foreground">
                      <span>{t("traderEntry")} {p.entry}</span>
                      {/* SL — editable: type a price, Enter/blur → broker */}
                      <span className="flex items-center gap-1">
                        <span className={cn("font-bold", p.beMoved ? "text-up" : "")}>SL</span>
                        <Input
                          value={slDraftVal !== undefined ? slDraftVal : p.sl ? String(Number(p.sl.toFixed(5))) : ""}
                          onChange={(e) => setModDrafts((d) => ({ ...d, [`${p.ticket}:sl`]: e.target.value }))}
                          onBlur={() => commitMod(p.ticket, "sl", slDraftVal !== undefined ? slDraftVal : null)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          disabled={pending}
                          inputMode="decimal"
                          placeholder="—"
                          aria-label={t("traderSlEdit")}
                          title={t("traderSlEdit")}
                          className="tnum h-5 w-[62px] rounded border-border bg-card/80 px-1 text-center font-mono text-[9px] shadow-none focus-visible:ring-1 focus-visible:ring-gold/50"
                        />
                        {p.beMoved && <span className="font-bold text-up">BE✓</span>}
                      </span>
                      {/* TP — editable */}
                      <span className="flex items-center gap-1">
                        <span className="font-bold">TP</span>
                        <Input
                          value={tpDraftVal !== undefined ? tpDraftVal : p.tp ? String(Number(p.tp.toFixed(5))) : ""}
                          onChange={(e) => setModDrafts((d) => ({ ...d, [`${p.ticket}:tp`]: e.target.value }))}
                          onBlur={() => commitMod(p.ticket, "tp", tpDraftVal !== undefined ? tpDraftVal : null)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          disabled={pending}
                          inputMode="decimal"
                          placeholder="—"
                          aria-label={t("traderTpEdit")}
                          title={t("traderTpEdit")}
                          className="tnum h-5 w-[62px] rounded border-border bg-card/80 px-1 text-center font-mono text-[9px] shadow-none focus-visible:ring-1 focus-visible:ring-gold/50"
                        />
                      </span>
                      {/* SL→BE — one-click stop to entry (+$0.05 lock) */}
                      <Button
                        variant="outline" size="sm" disabled={pending}
                        className={cn(
                          "h-5 gap-1 px-1.5 text-[8px] font-bold",
                          p.beMoved ? "border-up/40 text-up" : "border-gold/40 text-gold hover:bg-gold/10",
                        )}
                        title={p.beMoved ? t("traderBeDone") : t("traderBeHint")}
                        onClick={() => moveBe(p.ticket)}
                      >
                        <ShieldCheck className="h-2.5 w-2.5" />
                        {t("traderBe")}
                      </Button>
                      {p.tpUsdAway !== undefined && (
                        <span className="text-up" title={t("traderAwayTp")}>
                          → +${Math.abs(p.tpUsdAway).toFixed(2)}
                        </span>
                      )}
                      {p.slUsdAway !== undefined && (
                        <span className="text-down" title={t("traderAwaySl")}>
                          → −${Math.abs(p.slUsdAway).toFixed(2)}
                        </span>
                      )}
                      <span>{t("traderPeak")} {p.peakR.toFixed(2)}R</span>
                      {p.partialDone && (
                        <span className="rounded bg-up/15 px-1 font-bold text-up">{t("traderPartial")}</span>
                      )}
                      {p.adopted && (
                        <span className="rounded bg-gold/15 px-1 font-bold text-gold">{t("traderAdopted")}</span>
                      )}
                      {p.aiConfirmed && (
                        <span className="rounded bg-up/15 px-1 font-bold text-up">AI✓</span>
                      )}
                      <span className="ml-auto flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        {ageText(p.openedAt)}
                      </span>
                    </div>
                    {modErr && modErr.ticket === p.ticket && (
                      <p className="mt-1 text-[9px] font-semibold text-down">
                        ⚠ {t("traderModFailed")}: {modErr.msg}
                      </p>
                    )}
                    <p className="mt-1 truncate text-[9px] italic text-muted-foreground/60" title={p.reason}>
                      {p.reason}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* v11 PENDING ORDERS — live limit/stop orders mirrored from the
            broker (rendered only when any exist; cancel ✕ is optimistic) */}
        {pendingOrders.length > 0 && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("traderPendingOrders")}
              </h3>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{pendingOrders.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {pendingOrders.map((o) => {
                const isBuyType = o.orderType === 2 || o.orderType === 4;
                const cancelling = cancellingTickets.includes(o.ticket);
                const distPts = Math.abs(o.price - o.priceCurrent);
                const cm = cmEstimate(o.symbol, o.priceCurrent);
                return (
                  <div
                    key={o.ticket}
                    className={cn("rounded-lg border border-border bg-card/60 p-2.5 transition-opacity", cancelling && "opacity-50")}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[9px] font-bold",
                          isBuyType ? "bg-up/15 text-up" : "bg-down/15 text-down",
                        )}
                      >
                        {isBuyType ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {o.orderTypeName}
                      </span>
                      <span className="font-mono text-[11px] font-bold">{o.symbol}</span>
                      <span className="font-mono text-[9px] text-muted-foreground">{o.lots} lots</span>
                      <span className="tnum font-mono text-[10px] text-foreground/90">@ {fmtPrice(o.price)}</span>
                      <span
                        className="tnum ml-auto font-mono text-[9px] font-bold text-muted-foreground"
                        title={t("traderAwayFromMarket")}
                      >
                        {cm ? `−$${(distPts * o.lots * cm).toFixed(2)} away` : `−${distPts.toFixed(2)} pts away`}
                      </span>
                      <Button
                        variant="ghost" size="sm" disabled={pending || cancelling}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-down"
                        onClick={() => cancelPending(o.ticket)}
                        aria-label={t("traderCancelPending")}
                        title={t("traderCancelPending")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[9px] text-muted-foreground">
                      {o.sl > 0 && <span><span className="font-bold">SL</span> {fmtPrice(o.sl)}</span>}
                      {o.tp > 0 && <span><span className="font-bold">TP</span> {fmtPrice(o.tp)}</span>}
                      <span>now {fmtPrice(o.priceCurrent)}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        {ageText(o.timeSetup)}
                      </span>
                    </div>
                    {cancelErr && cancelErr.ticket === o.ticket && (
                      <p className="mt-1 text-[9px] font-semibold text-down">
                        ⚠ {t("traderOrderFailed")}: {cancelErr.msg}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* AI feelings */}
        {state.feelings.length > 0 && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("traderFeelings")}
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {state.feelings.map((f) => (
                <FeelCard key={f.symbol} feel={f} locale={locale} />
              ))}
            </div>
          </section>
        )}

        {/* per-pair rules (frontend-managed) */}
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("traderRules")}
            </h3>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
              {enabledRules.length}/{state.rules.length}
            </Badge>
          </div>
          <div className="space-y-1.5">
            {state.rules.map((r) => (
              <RuleRow
                key={r.symbol}
                rule={r}
                draft={drafts[`${r.symbol}:lots`] ?? String(r.lots)}
                draftMax={drafts[`${r.symbol}:maxPositions`] ?? String(r.maxPositions)}
                pending={pending}
                onToggle={(enabled) => patchConfig({
                  symbols: state.rules.map((x) => (x.symbol === r.symbol ? { ...x, enabled } : x)),
                })}
                onLotsChange={(v) => setDrafts((d) => ({ ...d, [`${r.symbol}:lots`]: v }))}
                onLotsCommit={(v) => commitDraft(r.symbol, "lots", v)}
                onMaxChange={(v) => setDrafts((d) => ({ ...d, [`${r.symbol}:maxPositions`]: v }))}
                onMaxCommit={(v) => commitDraft(r.symbol, "maxPositions", v)}
                onRemove={() => patchConfig({
                  symbols: state.rules.filter((x) => x.symbol !== r.symbol),
                })}
              />
            ))}
          </div>
          {/* add symbol */}
          <div className="mt-1.5 flex gap-1.5">
            <Select value="" onValueChange={(v) => { setNewSymbol(v); }}>
              <SelectTrigger className="h-8 min-w-0 flex-1 border-border bg-card/60 px-2 text-[10px]">
                <span className="truncate text-muted-foreground">
                  {newSymbol || t("traderAddSymbol")}
                </span>
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {availableSymbols.map((s) => (
                  <SelectItem key={s} value={s} className="font-mono text-[11px]">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline" size="sm" disabled={!newSymbol || pending}
              className="h-8 gap-1 px-2.5 text-[10px] font-bold"
              onClick={() => {
                if (!newSymbol) return;
                patchConfig({
                  symbols: [...state.rules, { symbol: newSymbol, enabled: true, lots: 0.01, maxPositions: 1 }],
                });
                setNewSymbol("");
              }}
            >
              <Plus className="h-3 w-3" />
              {t("traderAdd")}
            </Button>
          </div>
        </section>

        {/* today stats */}
        <section className="grid grid-cols-4 gap-1.5">
          {[
            { label: t("traderTodayTrades"), value: String(state.today.trades), tone: "" },
            { label: t("traderTodayWins"), value: `${state.today.wins}W/${state.today.losses}L`, tone: state.today.wins >= state.today.losses ? "text-up" : "text-down" },
            { label: t("traderTodayWinRate"), value: `${state.today.winPct}%`, tone: "" },
            { label: t("traderTodayPnl"), value: fmtMoney(state.today.pnl, state.currency), tone: state.today.pnl >= 0 ? "text-up" : "text-down" },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-card/50 p-2 text-center">
              <div className={cn("tnum font-mono text-[12px] font-bold", s.tone)}>{s.value}</div>
              <div className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </section>

        {/* ── MEMORY & LESSONS — the agentic brain's own notebook ── */}
        {state.memory && state.memory.tradesAnalyzed > 0 && (
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <GraduationCap className="h-3.5 w-3.5 text-gold" />
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("traderMemory")}
              </h3>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                {state.memory.tradesAnalyzed} {t("traderMemTrades")}
              </Badge>
              <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                {t("traderMemLifetime")}: <span className={state.memory.winRate >= 0.5 ? "font-bold text-up" : "font-bold text-down"}>{Math.round(state.memory.winRate * 100)}%</span>
                <span className="mx-1 opacity-40">·</span>
                {t("traderMemAvgR")}: <span className={state.memory.avgR >= 0 ? "font-bold text-up" : "font-bold text-down"}>{state.memory.avgR >= 0 ? "+" : ""}{state.memory.avgR.toFixed(2)}R</span>
              </span>
            </div>

            {/* learned per-symbol edges (adaptive thresholds live here) */}
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {state.memory.edges.filter((e) => e.n > 0).map((e) => (
                <EdgeChip key={e.symbol} edge={e} locale={locale} />
              ))}
            </div>

            {/* the lessons themselves — the brain talking to its future self */}
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-2">
              {[...state.memory.lessons].reverse().map((l, i) => (
                <div key={`${l.at}-${i}`} className="flex items-start gap-2 text-[10px] leading-snug">
                  <BookOpenText className={cn(
                    "mt-0.5 h-3 w-3 shrink-0",
                    l.tone === "good" ? "text-up" : l.tone === "bad" ? "text-down" : l.tone === "warn" ? "text-gold" : "text-muted-foreground",
                  )} />
                  <span className={cn(
                    "min-w-0",
                    l.tone === "good" ? "text-foreground/90" : l.tone === "bad" ? "text-down/90"
                      : l.tone === "warn" ? "text-gold/90" : "text-foreground/80",
                  )}>
                    {l.text}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[8.5px] text-muted-foreground/50">
                    {new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
              {state.memory.lessons.length === 0 && (
                <p className="text-center text-[10px] text-muted-foreground/60">{t("traderNoLessons")}</p>
              )}
            </div>
          </section>
        )}

        {/* thinking log */}
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("traderBrainLog")}
            </h3>
          </div>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-2">
            {[...state.brain].reverse().map((b, i) => (
              <div key={`${b.at}-${i}`} className="flex items-start gap-2 text-[10px] leading-snug">
                <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground/60">
                  {new Date(b.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span
                  className={cn(
                    "min-w-0",
                    b.tone === "good" ? "text-up" : b.tone === "bad" ? "text-down"
                      : b.tone === "warn" ? "text-gold" : "text-foreground/80",
                  )}
                >
                  {b.text}
                </span>
              </div>
            ))}
            {state.brain.length === 0 && (
              <p className="text-center text-[10px] text-muted-foreground/60">{t("traderNoThoughts")}</p>
            )}
          </div>
        </section>

        {/* journal */}
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("traderJournal")}
            </h3>
            <FlaskConical className="h-3 w-3 text-muted-foreground/50" />
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-2">
            {[...state.journal].reverse().map((j) => (
              <div key={j.id} className="flex items-start gap-2 text-[10px] leading-snug">
                <span
                  className={cn(
                    "shrink-0 rounded px-1 font-mono text-[8px] font-bold uppercase",
                    j.action === "open" ? "bg-gold/15 text-gold"
                      : j.action === "close" ? (j.pnl ?? 0) >= 0 ? "bg-up/15 text-up" : "bg-down/15 text-down"
                      : j.action === "error" ? "bg-down/15 text-down"
                      : j.action === "halt" ? "bg-gold/15 text-gold"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {j.action}
                </span>
                {j.exitKind && (
                  <span
                    className={cn("shrink-0 rounded px-1 font-mono text-[8px] font-bold uppercase", EXIT_CHIP[j.exitKind].cls)}
                    title={t(EXIT_CHIP[j.exitKind].titleKey)}
                  >
                    {EXIT_CHIP[j.exitKind].label}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  {j.symbol && <span className="font-mono font-bold">{j.symbol} </span>}
                  <span className="text-muted-foreground">{j.reason}</span>
                  {j.pnl !== undefined && (
                    <span className={cn("tnum ml-1 font-mono font-bold", j.pnl >= 0 ? "text-up" : "text-down")}>
                      {j.pnl >= 0 ? "+" : ""}{j.pnl.toFixed(2)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground/50">
                  {new Date(j.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
            {state.journal.length === 0 && (
              <p className="text-center text-[10px] text-muted-foreground/60">{t("traderNoJournal")}</p>
            )}
          </div>
        </section>

        {/* v11 ORDER HISTORY — the broker's own closed-deal history (the last
            24h, AI AND manual trades, WHO opened each + HOW it ended) */}
        <section>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("traderOrderHistory")}
            </h3>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px]">{recentHistory.length}</Badge>
            <span className="ml-auto text-[8.5px] text-muted-foreground/60">{t("traderHistoryNote")}</span>
          </div>
          <div className="slim-scroll max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-2">
            {recentHistory.slice(0, 15).map((h) => (
              <div key={h.positionId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-snug">
                <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground/60">
                  {new Date(h.closedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="shrink-0 font-mono text-[10px] font-bold">{h.symbol}</span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1 font-mono text-[8px] font-bold uppercase",
                    h.side === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down",
                  )}
                >
                  {h.side}
                </span>
                <OriginChip origin={h.origin} />
                <span
                  className="tnum shrink-0 font-mono text-[9px] text-muted-foreground"
                  title={`${t("traderEntry")} ${fmtPrice(h.entry)} → ${fmtPrice(h.exit)}`}
                >
                  {fmtPrice(h.entry)}→{fmtPrice(h.exit)}
                </span>
                <span className={cn("tnum ml-auto shrink-0 font-mono text-[10px] font-bold", h.pnl >= 0 ? "text-up" : "text-down")}>
                  {h.pnl >= 0 ? "+$" : "−$"}{Math.abs(h.pnl).toFixed(2)}
                </span>
                <span
                  className={cn("shrink-0 rounded px-1 font-mono text-[8px] font-bold uppercase", EXIT_CHIP[h.exitKind].cls)}
                  title={t(EXIT_CHIP[h.exitKind].titleKey)}
                >
                  {EXIT_CHIP[h.exitKind].label}
                </span>
              </div>
            ))}
            {recentHistory.length === 0 && (
              <p className="text-center text-[10px] text-muted-foreground/60">{t("traderNoHistory")}</p>
            )}
          </div>
        </section>

        {/* REAL AI model verdicts */}
        <RealAiCard state={state} />

        {/* LLM deep think */}
        <AiThinkCard state={state} />
      </div>
    </div>
  );
}

// ── per-rule row ──

/** learned-edge chip: n trades, EMA win rate, and the adaptive gate it drives */
function EdgeChip({ edge, locale }: { edge: SymbolEdgeStat; locale: string }) {
  const wr = edge.winRate;
  const tone = edge.consecLosses >= 3
    ? "border-down/40 bg-down/10 text-down"
    : wr >= 0.55
      ? "border-up/40 bg-up/10 text-up"
      : "border-border bg-card/60 text-muted-foreground";
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-md border px-1.5 font-mono text-[9px] font-bold", tone)}
      title={locale === "bn"
        ? `${edge.symbol}: ${edge.n}টি ট্রেড শেখা · উইন-রেট ${Math.round(wr * 100)}% · অ্যাডাপটিভ গেট ×${edge.adaptiveMin.toFixed(2)}${edge.consecLosses >= 3 ? ` · টানা ${edge.consecLosses} লসে সতর্ক` : ""}`
        : `${edge.symbol}: ${edge.n} trades learned · win ${Math.round(wr * 100)}% · adaptive gate ×${edge.adaptiveMin.toFixed(2)}${edge.consecLosses >= 3 ? ` · cautious after ${edge.consecLosses} losses` : ""}`}
    >
      {edge.symbol}
      <span className={cn(wr >= 0.5 ? "text-up" : "text-down")}>{Math.round(wr * 100)}%</span>
      <span className="opacity-60">×{edge.adaptiveMin.toFixed(2)}</span>
      {edge.consecLosses >= 3 && <span className="font-black">!</span>}
    </span>
  );
}

function RuleRow({
  rule, draft, draftMax, pending,
  onToggle, onLotsChange, onLotsCommit, onMaxChange, onMaxCommit, onRemove,
}: {
  rule: TraderSymbolRule;
  draft: string;
  draftMax: string;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onLotsChange: (v: string) => void;
  onLotsCommit: (v: string) => void;
  onMaxChange: (v: string) => void;
  onMaxCommit: (v: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-lg border p-2 transition-colors",
      rule.enabled ? "border-gold/25 bg-gold/[0.04]" : "border-border bg-card/40",
    )}>
      <Switch
        checked={rule.enabled}
        onCheckedChange={onToggle}
        disabled={pending}
        className="scale-90"
        aria-label={`${rule.symbol} enabled`}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold">{rule.symbol}</span>
      <label className="flex items-center gap-1" aria-label="lot size">
        <span className="text-[8px] font-semibold uppercase text-muted-foreground">{t("traderLots")}</span>
        <Input
          value={draft}
          onChange={(e) => onLotsChange(e.target.value)}
          onBlur={() => onLotsCommit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") onLotsCommit(draft); }}
          disabled={pending}
          inputMode="decimal"
          className="tnum h-6 w-14 border-border bg-background px-1.5 text-center font-mono text-[10px]"
        />
      </label>
      <label className="flex items-center gap-1" aria-label="max positions" title={t("traderMaxPosHint")}>
        <span className="text-[8px] font-semibold uppercase text-muted-foreground">{t("traderMaxPos")}</span>
        <Input
          value={draftMax}
          onChange={(e) => onMaxChange(e.target.value)}
          onBlur={() => onMaxCommit(draftMax)}
          onKeyDown={(e) => { if (e.key === "Enter") onMaxCommit(draftMax); }}
          disabled={pending}
          inputMode="numeric"
          className="tnum h-6 w-10 border-border bg-background px-1.5 text-center font-mono text-[10px]"
        />
      </label>
      <Button
        variant="ghost" size="sm" disabled={pending}
        className="h-6 w-6 shrink-0 p-0 text-muted-foreground/60 hover:text-down"
        onClick={onRemove}
        aria-label={`remove ${rule.symbol}`}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
