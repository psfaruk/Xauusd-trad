/**
 * AI Trader v2 — the AGENTIC trading brain.
 *
 * Like a modern reasoning model (Claude / GPT / Kimi / GLM / Grok) it has:
 *   PERCEPTION  — per-tick "feelings" (confidence/fear/greed/patience/momentum)
 *                 from the order-flow X-ray, updated EVERY loop beat (1.2s),
 *                 plus instant thoughts on lamp engage/disengage transitions.
 *   WORKING MEM — trend/ATR/extension snapshot + tick momentum per symbol.
 *   DECISION    — CONFLUENCE entries: TICK-MOMENTUM or lamp conviction +
 *                 8-FRAME MTF consensus (1m/2m/3m/5m/10m/15m/30m/1H) +
 *                 cross-candle delta + area-chart tick path. SL respects a
 *                 spread budget; TP banks profit at a fixed $ target (v6).
 *   MONITORING   — $-target exit (bank +$tpUsd, default $0.50), breakeven,
 *                 flip-close, time-stop, adverse cut — and every close is
 *                 CLASSIFIED (TP / SL / FLIP / ADVERSE / TIME / AI / MANUAL)
 *                 so the app's AI narration can follow every trade (v6).
 *   MEMORY      — every closed trade stored with full features (episodic
 *                 memory), reflected into LESSONS (বাংলা), per-symbol
 *                 win-rate EMA that ADAPTS entry thresholds (learning from
 *                 mistakes), consecutive-loss circuit breakers.
 *
 * Anti-phantom armor (Sep-29 incident): a position is only declared "gone"
 * after it is missing from 2 consecutive broker syncs AND is older than 30s;
 * every ticket is verified against the broker's own position list right
 * after opening (ticket corrected if the cmd-19 order field disagrees).
 */

import fs from "node:fs";
import path from "node:path";
import type { FlowTracker, FlowPayload } from "./flow";
import type { Mt5Position, TradeResult, TradeSide, AccountInfo, Mt5Deal, Mt5Order, BrokerPush } from "./mt5-client";
import { ORDER_TYPE_NAMES } from "./mt5-client";
import type { MarketRead } from "./market-read";
import { AiJudge } from "./ai-judge";

// ═══════════════════════════ types (shared with the frontend) ═══════════════════════════

export type RiskMode = "conservative" | "balanced" | "aggressive";

export interface SymbolRule {
  symbol: string;
  enabled: boolean;
  lots: number;          // per-trade lot size (user-managed from the frontend)
  maxPositions: number;  // concurrent positions allowed on this symbol
}

export interface TraderConfig {
  enabled: boolean;          // master switch (user-managed)
  riskMode: RiskMode;
  dailyLossLimitPct: number; // halt new entries when day loss exceeds this
  /** v16.9 (audit E2) — OPT-IN risk-% position sizing. 0 (DEFAULT) = legacy
   *  fixed lots per symbol rule, NO behavior change; > 0 = size every entry
   *  from the LIVE balance (risk ≈ this % of the account at the SL), clamped
   *  to [0, MAX_RISK_PCT] percent (2 decimals). Falls back to the fixed lots
   *  whenever balance/contract metadata is missing — never a wrong size. */
  riskPct: number;
  /** fixed-dollar take profit — bank the whole trade at +$X (v6 user rule;
   *  0 = classic R-multiple mode). Default 0.50. */
  tpUsd: number;
  /** v9 BREAKEVEN TRIGGER — when live profit reaches this $ amount the SL
   *  jumps to entry + beLockUsd. 0 = AUTO (60% of tpUsd, or breakevenR in
   *  R-mode). The user's rule: “প্রফিট $10 হলে SL এন্ট্রি-দামে (বা একটু উপরে)”. */
  beUsd: number;
  /** profit locked at breakeven ($ above entry) — “বা তার একটু উপরে” */
  beLockUsd: number;
  /** v10: daily trade cap the user chose — 0 = UNLIMITED ("যত মন চাই তত") */
  maxDailyTrades: number;
  symbols: SymbolRule[];
}

export interface AiFeel {
  symbol: string;
  mood: "greedy" | "fearful" | "calm" | "excited" | "nervous" | "asleep";
  confidence: number; // 0..1 — conviction in the current bias
  fear: number;       // 0..1 — adverse volatility danger
  greed: number;      // 0..1 — trend extension / FOMO
  patience: number;   // 0..1 — wants to wait (quiet or mixed tape)
  bias: "buy" | "sell" | "none";
  momentum: number;   // -1..1 — live tick momentum (last ~20s)
}

export interface TraderPosition {
  ticket: number;        // broker position id (verified against positions())
  symbol: string;
  side: TradeSide;
  lots: number;
  lots0: number;         // ORIGINAL lots (partial closes reduce `lots`)
  entry: number;
  sl: number;
  tp: number;
  openedAt: number;      // epoch ms
  reason: string;        // why the brain opened it
  // live-updated by the brain:
  price: number;         // current mark price
  pnl: number;           // live P/L in account currency
  pnlR: number;          // live P/L in R (risk units)
  slDist: number;        // |entry − initial SL| (risk unit)
  peakR: number;         // best R reached (for trailing/feel)
  peakUsd?: number;      // v9: best $ profit reached ($-lock trail yardstick)
  beMoved: boolean;      // SL already at breakeven
  partialDone: boolean;  // partial profit already taken at +1R
  adopted: boolean;      // opened outside the brain (adopted)
  origin?: "brain" | "manual"; // v11: who opened it ("brain" = the AI, "manual" = user/MT5 side) — surfaced in the UI + AI context
  bankedPnl?: number;    // profit already banked by a partial close
  aiConfirmed?: boolean; // entry confirmed by the LLM judge
  execMs?: number;       // decision→order latency (ms) — how fast the brain moved
  lampAgeMs?: number;    // how old the lamp signal was when we entered
  tpUsdAway?: number;    // live $ remaining to the TP target (follow-up feed)
  slUsdAway?: number;    // live $ remaining to the SL (risk left)
}

export interface JournalEntry {
  id: number;
  at: number;
  symbol: string;
  action: "open" | "close" | "skip" | "halt" | "error" | "manage" | "info";
  side?: TradeSide;
  price?: number;
  lots?: number;
  pnl?: number;          // account currency (closes)
  /** HOW the trade ended — the follow-up flag the narration layer reads:
   *  TP = profit target hit · SL = stop hit · FLIP/ADVERSE/TIME = managed
   *  cuts · AI = judge closed it · MANUAL = user · PARTIAL = banked half */
  exitKind?: "TP" | "SL" | "FLIP" | "ADVERSE" | "TIME" | "AI" | "MANUAL" | "PARTIAL";
  reason: string;        // human-readable, EN (frontend localizes contextually)
}

export interface BrainThought { at: number; text: string; tone: "info" | "good" | "bad" | "warn" }

/** a lesson the brain wrote for itself after reflecting on a closed trade */
export interface TraderLesson {
  at: number;
  symbol: string;
  text: string;          // বাংলা — the brain's own words
  tone: "info" | "good" | "bad" | "warn";
}

/** learned per-symbol edge — drives adaptive entry thresholds */
export interface SymbolEdgeStat {
  symbol: string;
  n: number;             // closed trades analyzed
  wins: number;
  winRate: number;       // EMA-smoothed win rate 0..1
  adaptiveMin: number;   // current adaptive min-strength multiplier
  consecLosses: number;  // consecutive losses (circuit breaker)
}

/** episodic memory — one row per closed trade, with the features at entry */
export interface TradeMemoryEntry {
  at: number;
  symbol: string;
  side: TradeSide;
  entry: number;
  exit: number;
  pnl: number;
  pnlR: number;
  peakR: number;
  heldSec: number;
  exitReason: string;
  entryStrength: number;
  atrRatio: number;      // slDist / ATR
  ageFrac: number;       // candle age fraction at entry
  session: "asia" | "europe" | "us" | "late";
  win: boolean;
}

/** one LLM verdict — the real AI model's live decisions (shown in the UI) */
export interface AiVerdictRecord {
  at: number;
  symbol: string;
  kind: "entry" | "review";
  side?: "buy" | "sell";
  decision: string;    // buy/sell/pass/hold/tighten/close
  conf: number;        // 0..100
  note: string;        // বাংলা
  applied?: boolean;   // did the brain act on it
}

/** v11: a PENDING (limit/stop) order mirrored from the broker — real-time. */
export interface TraderPendingOrder {
  ticket: number;
  symbol: string;
  orderType: number;      // 2=BUY LIMIT 3=SELL LIMIT 4=BUY STOP 5=SELL STOP
  orderTypeName: string;
  lots: number;
  price: number;
  sl: number;
  tp: number;
  priceCurrent: number;
  timeSetup: number;      // epoch ms
  comment: string;
}

/** v11: a CLOSED trade from the broker's deal history — the account's real
 *  order history (brain AND manual), classified. */
export interface TraderHistoryEntry {
  positionId: number;
  symbol: string;
  side: TradeSide;        // direction of the OPENING deal
  origin: "brain" | "manual";
  lots: number;
  entry: number;
  exit: number;
  pnl: number;            // gross $ across all out-deals (incl. commission+swap)
  openedAt: number;       // epoch ms
  closedAt: number;       // epoch ms
  exitKind: JournalEntry["exitKind"];
  comment: string;
}

export interface TraderState {
  enabled: boolean;
  riskMode: RiskMode;
  /** v16.9 (audit E2): risk-% position sizing — 0 = legacy fixed lots
   *  (default, no silent behavior change); > 0 sizes every entry from the
   *  live balance: lots = (balance × riskPct%) / (SL distance × $-per-
   *  price-unit-per-lot), rounded DOWN to the lot step, clamped to
   *  [minLot, MAX_LOT]. Mirrors the optional field in the app's types.ts. */
  riskPct: number;
  tpUsd: number;             // active fixed-dollar profit target (0 = R-mode)
  beUsd: number;             // v9: breakeven trigger $ (0 = auto: 60% of tpUsd / breakevenR)
  beLockUsd: number;         // v9: $ locked above entry when BE fires
  maxDailyTrades: number;    // v10: daily cap (0 = unlimited)
  accountLogin: number;      // v10: which MT5 login the brain follows
  serverName: string;        // v10: broker server name
  connected: boolean;
  source: string;
  noFunds: boolean;          // balance ≤ 0 or NO_MONEY received
  balance: number;
  equity: number;            // v9 LIVE: balance + floating P/L, updated every beat
  sessionStartBalance: number; // balance when this brain session began
  balanceHist: { at: number; balance: number }[]; // balance trend (sparkline feed)
  floatingPnl: number;       // Σ live position P/L (running profit on open trades)
  currency: string;
  haltedToday: boolean;      // daily loss / trade limit hit
  haltReason: string;
  positions: TraderPosition[];
  pendingOrders: TraderPendingOrder[];  // v11: live pending (limit/stop) orders
  recentHistory: TraderHistoryEntry[];  // v11: recent closed trades (broker deals)
  lastSyncAt: number;                   // v11: last successful cmd-4 sync (epoch ms; 0 = never)
  rules: SymbolRule[];
  feelings: AiFeel[];
  journal: JournalEntry[];   // newest last, capped
  brain: BrainThought[];     // newest last, capped — the thinking log
  today: { trades: number; wins: number; losses: number; pnl: number; winPct: number };
  memory: {
    lessons: TraderLesson[];       // newest last
    edges: SymbolEdgeStat[];       // per-symbol learned edge
    tradesAnalyzed: number;        // total closed trades in episodic memory
    winRate: number;               // lifetime win rate 0..1
    avgR: number;                  // lifetime average R per trade
  };
  ai: {
    verdicts: AiVerdictRecord[];  // newest last, capped 14
    stats: { ok: number; fail: number; avgMs: number; lastError: string; model: string };
    exec: { lastMs: number; avgMs: number; n: number }; // signal→order latency
  };
  updatedAt: number;
}

/** What the host (manager) must provide — keeps trader.ts decoupled. */
export interface TraderHost {
  readonly connected: boolean;
  readonly source: "mt5" | "disconnected" | "demo";
  getQuote(symbol: string): { bid: number; ask: number; mid: number } | null;
  digits(symbol: string): number;
  getCandles(symbol: string, tf: string, limit: number): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]>;
  getTicks(symbol: string, sec: number): { t: number; p: number }[];
  getOrCreateTracker(symbol: string, tf: string): FlowTracker;
  marketRead(symbol: string, tf?: string, limit?: number): Promise<MarketRead | null>;
  /** force a fresh MT5 session (wedged cmd-4 etc. — quotes flow, lists don't) */
  recycleSession(): void;
  account(): Promise<AccountInfo | null>;
  /** v10: which login/server the brain is following (displayed in the app) */
  accountMeta(): { login: number; server: string };
  positions(): Promise<{ positions: Mt5Position[]; pendingOrders: number; orders: Mt5Order[] }>;
  /** v11: place a pending (limit/stop) order from the app */
  pendingOrder(symbol: string, orderType: 2 | 3 | 4 | 5, lots: number, price: number, opts: { sl?: number; tp?: number; digits?: number; comment?: string }): Promise<TradeResult>;
  /** v11: cancel a pending order from the app */
  cancelOrder(symbol: string, orderType: number, lots: number, price: number, ticket: number, opts: { digits?: number }): Promise<TradeResult>;
  /** v12: BROKER clock (server now + broker offset) — the candle-age gate and
   *  forming-bar flags must follow the broker's minute, not the container's
   *  (a shifted container clock phased entries into the wrong part of the
   *  M1 bar — the audit's High #10) */
  brokerNowSec(): number;
  /** v16 EVENT-FIRST: register for the broker's own account/trade pushes
  *  (cmd 14/19/22). Optional — older hosts / unit tests without a live
  *  manager simply keep polling. */
  onTradePush?(cb: (ev: BrokerPush) => void): void;
  marketOrderAt(symbol: string, side: TradeSide, lots: number, price: number, opts: { sl: number; tp: number; digits: number; comment: string }): Promise<TradeResult>;
  closePosition(symbol: string, side: TradeSide, lots: number, price: number, ticket: number, opts: { digits: number; comment?: string }): Promise<TradeResult>;
  modifyPosition(symbol: string, side: TradeSide, lots: number, price: number, ticket: number, sl: number, tp: number, opts: { digits: number }): Promise<TradeResult>;
  deals(fromSec: number, toSec: number): Promise<Mt5Deal[]>;
}

// ═══════════════════════════ risk profiles ═══════════════════════════

interface RiskProfile {
  minStrength: number;    // lamp strength gate to enter (before adaptive multiplier)
  slAtrMult: number;      // SL = ATR(14, M1) × this (floor: spread budget)
  tpR: number;            // TP = R × tpR
  breakevenR: number;     // move SL→entry after this R
  trailR: number;         // start trailing after this R
  trailGive: number;      // trail distance = max(0.5R, profit − trailGive×R)
  flipStrength: number;   // opposite lamp strength that force-closes
  maxHoldMs: number;      // time stop
  maxAdverseR: number;    // cut before the hard SL when flow is against us
  cooldownMs: number;     // per-symbol rest between entries
}

const RISK: Record<RiskMode, RiskProfile> = {
  // ── v12 RETUNE (the R:R math audit): TP is R-MULTIPLE by default now —
  //    $0.50-style scalps were structurally −EV (TP ≈ spread×2 while SL was
  //    ATR-sized ⇒ R:R ≈ 1:6, needing 85-90% wins to break even). In R-mode
  //    conservative targets 1.6R with a later breakeven (0.8R — the old 0.6R
  //    BE let gold wicks stop out winners that had barely started). ──
  conservative: {
    minStrength: 0.55, slAtrMult: 1.8, tpR: 1.6, breakevenR: 0.8, trailR: 1.1,
    trailGive: 0.55, flipStrength: 0.72, maxHoldMs: 10 * 60_000, maxAdverseR: 0.7,
    cooldownMs: 100_000,
  },
  balanced: {
    minStrength: 0.45, slAtrMult: 1.5, tpR: 1.5, breakevenR: 0.7, trailR: 1.1,
    trailGive: 0.6, flipStrength: 0.68, maxHoldMs: 8 * 60_000, maxAdverseR: 0.6,
    cooldownMs: 70_000,
  },
  aggressive: {
    minStrength: 0.35, slAtrMult: 1.2, tpR: 1.8, breakevenR: 0.8, trailR: 1.2,
    trailGive: 0.7, flipStrength: 0.62, maxHoldMs: 6 * 60_000, maxAdverseR: 0.55,
    cooldownMs: 45_000,
  },
};

// v12 SAFETY CAPS (the audit's "lot 100 / 500 positions / unlimited trades"
// blow-up surface): these are HARD limits — updateConfig() can never exceed
// them, so even a compromised UI cannot set a 100-lot order.
const MAX_LOT = 1.0;              // 1.00 lots on gold ≈ $100/point — plenty for a $500 account
const MAX_POSITIONS_PER_SYMBOL = 5;
const MAX_DAILY_TRADES_CAP = 100;
const MIN_TP_USD = 3;             // $-mode TP below this is inside spread noise (0.01-lot gold ≈ $3–5)
const MAX_RISK_PCT = 2;           // audit E2 cap: risk-% sizing may never exceed 2% of balance
                                   // per entry (0 = OFF — legacy fixed lots; no silent behavior change)

const DEFAULT_SYMBOLS: SymbolRule[] = [
  // v12 SAFE DEFAULTS (the audit's step-by-step): ONE symbol, ONE position,
  //  0.01 lots. The other majors stay in the list (user can flip them on)
  //  but arrive DISABLED — arming four markets with the same $-target was a
  //  documented loss machine.
  { symbol: "XAUUSDm", enabled: true, lots: 0.01, maxPositions: 1 },
  { symbol: "BTCUSDm", enabled: false, lots: 0.01, maxPositions: 1 },
  { symbol: "USTEC_x100m", enabled: false, lots: 0.01, maxPositions: 1 },
  { symbol: "USOILm", enabled: false, lots: 0.01, maxPositions: 1 },
  { symbol: "EURUSDm", enabled: false, lots: 0.01, maxPositions: 1 },
  { symbol: "GBPUSDm", enabled: false, lots: 0.01, maxPositions: 1 },
];

// ── agentic constants ──
const STATE_VERSION = 10;             // v10 (v12.1): R-MODE MIGRATION GATE FIX — the v12 clamp
                                      // piggybacked on `vSaved < 9`, but v9-era code ALREADY saved
                                      // `version: 9`, so every real state file skipped the clamp and
                                      // the brain kept running the audit's loss-machine settings
                                      // ($0.50 TP / balanced / 40 daily trades). Gate moved to < 10:
                                      // every pre-v12.1 state — including version 9 files — is now
                                      // clamped exactly once ($TP<3 → R-mode, conservative risk,
                                      // daily ≤ cap, lots/positions ≤ hard limits).
                                      // v9: $-mode TP < $3 switched to R-multiple mode (superseded).
                                      // v8: final honest repair — today's counters rebuilt from EPISODIC
                                      // MEMORY (the brain's own trades only; memorize() never records
                                      // adopted positions, so phantom/user settles can never reach it).
                                      // v7 armor: zombie pre-check + silent settles + no adopted
                                      // restore (the 09:28–09:32 storm).
const SPREAD_BUDGET = 3.5;            // SL ≥ spread × 3.5 (spread ≤ ~29% of SL by construction)
const SL_ATR_CAP = 3.6;               // SL never wider than ATR × 3.6
const GLOBAL_MAX_POSITIONS = 10;       // v12: 50→10 — the audit: 50 concurrent positions on a $500
                                       // account with 0.01-lot gold is not risk, it is a blow-up
const MIN_LOT_SPLIT = 0.02;           // partial profit needs at least this many lots
const EDGE_EMA_ALPHA = 0.18;          // win-rate EMA speed
const ADAPT_MIN = 0.85, ADAPT_MAX = 1.25; // adaptive min-strength multiplier bounds
const CONSEC_LOSS_BREAK = 3;          // circuit breaker after this many consecutive losses

// ── the real-AI layer (LLM judge) ──
const PRIORITY_SYMBOLS = new Set(["XAUUSDm", "USOILm", "USTEC_x100m"]); // user: trade these MORE
// v14: raised 0.26 → 0.34 — the audit: a 0.26 priority floor let weak
// tape entries through even in R-mode. Tighter than the old v5 CAND_FLOOR
// (0.30) was on priority pairs, still below STD so the LLM judge rationale
// (priority = filtered harder downstream) survives.
const CAND_FLOOR_PRIO = 0.34;         // lamp floor to become an LLM candidate (priority pairs)
const CAND_FLOOR_STD = 0.42;         // same for the rest
const EXT_MAX_ATR = 1.75;            // never chase further than this many ATR past EMA20 (entry chase guard)
const JUDGE_TIMEOUT_MS = 4500;       // LLM call budget — beyond this, local rules decide (speed matters)
const JUDGE_COOLDOWN_MS = 12_000;    // per-symbol: don't re-ask the judge more often
const REVIEW_EVERY_MS = 75_000;      // per-position LLM review cadence
const REVIEW_FIRST_MS = 40_000;      // first review shortly after entry
const VERDICT_MAX = 14;              // verdict log cap (state)

// ── v5 brain additions ──
const MR_CACHE_MS = 25_000;          // MarketRead cache TTL (structure read stays warm)
const TOMBSTONE_MAX = 400;           // settled tickets remembered — phantom armor
const STALE_LIST_RECYCLE = 3;        // consecutive syncs listing a settled ticket → session recycle

// ── v6 brain additions ──
const MTF_HIGH_TTL = 120_000;        // 30m/1H bias cache (they barely move in 2 min)
const MOM_ENTRY_ABS = 0.24;          // |tick momentum| that alone raises a candidate
const MOM_GATE_WITH = 0.20;          // momentum must push AT LEAST this hard with the side

const STATE_FILE = () => path.join(process.cwd(), "data", "trader-state.json");
const JOURNAL_MAX = 240;
const BRAIN_MAX = 90;
const LESSON_MAX = 40;
const MEMORY_MAX = 220;
const LOOP_MS = 1200;
const POS_SYNC_MS = 500;              // v11: 1s→500ms — ms-level account mirror (the user's demand:
                                     // a manual MT5 trade must appear in the app within ~a second)

function sessionOf(at: number): TradeMemoryEntry["session"] {
  const h = new Date(at).getUTCHours();
  if (h < 7) return "asia";
  if (h < 13) return "europe";
  if (h < 21) return "us";
  return "late";
}

// ═══════════════════════════ the brain ═══════════════════════════

export class AiTrader {
  private host: TraderHost;
  private cfg: TraderConfig;
  private positions = new Map<number, TraderPosition>(); // ticket → live view
  private journal: JournalEntry[] = [];
  private brain: BrainThought[] = [];
  private lessons: TraderLesson[] = [];
  private mem: TradeMemoryEntry[] = [];
  private edges = new Map<string, SymbolEdgeStat>();
  private feelings = new Map<string, AiFeel>();
  private lastEntryAt = new Map<string, number>(); // symbol → ms
  private prevLamp = new Map<string, string>();    // symbol → last lamp state (transition thoughts)
  private vanish = new Map<number, number>();      // ticket → consecutive missing-sync count
  private reconcileTries = new Map<number, number>(); // ticket → deals-retries before zombie-settle
  private todayKey = "";
  private emptySyncs = 0;
  private today = { trades: 0, wins: 0, losses: 0, pnl: 0, winPct: 0 };
  private dayStartEquity: number | null = null;
  private haltedToday = false;
  private haltReason = "";
  private noFunds = false;
  // (v16: noFundsCheckedAt retired — the probe runs on its own 1s timer now)
  private acct: { balance: number; equity: number; currency: string } | null = null;
  // ── v9 account follow-up: session baseline + balance trend + external-move watch ──
  private sessionStartBalance: number | null = null;
  private balanceHist: { at: number; balance: number }[] = [];
  private lastSettleAt = 0;
  private lastExternalBalNote = 0;
  // v9.1 flat-account wedge detector: throttle + consecutive suspicious scans
  private lastFlatDealsCheck = 0;
  private flatWedgeHits = 0;
  // v10: broker-truth P/L calibration — the account's own CLOSED deals
  // reveal each symbol's TRUE $-per-point-per-lot (race-free: every number
  // comes from the broker). The static guess once mis-scaled USTEC_x100m by
  // 100× (app showed −$0.13 while the broker bled −$26.11 — the "app shows a
  // few cents" bug). Locked once per symbol per session from deal history.
  private cmCal = new Map<string, number>();
  private cmCalNoted = new Set<string>();
  private cmCalTried = new Set<string>();
  private syncBusy = false;           // v10: 1s sync cadence must never overlap
  /** v16.2: sync pass counter — schedules the periodic deals-truth sweep */
  private syncCount = 0;
  // ── v16 EVENT-FIRST MIRROR ──
  /** a push-triggered sync arrived while one was running — re-run after
   *  (QUEUED, never dropped: a push means the broker's state CHANGED) */
  private syncQueued: "push" | null = null;
  /** ms of the last broker push — poll paths consult this to skip their
   *  deliberate waiting (the anti-phantom armor stays armed ONLY for
   *  push-silent polls, exactly as designed) */
  private lastBrokerPushAt = 0;
  /** coalesce gate for push-triggered refetch storms (180ms) */
  private pushSyncAt = 0;
  /** v16.2: per-position gate for cmd-19 targeted adopt/reconcile (1s) */
  private pushReconcileAt = new Map<number, number>();
  /** v16: account probe on its OWN timer — the AI judge's 4.5s busy window
   *  must never freeze the balance strip (the old probe lived inside tick()) */
  private acctTimer: ReturnType<typeof setInterval> | null = null;
  // v9 $-lock trail: ticket → last $ amount whose lock was JOURNALED (anti-spam)
  private trailLocks = new Map<number, number>();
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private journalId = 1;
  private busy = false;         // trade ops are serialized
  private generation = 0;       // hot-reload armor: stop() bumps it; in-flight
                                // decide() of a DYING brain must never place orders
                                // (the Sep-29 / 18:54 burst of duplicate entries)
  private onStateCb: ((s: TraderState) => void) | null = null;
  private lastEmit = 0;
  private trackers = new Map<string, FlowTracker>();
  // ── the real AI inside ──
  private judge = new AiJudge();
  private verdicts: AiVerdictRecord[] = [];
  private judgeBusyUntil = new Map<string, number>();   // symbol → ms (one in-flight judge call per symbol)
  private lastJudgeAt = new Map<string, number>();      // symbol → ms (judge cooldown)
  private nextReviewAt = new Map<number, number>();     // ticket → ms
  private aiCloseVotes = new Map<number, number>();     // ticket → consecutive close verdicts
  private reviewing = new Set<number>();               // tickets with an in-flight review

  // ── v5: phantom armor + speed + confluence ──
  private settled = new Map<number, number>();          // ticket → settledAt (NEVER re-adopt)
  private mrCache = new Map<string, { at: number; mr: MarketRead | null }>();
  private staleListHits = 0;                            // consecutive syncs listing settled tickets
  // ── v10.3: recycle-livelock armor ──
  private recycleTimes: number[] = [];                     // sync-triggered recycles (storm breaker window)
  private staleTicketRecycles = new Map<number, number>();  // ticket → times it hit the stale-list path
  // ── v11: millisecond account mirror ──
  private syncErrStreak = 0;                               // consecutive positions() failures (cmd-4 wedge)
  private lastSyncOkAt = 0;                                // last successful cmd-4 sync (syncAge feed)
  private pendingOrders: TraderPendingOrder[] = [];        // live pending (limit/stop) orders mirror
  private recentHistory: TraderHistoryEntry[] = [];        // closed-trades history from broker deals
  private historyAt = 0;                                   // last history rebuild
  private lastDealsSweepAt = 0;                            // v11 deals-truth-sweep throttle
  private lastMrWarm = 0;                               // MarketRead pre-warm clock
  private execLastMs = 0;                               // latest signal→order latency
  private execAvgMs = 0;                                // EMA of the above
  private execN = 0;

  // ── v6: MTF consensus cache (30m/1H bias — pre-warmed, decide() reads warm) ──
  private mtfHighCache = new Map<string, {
    at: number;
    m30: { dir: number; slopeAtr: number } | null;
    h1: { dir: number; slopeAtr: number } | null;
  }>();
  private lastSilentThinkAt = 0;   // v6.1: rate-limit for silent external settles
  // v6.2: per-symbol skip-LOG throttle — a skip every judge-cooldown drowned
  // the journal (60-entry UI window ≈ 12 min of skip noise, real opens/closes
  // invisible — the user's "এন্ট্রি হলো কি হলো না দেখা যায় না" complaint).
  // A skip is journaled when ≥90s passed OR the veto CATEGORY changed; the
  // matching thought is rate-limited to 45s per symbol.
  private lastSkipLogAt = new Map<string, { at: number; cat: string }>();
  private lastSkipThinkAt = new Map<string, number>();

  constructor(host: TraderHost) {
    this.host = host;
    this.cfg = {
      enabled: false, // user must consciously arm it
      riskMode: "conservative", // v12: was "balanced" — safe default after the R:R audit
      riskPct: 0,    // audit E2: DEFAULT 0 = legacy fixed lots — opt-in only, no silent change
      tpUsd: 0,       // v12: R-MULTIPLE mode by default (was $0.50 — structurally −EV:
                       // TP ≈ spread×2 vs ATR-sized SL ⇒ R:R ≈ 1:6). $-mode is still
                       // available but must be ≥ $3 (MIN_TP_USD).
      beUsd: 0,       // AUTO (60% of tpUsd in $-mode; breakevenR in R-mode)
      beLockUsd: 0.05, // lock a nickel above entry when BE fires
      dailyLossLimitPct: 3, // v12: 5→3 — the audit's daily-loss guard
      maxDailyTrades: 12,  // v12: 40→12 — fewer, better trades (was a churn machine)
      symbols: DEFAULT_SYMBOLS.map((s) => ({ ...s })),
    };
    // HOT-RELOAD SAFETY: bun --hot re-evaluates this module inside the SAME
    // process — the previous brain's timers would keep running and a SECOND
    // brain would trade in parallel (duplicate entries on one signal — the
    // Sep-29 incident). Kill the old instance; exactly one brain per process.
    const G = globalThis as unknown as { __aiTrader?: AiTrader };
    if (G.__aiTrader && G.__aiTrader !== this) {
      try { G.__aiTrader.stop(); } catch { /* already dead */ }
    }
    G.__aiTrader = this;
    this.loadState();
    // v16 EVENT-FIRST: the broker pushes cmd 14/19/22 the MOMENT anything
    // changes on the account (any connection: this app, the user's MT5
    // terminal, the server's own SL/TP execution). Mirror immediately —
    // account + positions + history at push latency; the polls stay as
    // backup for missed pushes only.
    try {
      this.host.onTradePush?.((ev) => this.onBrokerPush(ev));
    } catch { /* host without push support — polling covers it */ }
  }

  // ── persistence ──
  private loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
      if (raw?.config) {
        this.cfg = {
          ...this.cfg, ...raw.config,
          symbols: Array.isArray(raw.config.symbols) && raw.config.symbols.length
            ? raw.config.symbols : this.cfg.symbols,
        };
        // v16.9 (audit E2): sanitize riskPct from persisted/legacy states —
        // pre-v16.9 files have no riskPct (undefined), and anything that snuck
        // in out of range is clamped to [0, MAX_RISK_PCT]. Default stays 0
        // (legacy fixed lots) so loading an old state changes NOTHING.
        this.cfg.riskPct = Math.max(0, Math.min(MAX_RISK_PCT, Math.round((Number(this.cfg.riskPct) || 0) * 100) / 100));
      }
      if (Array.isArray(raw?.journal)) {
        this.journal = raw.journal.slice(-JOURNAL_MAX);
        this.journalId = (this.journal[this.journal.length - 1]?.id ?? 0) + 1;
      }
      if (Array.isArray(raw?.brain)) this.brain = raw.brain.slice(-BRAIN_MAX);
      if (Array.isArray(raw?.lessons)) this.lessons = raw.lessons.slice(-LESSON_MAX);
      if (Array.isArray(raw?.memory)) this.mem = raw.memory.slice(-MEMORY_MAX);
      if (Array.isArray(raw?.edges)) {
        for (const e of raw.edges) this.edges.set(e.symbol, e);
      }
      // restore open positions (restart/hot-reload continuity)
      if (Array.isArray(raw?.positions)) {
        for (const p of raw.positions) {
          if (p && typeof p.ticket === "number" && typeof p.symbol === "string") {
            // never restore a tombstoned ticket (settle raced a reload)
            if (this.settled.has(p.ticket)) continue;
            // v10.2: ADOPTED positions ARE restored again. v6.1 skipped them
            // (a stale cmd-4 list could smuggle closed relics back in), but
            // that made a manual trade that closed DURING a hot-reload window
            // vanish without a settle/journal — invisible to the user ("SL
            // হিট হলো কি হলো না" must always be answered). Now safe: the
            // missing-path AND the v10.1 empty-list proof both settle ONLY on
            // DEAL PROOF, and tombstones still block re-adoption of the
            // settled. A live manual position re-enters tracking seamlessly.
            this.positions.set(p.ticket, { ...p, lots0: p.lots0 ?? p.lots ?? 0, bankedPnl: p.bankedPnl ?? 0 });
            this.nextReviewAt.set(p.ticket, Date.now() + 20_000);
            this.aiCloseVotes.set(p.ticket, 0);
          }
        }
      }
      if (Array.isArray(raw?.settled)) {
        for (const [t, at] of raw.settled) {
          if (typeof t === "number" && !this.settled.has(t)) this.settled.set(t, at);
        }
      }
      const vSaved = raw?.version ?? 1;
      if (vSaved < 10) {
        // v10 (v12.1) R:R-AUDIT SAFETY MIGRATION — runs AFTER all raw fields
        // are loaded so the journalLog→saveState inside can never truncate
        // persisted state. The old config carried loss-machine settings —
        // $0.50 TP (inside spread noise), lot caps up to 100, unlimited
        // daily trades. Clamp EVERYTHING to the v12 safe limits and say it
        // out loud. Runs once; explicit user choices after this point are
        // respected (within the hard caps).
        // (v12.1 FIX: this gate was `< 9` while v9-era saves already wrote
        // version 9 — real states never migrated. Now < 10 vs STATE_VERSION 10.)
        const before = { tpUsd: this.cfg.tpUsd, riskMode: this.cfg.riskMode, maxDailyTrades: this.cfg.maxDailyTrades };
        if (this.cfg.tpUsd > 0 && this.cfg.tpUsd < MIN_TP_USD) this.cfg.tpUsd = 0;
        this.cfg.riskMode = "conservative";
        this.cfg.dailyLossLimitPct = Math.max(1, Math.min(10, this.cfg.dailyLossLimitPct));
        this.cfg.maxDailyTrades = Math.max(1, Math.min(MAX_DAILY_TRADES_CAP, this.cfg.maxDailyTrades || 12));
        this.cfg.symbols = this.cfg.symbols.map((s) => ({
          ...s,
          // v16.4: step-snapped lots (0.01) — legacy persisted states with
          // 0.015-style volumes can't reach the broker as 10014s either
          lots: Math.max(0.01, Math.min(MAX_LOT, Math.round((s.lots ?? 0.01) * 100) / 100)),
          maxPositions: Math.max(1, Math.min(MAX_POSITIONS_PER_SYMBOL, s.maxPositions ?? 1)),
        }));
        this.journalLog({
          action: "info", symbol: "",
          reason: `brain v12 R:R-audit migration — $TP ${before.tpUsd}→${this.cfg.tpUsd} (R-mode), risk ${before.riskMode}→conservative, daily ${before.maxDailyTrades}→${this.cfg.maxDailyTrades}, lots≤${MAX_LOT}, pos≤${MAX_POSITIONS_PER_SYMBOL}`,
        });
        this.think("🧠 v12 — R:R অডিট মাইগ্রেশন: ছোট-$ টার্গেট বন্ধ, R-মাল্টিপল মোড, লট/পজিশন/ডেইলি ক্যাপ সীমাবদ্ধ — আর ১:৬ R:R লস-মেশিন নয়", "good");
      }
      // ══ v12 PUBLIC-DEPLOY GUARD (always-on): on a PRODUCTION host with no
      //    APP_PASSWORD configured and no explicit TRADER_ARMED=1 opt-in,
      //    the brain must boot DISARMED — a public URL + armed brain without
      //    auth was the audit's Critical #1 (anyone could flip it on and
      //    drain the account). ══
      if (
        process.env.NODE_ENV === "production" &&
        this.cfg.enabled &&
        !process.env.APP_PASSWORD && process.env.TRADER_ARMED !== "1"
      ) {
        this.cfg.enabled = false;
        this.journalLog({
          action: "halt", symbol: "",
          reason: "public-deploy guard: auto-trade DISARMED at boot (no APP_PASSWORD set; set TRADER_ARMED=1 to override)",
        });
        this.think("🔒 পাবলিক ডিপ্লয় গার্ড — APP_PASSWORD নেই, তাই বুটে অটো-ট্রেড ডিসআর্মড। অথ সেট করে আবার ARM করুন", "warn");
      }
      if (vSaved < 8) {
        // v8 FINAL HONEST REPAIR — the phantom storm (v7 deployed mid-storm)
        // re-poisoned today's counters (56W/65L/−$211 while the brain's real
        // trades today were 5W/3L/+$8.29). Today's journal closes are dropped
        // (none match a brain open) and the counters are rebuilt from EPISODIC
        // MEMORY — memorize() records ONLY brain-opened trades, so this source
        // is phantom-proof by construction.
        const ds = new Date();
        ds.setUTCHours(0, 0, 0, 0);
        const from = ds.getTime();
        this.journal = this.journal.filter((j) => !(j.action === "close" && j.at >= from));
        const todays = this.mem.filter((m) => m.at >= from);
        let tw = 0, tl = 0, tp = 0;
        for (const m of todays) { tp += m.pnl; if (m.win) tw++; else tl++; }
        this.today = {
          trades: todays.length,
          wins: tw, losses: tl,
          pnl: Math.round(tp * 100) / 100,
          winPct: tw + tl ? Math.round((tw / (tw + tl)) * 100) : 0,
        };
        this.journalLog({
          action: "info", symbol: "",
          reason: `brain v8 — today honestly rebuilt from episodic memory: ${tw}W/${tl}L ${tp >= 0 ? "+" : "−"}$${Math.abs(tp).toFixed(2)} (phantom storm purged)`,
        });
        this.think(`🧠 v8 — ঝড়ে ভরে যাওয়া কাউন্টার মেমরি থেকে সৎভাবে বানালাম: আজ ${tw}W/${tl}L ${tp >= 0 ? "+" : "−"}$${Math.abs(tp).toFixed(2)} — এখন থেকে ফ্যান্টম ঢুকতে পারবে না`, "good");
      } else if (vSaved < 7) {
        // v7 ONE-TIME HONEST REPAIR — the 09:28 storm: a stale cmd-4 list
        // re-adopted 80+ long-closed positions and every phantom settle
        // booked a fake "close" into today's counters (4 real opens, 89
        // "closes", pnl −187). Keep only closes that MATCH a real open
        // (symbol+side+lots), drop the phantoms, recompute honestly.
        const ds = new Date();
        ds.setUTCHours(0, 0, 0, 0);
        const from = ds.getTime();
        const pools = this.journal
          .filter((j) => j.action === "open" && j.at >= from)
          .map((o) => `${o.symbol}|${o.side ?? ""}|${o.lots ?? 0}`);
        const kept: JournalEntry[] = [];
        let dropped = 0;
        for (const j of this.journal) {
          if (j.action === "close" && j.at >= from) {
            const k = `${j.symbol}|${j.side ?? ""}|${j.lots ?? 0}`;
            const idx = pools.indexOf(k);
            if (idx < 0) { dropped++; continue; } // phantom — no matching open
            pools.splice(idx, 1);                 // consume the match
          }
          kept.push(j);
        }
        this.journal = kept;
        this.recomputeToday();
        this.journalLog({
          action: "info", symbol: "",
          reason: `brain v7 — phantom-close storm repaired: ${dropped} fake closes dropped, today recomputed honestly`,
        });
        this.think(`🧠 v7 — ${dropped}টি ফ্যান্টম ক্লোজ বাদ দিয়ে আজকের হিসাব সৎভাবে ঠিক করলাম (ফ্যান্টম-স্টর্ম আর্মার যোগ হলো)`, "good");
      } else if (vSaved < 6) {
        // v6: $-target take profit + tick-momentum entries + 8-frame MTF
        // consensus + explicit TP/SL exit classification. No data migration
        // needed — the config merge fills tpUsd; counters stay honest.
        this.journalLog({
          action: "info", symbol: "",
          reason: "brain v6 — $-target TP (bank at +$0.50), tick-momentum entries, 8-frame MTF consensus, explicit TP/SL hit tracking",
        });
        this.think("🧠 ব্রেইন v6 — $০.৫০ টার্গেট-প্রফিট (লাভ হলেই ব্যাংক), টিক-মোমেন্টাম এন্ট্রি, ৮-টাইমফ্রেম কনফ্লুয়েন্স, TP/SL হিট এখন লাইভ ট্র্যাক হবে", "good");
      } else if (vSaved < 5) {
        // v5: the phantom-close re-adopt loop (a settled ticket re-adopted from
        // a stale broker list → time-stopped again → settled again, every 4s)
        // poisoned today's counters with 1000+ fake losses. Tombstones now
        // prevent it. Counters reset ONCE, honestly: today's journal closes
        // dropped, real opens kept.
        const ds = new Date();
        ds.setUTCHours(0, 0, 0, 0);
        const from = ds.getTime();
        this.journal = this.journal.filter((j) => !(j.at >= from && j.action === "close"));
        this.today = {
          trades: this.journal.filter((j) => j.at >= from && j.action === "open").length,
          wins: 0, losses: 0, pnl: 0, winPct: 0,
        };
        this.journalLog({
          action: "info", symbol: "",
          reason: "brain v5 — phantom re-adopt loop fixed (settled-ticket tombstones); poisoned today counters reset honestly",
        });
        this.think("🧠 ব্রেইন v5 — ফ্যান্টম কাউন্টিং বাগ ফিক্সড; ৩-চার্ট কনফ্লুয়েন্স এন্ট্রি + স্ট্রাকচার SL + এক্সিকিউশন স্পিড মেজারমেন্ট যোগ হলো", "good");
      } else if (vSaved < 4) {
        // (historical) v4: cmd-19 churn reset
        this.journal = this.journal.slice(-20);
        {
          const ds = new Date();
          ds.setUTCHours(0, 0, 0, 0);
          const from = ds.getTime();
          this.journal = this.journal.filter((j) => !(j.at >= from && j.action === "close"));
        }
        this.today = { trades: 0, wins: 0, losses: 0, pnl: 0, winPct: 0 };
        this.mem = [];
        this.lessons = [];
        this.edges.clear();
        this.journalLog({
          action: "info", symbol: "",
          reason: "brain upgraded to v4 (cmd-19 identity matching + modify-fix) — churn-polluted stats/edges/journal reset honestly",
        });
      }
      this.rebuildEdgesFromMemory();
      this.recomputeToday();
      // ══ v8 HONEST-COUNTER GUARD (always-on, idempotent — runs EVERY boot).
      //    Version-gated migrations proved unreliable under bun --hot (a dying
      //    instance can save the bumped version over the repaired state, so
      //    the next instance skips the repair). This guard instead VERIFIES:
      //    today's journal closes must roughly match the brain's real trades
      //    in EPISODIC MEMORY (memorize() never records adopted/phantom
      //    settles — phantom-proof by construction). A storm signature
      //    (closes ≫ real trades) purges the phantom closes and rebuilds the
      //    counters from memory. On a normal day it is a no-op. ══
      try {
        const dg = new Date();
        dg.setUTCHours(0, 0, 0, 0);
        const fromD = dg.getTime();
        const todays = this.mem.filter((m) => m.at >= fromD);
        let gw = 0, gl = 0, gp = 0;
        for (const m of todays) { gp += m.pnl; if (m.win) gw++; else gl++; }
        const jc = this.journal.filter((j) => j.action === "close" && j.at >= fromD).length;
        if (jc > Math.max(4, todays.length * 2)) {
          const purged = jc;
          this.journal = this.journal.filter((j) => !(j.action === "close" && j.at >= fromD));
          this.today = {
            trades: todays.length,
            wins: gw, losses: gl,
            pnl: Math.round(gp * 100) / 100,
            winPct: gw + gl ? Math.round((gw / (gw + gl)) * 100) : 0,
          };
          this.journalLog({
            action: "info", symbol: "",
            reason: `honest-counter guard: ${purged} phantom closes purged, today rebuilt from episodic memory (${gw}W/${gl}L ${gp >= 0 ? "+" : "−"}$${Math.abs(gp).toFixed(2)})`,
          });
          this.think(`🧠 কাউন্টার সৎ-রক্ষক: ${purged}টি ফ্যান্টম ক্লোজ বাদ দিলাম — আজ সত্যিকারের হিসাব ${gw}W/${gl}L ${gp >= 0 ? "+" : "−"}$${Math.abs(gp).toFixed(2)}`, "good");
        }
      } catch { /* guard must never kill the boot */ }
    } catch { /* first boot */ }
  }

  private saveState() {
    try {
      const dir = path.dirname(STATE_FILE());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE(), JSON.stringify({
        version: STATE_VERSION,
        config: this.cfg,
        journal: this.journal.slice(-JOURNAL_MAX),
        brain: this.brain.slice(-BRAIN_MAX),
        lessons: this.lessons.slice(-LESSON_MAX),
        memory: this.mem.slice(-MEMORY_MAX),
        edges: [...this.edges.values()],
        today: this.today,
        todayKey: this.todayKey,
        // tombstones survive reloads — a settle that raced a hot-reload must
        // never be settled twice by the next instance
        settled: [...this.settled.entries()],
        // open positions survive restarts/hot-reloads (else every reload orphans
        // them until the 4s sync re-adopts — losing entry features + AI flags,
        // and closes during the dead window were never journaled)
        positions: [...this.positions.values()].map((p) => ({ ...p })),
      }));
    } catch { /* best-effort */ }
  }

  /** today's counters — rebuilt from EPISODIC MEMORY (the phantom-proof
   *  durable source: memorize() records only real brain trades, ever), plus
   *  positions still open. The journal is NOT the source anymore: its 240-
   *  entry cap let skip-spam push this morning's opens out, silently
   *  resetting today from 9 trades/+$8.29 to 2 trades/−$0.76 on a reload
   *  (v6.2 — the "counters lie after restart" bug). */
  private recomputeToday() {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const from = dayStart.getTime();
    const todaysMem = this.mem.filter((m) => m.at >= from);
    let wins = 0, losses = 0, pnl = 0;
    for (const m of todaysMem) { pnl += m.pnl; if (m.win) wins++; else losses++; }
    // opens still live (not in memory until they settle) — brain trades only
    const openToday = [...this.positions.values()]
      .filter((p) => p.openedAt >= from && !p.adopted).length;
    const n = wins + losses;
    this.todayKey = new Date().toISOString().slice(0, 10);
    this.today = {
      trades: todaysMem.length + openToday,
      wins, losses,
      pnl: Math.round(pnl * 100) / 100,
      winPct: n ? Math.round((wins / n) * 100) : 0,
    };
  }

  /** rebuild learned edges from episodic memory (boot-time) */
  private rebuildEdgesFromMemory() {
    for (const m of this.mem) {
      const e = this.edge(m.symbol);
      e.n++;
      if (m.win) e.wins++;
      e.winRate = e.n === 1 ? (m.win ? 1 : 0) : e.winRate + EDGE_EMA_ALPHA * ((m.win ? 1 : 0) - e.winRate);
      e.consecLosses = m.win ? 0 : e.consecLosses + 1;
      e.adaptiveMin = this.computeAdaptiveMin(e);
    }
  }

  private edge(symbol: string): SymbolEdgeStat {
    let e = this.edges.get(symbol);
    if (!e) {
      e = { symbol, n: 0, wins: 0, winRate: 0.5, adaptiveMin: 1, consecLosses: 0 };
      this.edges.set(symbol, e);
    }
    return e;
  }

  /** learn: win rate above 50% → relax the gate a bit; below → demand more conviction */
  private computeAdaptiveMin(e: SymbolEdgeStat): number {
    if (e.n < 5) return 1; // not enough evidence — stay neutral
    const dev = e.winRate - 0.5;              // -0.5..+0.5
    return Math.max(ADAPT_MIN, Math.min(ADAPT_MAX, 1 + dev * 0.6));
  }

  // ── lifecycle ──
  start() {
    if (this.loopTimer) return;
    // split-brain guard: a zombie twin writing the same state file once
    // corrupted trading decisions (Sep-29 incident) — refuse to run doubled.
    if (!this.singleInstanceGuard()) return;
    this.loopTimer = setInterval(() => this.tick().catch(() => {}), LOOP_MS);
    this.syncTimer = setInterval(() => this.syncPositions().catch((e) => {
      console.error("[trader] syncPositions failed:", (e as Error)?.message ?? e);
    }), POS_SYNC_MS);
    // v16: account probe on its OWN 1s timer — decoupled from tick()'s busy
    // window so an AI-judge deliberation can never freeze the balance strip
    // (the old probe lived inside tick() behind `if (this.busy) return`).
    this.acctTimer = setInterval(() => { this.probeAccount().catch(() => {}); }, 1_000);
    this.think("ব্রেইন বুট হলো — প্রতি টিকে চিন্তা করছি, পজিশন দেখছি, শিক্ষা মনে রাখছি", "info");
    this.probeAccount().catch(() => {});
    setTimeout(() => this.syncPositions().catch((e) =>
      console.error("[trader] initial sync failed:", (e as Error)?.message ?? e)), 800);
  }
  stop() {
    this.generation++;
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.acctTimer) clearInterval(this.acctTimer);
    this.loopTimer = this.syncTimer = this.acctTimer = null;
    this.saveState();
  }
  onState(cb: (s: TraderState) => void) { this.onStateCb = cb; }
  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) return; // v11: 900→400ms — ms-level UI push
    this.lastEmit = now;
    try { this.onStateCb?.(this.state()); } catch { /* never kill the loop */ }
  }

  // ── public API (REST handlers) ──
  state(): TraderState {
    const mem = this.mem;
    const n = mem.length;
    const wins = mem.filter((m) => m.win).length;
    let accountLogin = 0;
    let serverName = "";
    try {
      const m = this.host.accountMeta();
      accountLogin = m?.login ?? 0;
      serverName = m?.server ?? "";
    } catch { /* host older than v10 */ }
    // ── v9 LIVE ACCOUNT NUMBERS: equity = balance + floating P/L, recomputed
    //    on every beat (the broker's own equity refreshes only on probe —
    //    between probes the open positions' live P/L IS the difference) ──
    const floating = [...this.positions.values()].reduce((a, p) => a + (p.pnl ?? 0), 0);
    const liveEquity = this.acct
      ? (this.positions.size
        ? Math.round((this.acct.balance + floating) * 100) / 100
        : this.acct.equity)
      : 0;
    return {
      enabled: this.cfg.enabled,
      riskMode: this.cfg.riskMode,
      riskPct: this.cfg.riskPct,
      tpUsd: this.cfg.tpUsd,
      beUsd: this.cfg.beUsd,
      beLockUsd: this.cfg.beLockUsd,
      maxDailyTrades: this.cfg.maxDailyTrades,
      accountLogin,
      serverName,
      pendingOrders: this.pendingOrders,
      recentHistory: this.recentHistory,
      lastSyncAt: this.lastSyncOkAt,
      connected: this.host.connected,
      source: this.host.source,
      noFunds: this.noFunds,
      balance: this.acct?.balance ?? 0,
      equity: liveEquity,
      sessionStartBalance: this.sessionStartBalance ?? this.acct?.balance ?? 0,
      balanceHist: this.balanceHist.slice(-60),
      floatingPnl: Math.round(floating * 100) / 100,
      currency: this.acct?.currency ?? "USD",
      haltedToday: this.haltedToday,
      haltReason: this.haltReason,
      positions: [...this.positions.values()].sort((a, b) => b.openedAt - a.openedAt),
      rules: this.cfg.symbols.map((s) => ({ ...s })),
      feelings: this.cfg.symbols.filter((s) => s.enabled).map(
        (s) => this.feelings.get(s.symbol) ?? {
          symbol: s.symbol, mood: "asleep", confidence: 0, fear: 0, greed: 0, patience: 1, bias: "none", momentum: 0,
        },
      ),
      journal: (() => {
        // v6.2 — cap skip entries to the newest 10 so opens/closes/manage/
        // errors dominate the visible window even in a veto-heavy session
        const j = this.journal.slice(-60);
        const keep: JournalEntry[] = [];
        let skips = 0;
        for (let i = j.length - 1; i >= 0; i--) {
          if (j[i].action === "skip") {
            if (skips >= 10) continue;
            skips++;
          }
          keep.unshift(j[i]);
        }
        return keep;
      })(),
      brain: this.brain.slice(-48),
      today: { ...this.today },
      memory: {
        lessons: this.lessons.slice(-14),
        edges: this.cfg.symbols.map((s) => ({ ...(this.edges.get(s.symbol) ?? this.edge(s.symbol)) })),
        tradesAnalyzed: n,
        winRate: n ? wins / n : 0,
        avgR: n ? mem.reduce((a, m) => a + m.pnlR, 0) / n : 0,
      },
      ai: {
        verdicts: this.verdicts.slice(-VERDICT_MAX),
        stats: {
          ok: this.judge.stats.ok,
          fail: this.judge.stats.fail,
          avgMs: this.judge.stats.avgMs,
          lastError: this.judge.stats.lastError,
          model: this.judge.stats.model,
        },
        exec: { lastMs: this.execLastMs, avgMs: this.execAvgMs, n: this.execN },
      },
      updatedAt: Date.now(),
    };
  }

  updateConfig(patch: Partial<TraderConfig>): TraderState {
    if (typeof patch.enabled === "boolean") {
      this.cfg.enabled = patch.enabled;
      this.think(patch.enabled
        ? "🟢 অটো-ট্রেডিং ARMED — ব্রেইন এন্ট্রি খুঁজছে"
        : "🔴 অটো-ট্রেডিং DISARMED — শুধু নজরদারি চালু", patch.enabled ? "good" : "warn");
      this.journalLog({ action: "info", symbol: "", reason: patch.enabled ? "auto-trading ARMED" : "auto-trading DISARMED" });
    }
    if (patch.riskMode && RISK[patch.riskMode]) this.cfg.riskMode = patch.riskMode;
    // v16.9 (audit E2) — OPT-IN risk-% position sizing, validated exactly like
    // tpUsd/maxDailyTrades above (v14-style range validation): clamp to
    // [0, MAX_RISK_PCT] percent with 2 decimals. 0 = legacy fixed lots — the
    // DEFAULT, so nothing changes until the user explicitly opts in.
    if (typeof patch.riskPct === "number") {
      this.cfg.riskPct = Math.max(0, Math.min(MAX_RISK_PCT, Math.round(patch.riskPct * 100) / 100));
      this.think(this.cfg.riskPct > 0
        ? `⚖️ রিস্ক-সাইজিং ${this.cfg.riskPct}% — প্রতি এন্ট্রিতে ব্যালেন্সের ${this.cfg.riskPct}% রিস্ক করে লট হিসাব হবে (SL দূরত্ব অনুযায়ী, লট-স্টেপে রাউন্ড-ডাউন)`
        : "⚖️ রিস্ক-% সাইজিং বন্ধ — প্রতি সিম্বলের ফিক্সড লটে ফিরে গেলাম", "info");
      this.journalLog({ action: "info", symbol: "", reason: `risk sizing set to ${this.cfg.riskPct}% of balance per entry (0 = fixed lots)` });
    }
    if (typeof patch.tpUsd === "number") {
      const want = Math.max(0, Math.min(50, Math.round(patch.tpUsd * 100) / 100));
      // v12 R:R-audit rule: $-mode TP must clear the spread-noise floor.
      // $0.50 on 0.01-lot gold ≈ 5 points vs a 20-40-point spread — the
      // target sits INSIDE the spread (structurally −EV). 0 switches to
      // R-multiple mode; anything else must be ≥ MIN_TP_USD ($3).
      if (want > 0 && want < MIN_TP_USD) {
        throw new Error(`$-target must be 0 (R-mode) or at least $${MIN_TP_USD} — smaller targets sit inside the spread (0.01-lot gold ≈ $${MIN_TP_USD}+ to clear spread+SL math)`);
      }
      this.cfg.tpUsd = want;
      this.think(this.cfg.tpUsd > 0
        ? `🎯 টার্গেট-প্রফিট $${this.cfg.tpUsd.toFixed(2)} — এই লাভে পৌঁছালেই ট্রেড বন্ধ করে প্রফিট নেব`
        : "টার্গেট-প্রফিট $-মোড বন্ধ — R-মাল্টিপল মোডে ফিরে গেলাম", "info");
      this.journalLog({ action: "info", symbol: "", reason: `tp target set to $${this.cfg.tpUsd.toFixed(2)}` });
    }
    // v9: breakeven trigger — the user's profit-protection rule
    if (typeof patch.beUsd === "number") {
      this.cfg.beUsd = Math.max(0, Math.min(1000, Math.round(patch.beUsd * 100) / 100));
      this.think(this.cfg.beUsd > 0
        ? `🛡️ ব্রেকইভেন ট্রিগার $${this.cfg.beUsd.toFixed(2)} — এই প্রফিটে পৌঁছালেই SL এন্ট্রি-দামের একটু উপরে চলে যাবে`
        : "🛡️ ব্রেকইভেন ট্রিগার AUTO — টার্গেটের ৬০% প্রফিটে SL এন্ট্রিতে নামবে", "info");
      this.journalLog({ action: "info", symbol: "", reason: `breakeven trigger set to ${this.cfg.beUsd > 0 ? `$${this.cfg.beUsd.toFixed(2)}` : "auto (60% of target)"}` });
    }
    if (typeof patch.beLockUsd === "number") {
      this.cfg.beLockUsd = Math.max(0, Math.min(100, Math.round(patch.beLockUsd * 100) / 100));
    }
    if (typeof patch.dailyLossLimitPct === "number")
      this.cfg.dailyLossLimitPct = Math.max(1, Math.min(50, patch.dailyLossLimitPct));
    if (typeof patch.maxDailyTrades === "number") {
      // v14: NO unlimited mode — the audit flagged "0 = unlimited" as a
      // misconfiguration trap. 0 / invalid now resets to the safe default
      // (12); the real range is [1, MAX_DAILY_TRADES_CAP].
      const rawDaily = Math.round(patch.maxDailyTrades);
      this.cfg.maxDailyTrades = Math.max(1, Math.min(MAX_DAILY_TRADES_CAP, rawDaily >= 1 ? rawDaily : 12));
      this.think(`📅 দৈনিক ট্রেড লিমিট ${this.cfg.maxDailyTrades} — এটাই আজকের সর্বোচ্চ`, "info");
      this.journalLog({ action: "info", symbol: "", reason: `daily trade cap set to ${this.cfg.maxDailyTrades}` });
      // the user raising the cap is an explicit wish to resume
      if (this.haltedToday && this.haltReason.startsWith("max daily trades")
        && this.today.trades < this.cfg.maxDailyTrades) {
        this.haltedToday = false;
        this.haltReason = "";
        this.think("▶️ ট্রেড লিমিট বাড়ানো হলো — আবার এন্ট্রি চালু", "info");
      }
    }
    if (Array.isArray(patch.symbols)) {
      this.cfg.symbols = patch.symbols
        .filter((s) => s && typeof s.symbol === "string" && s.symbol.length <= 20)
        .map((s) => ({
          symbol: s.symbol,
          enabled: !!s.enabled,
          // v12: hard caps — 100-lot / 500-position inputs are now impossible
          // v16.4 (audit §7): snap to the 0.01 lot STEP too — 0.015 used to
          // pass the min/max clamp and die at the broker as retcode 10014
          // (invalid volume); it never trades now.
          lots: Math.max(0.01, Math.min(MAX_LOT, Math.round((Number(s.lots) || 0.01) * 100) / 100)),
          maxPositions: Math.max(1, Math.min(MAX_POSITIONS_PER_SYMBOL, Math.round(Number(s.maxPositions) || 1))),
        }));
      for (const s of this.cfg.symbols) this.tracker(s.symbol);
    }
    this.saveState();
    this.emit(true);
    return this.state();
  }

  async manualClose(ticket: number): Promise<{ ok: boolean; error?: string }> {
    const p = this.positions.get(ticket);
    if (!p) return { ok: false, error: "position not found" };
    return this.closeManaged(p, "manual close (user)", "MANUAL");
  }

  /** v9 breakeven trigger — explicit $beUsd, or AUTO (60% of the $ target;
   *  0 in pure R-mode → the R-based breakevenR path runs instead) */
  private beTriggerUsd(): number {
    if (this.cfg.beUsd > 0) return this.cfg.beUsd;
    return this.cfg.tpUsd > 0 ? this.cfg.tpUsd * 0.6 : 0;
  }

  /** v9 — move SL to entry (+ beLockUsd lock): the user's “প্রফিট হলে SL আসল
   *  দামে বসাও, বা একটু উপরে” rule. Works for brain AND adopted (manual)
   *  positions — capital protection is universal. Only ever tightens. */
  private async moveBe(
    p: TraderPosition,
    q?: { bid: number; ask: number; mid: number } | null,
  ): Promise<boolean> {
    const quote = q ?? this.host.getQuote(p.symbol);
    if (!quote) return false;
    const digits = this.host.digits(p.symbol);
    const dirMult = p.side === "buy" ? 1 : -1;
    const cm = this.cmOf(p.symbol, p.entry);
    const tick = Math.pow(10, -digits);
    const lockDist = Math.max(this.cfg.beLockUsd / Math.max(p.lots * cm, 1e-9), tick);
    const be = Number((p.entry + dirMult * lockDist).toFixed(digits + 1));
    // side sanity — an SL on the wrong side of the market is a guaranteed
    // 10016; say it cleanly instead (BE only works on a winning trade)
    if (p.side === "buy" && be >= quote.bid) {
      this.journalLog({ action: "error", symbol: p.symbol, reason: `breakeven rejected: SL ${be.toFixed(digits)} must be below bid ${quote.bid.toFixed(digits)} (trade not in profit yet)` });
      return false;
    }
    if (p.side === "sell" && be <= quote.ask) {
      this.journalLog({ action: "error", symbol: p.symbol, reason: `breakeven rejected: SL ${be.toFixed(digits)} must be above ask ${quote.ask.toFixed(digits)} (trade not in profit yet)` });
      return false;
    }
    // already at/beyond breakeven? nothing to move — just mark it
    if (p.sl > 0 && (dirMult > 0 ? p.sl >= be : p.sl <= be)) {
      p.beMoved = true;
      return true;
    }
    try {
      const r = await this.host.modifyPosition(p.symbol, p.side, p.lots, quote.mid, p.ticket,
        be, p.tp, { digits });
      if (r.retcode === 10009) {
        p.beMoved = true;
        p.sl = be;
        this.journalLog({
          action: "manage", symbol: p.symbol,
          reason: `SL → breakeven ${be.toFixed(digits)} (locks +$${this.cfg.beLockUsd.toFixed(2)}${p.adopted ? ", manual position protected" : ""})`,
        });
        this.think(`${p.symbol}: SL এন্ট্রি-দামের একটু উপরে (${be.toFixed(digits)}) — এই ট্রেড এখন রিস্ক-ফ্রি 🛡️`, "good");
        this.emit(true);
        return true;
      }
      if (r.retcode === 10036) {
        // ── v11: the position is GONE at the broker (closed on MT5 while we
        //    held a stale copy — the "breakeven move rejected: 10036" spam).
        //    Don't retry forever: reconcile against the deal history NOW. ──
        this.journalLog({ action: "info", symbol: p.symbol, reason: `position #${p.ticket} not found at broker during BE move — verifying with deal history` });
        this.reconcileMissing(p, "be-10036", true).catch(() => {});
        return false;
      }
      this.journalLog({ action: "error", symbol: p.symbol, reason: `breakeven move rejected: ${r.retcode} ${r.comment}` });
      return false;
    } catch (e) {
      this.journalLog({ action: "error", symbol: p.symbol, reason: `breakeven move threw: ${(e as Error).message}` });
      return false;
    }
  }

  /** v9 — user-driven SL/TP edit from the app (brain AND adopted positions):
   *    the “চাইলে স্টপ লস ও প্রফিট টার্গেট কাস্টমাইজ করতে পারবে” rule.
   *    be:true = one-click SL→entry(+lock). */
  async manualModify(
    ticket: number,
    opts: { sl?: number; tp?: number; be?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    const p = this.positions.get(ticket);
    if (!p) return { ok: false, error: "position not found" };
    if (opts.be === true) {
      const ok = await this.moveBe(p);
      return ok ? { ok: true } : { ok: false, error: "broker rejected the SL move" };
    }
    const q = this.host.getQuote(p.symbol);
    if (!q) return { ok: false, error: "no live quote for this symbol" };
    const digits = this.host.digits(p.symbol);
    const wantsSl = opts.sl !== undefined && Number.isFinite(opts.sl) && (opts.sl as number) > 0;
    const wantsTp = opts.tp !== undefined && Number.isFinite(opts.tp) && (opts.tp as number) > 0;
    if (!wantsSl && !wantsTp) return { ok: false, error: "nothing to set" };
    const sl = wantsSl ? (opts.sl as number) : p.sl;
    const tp = wantsTp ? (opts.tp as number) : p.tp;
    // side sanity — MT5 rejects wrong-side stops; tell the user WHY in their terms
    if (wantsSl) {
      if (p.side === "buy" && sl >= q.bid) return { ok: false, error: `SL must be below bid ${q.bid}` };
      if (p.side === "sell" && sl <= q.ask) return { ok: false, error: `SL must be above ask ${q.ask}` };
    }
    if (wantsTp) {
      if (p.side === "buy" && tp <= q.ask) return { ok: false, error: `TP must be above ask ${q.ask}` };
      if (p.side === "sell" && tp >= q.bid) return { ok: false, error: `TP must be below bid ${q.bid}` };
    }
    try {
      const r = await this.host.modifyPosition(p.symbol, p.side, p.lots, q.mid, ticket,
        Number(sl.toFixed(digits + 1)), Number(tp.toFixed(digits + 1)), { digits });
      if (r.retcode === 10009) {
        if (wantsSl) {
          p.sl = sl;
          p.beMoved = p.side === "buy" ? p.sl >= p.entry : p.sl <= p.entry;
        }
        if (wantsTp) p.tp = tp;
        const bits = [
          wantsSl && `SL ${sl.toFixed(digits)}`,
          wantsTp && `TP ${tp.toFixed(digits)}`,
        ].filter(Boolean).join(" · ");
        this.journalLog({
          action: "manage", symbol: p.symbol, side: p.side,
          reason: `user set ${bits}${p.adopted ? " (manual position)" : ""}`,
        });
        this.think(`${p.symbol}: ইউজার ${bits} সেট করলো — মেনে নিয়ে সেভাবেই চলব`, "info");
        this.emit(true);
        return { ok: true };
      }
      this.journalLog({ action: "error", symbol: p.symbol, reason: `SL/TP modify rejected: ${r.retcode} ${r.comment}` });
      return { ok: false, error: `${r.retcode} ${r.comment}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** v11 — user opens a MARKET order from the app (app→MT5 direction, the
   *  "উভয় দিক রিয়েল-টাইম" rule). The brain ADOPTS it on the next sync —
   *  full copilot treatment (watched + BE-protected, never strategy-closed). */
  async manualMarketOrder(
    symbol: string, side: "buy" | "sell", lots: number,
    opts: { sl?: number; tp?: number } = {},
  ): Promise<{ ok: boolean; ticket?: number; error?: string }> {
    try {
      const digits = this.host.digits(symbol);
      const q = this.host.getQuote(symbol);
      if (!q) return { ok: false, error: `no live quote for ${symbol}` };
      const price = side === "buy" ? q.ask : q.bid;
      const r = await this.host.marketOrderAt(symbol, side, lots, price, {
        sl: opts.sl ?? 0, tp: opts.tp ?? 0, digits, comment: "app-manual",
      });
      if (r.retcode !== 10009) {
        this.journalLog({ action: "error", symbol, reason: `manual order rejected: ${r.retcode} ${r.comment}` });
        return { ok: false, error: `${r.retcode} ${r.comment}` };
      }
      // v16.2: register the position DIRECTLY from the trade result (same
      // as the brain's open path). The old code relied on sync adoption —
      // but cmd-4 on an established session is a login-time snapshot
      // (VERIFIED LIVE), so a manual app order could go UNTRACKED (no SL
      // management, invisible in the UI) until a session recycle.
      const entry = r.price || price;
      const pos: TraderPosition = {
        ticket: r.order, symbol, side, lots,
        lots0: lots,
        entry, sl: opts.sl ?? 0, tp: opts.tp ?? 0, openedAt: Date.now(),
        reason: "user order from app", price: entry, pnl: 0, pnlR: 0,
        slDist: opts.sl && opts.sl > 0 ? Math.abs(entry - opts.sl) : 0,
        peakR: 0, beMoved: false, partialDone: false, adopted: true, origin: "manual", bankedPnl: 0,
      };
      this.positions.set(pos.ticket, pos);
      this.nextReviewAt.set(pos.ticket, Date.now() + REVIEW_FIRST_MS);
      this.aiCloseVotes.set(pos.ticket, 0);
      this.journalLog({
        action: "open", symbol, side,
        reason: `user order from app · ${side.toUpperCase()} ${lots} @ ${r.price || price}${opts.sl ? ` · SL ${opts.sl}` : ""}${opts.tp ? ` · TP ${opts.tp}` : ""}`,
      });
      this.think(`👤 ইউজার অ্যাপ থেকে ${symbol} ${side.toUpperCase()} ${lots} খুললো — কপাইলট নজরদারি শুরু`, "info");
      this.emit(true);
      return { ok: true, ticket: r.order };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** v11 — place a PENDING order (limit/stop) from the app. */
  async placePending(
    symbol: string, orderType: 2 | 3 | 4 | 5, lots: number, price: number,
    opts: { sl?: number; tp?: number } = {},
  ): Promise<{ ok: boolean; ticket?: number; error?: string }> {
    try {
      const digits = this.host.digits(symbol);
      const r = await this.host.pendingOrder(symbol, orderType, lots, price, {
        sl: opts.sl ?? 0, tp: opts.tp ?? 0, digits, comment: "app-pending",
      });
      if (r.retcode !== 10009) {
        this.journalLog({ action: "error", symbol, reason: `pending order rejected: ${r.retcode} ${r.comment}` });
        return { ok: false, error: `${r.retcode} ${r.comment}` };
      }
      const name = ORDER_TYPE_NAMES[orderType] ?? `type ${orderType}`;
      this.journalLog({ action: "info", symbol, reason: `user pending order · ${name} ${lots} @ ${price}` });
      this.think(`👤 ইউজার পেন্ডিং অর্ডার দিলো — ${symbol} ${name} ${lots} @ ${price}`, "info");
      this.emit(true);
      return { ok: true, ticket: r.order };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** v11 — cancel a pending order from the app (needs the original type+price
   *  for the protocol; taken from the live pending mirror). */
  async cancelPending(ticket: number): Promise<{ ok: boolean; error?: string }> {
    const o = this.pendingOrders.find((x) => x.ticket === ticket);
    if (!o) return { ok: false, error: `pending order #${ticket} not found (refresh and try again)` };
    try {
      const r = await this.host.cancelOrder(o.symbol, o.orderType, o.lots, o.price, ticket, {
        digits: this.host.digits(o.symbol),
      });
      if (r.retcode !== 10009) {
        this.journalLog({ action: "error", symbol: o.symbol, reason: `cancel pending rejected: ${r.retcode} ${r.comment}` });
        return { ok: false, error: `${r.retcode} ${r.comment}` };
      }
      this.journalLog({ action: "info", symbol: o.symbol, reason: `user canceled pending #${ticket} (${o.orderTypeName} @ ${o.price})` });
      this.emit(true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async closeAll(): Promise<{ closed: number }> {
    let closed = 0;
    for (const p of [...this.positions.values()]) {
      const r = await this.closeManaged(p, "close-all (user)", "MANUAL");
      if (r.ok) closed++;
    }
    return { closed };
  }

  // ── inner plumbing ──
  private tracker(symbol: string): FlowTracker | null {
    try {
      let tr = this.trackers.get(symbol);
      if (!tr) {
        tr = this.host.getOrCreateTracker(symbol, "M1");
        this.trackers.set(symbol, tr);
      }
      return tr;
    } catch { return null; }
  }

  /** cached structural read (M15 S/R + trend + value area) — the brain's
   *  candlestick-chart view. Pre-warmed every 30s so decide() never waits
   *  on a candle fetch (speed: the entry decision must be tick-fast). */
  private async marketReadCached(symbol: string, force = false): Promise<MarketRead | null> {
    const hit = this.mrCache.get(symbol);
    if (!force && hit && Date.now() - hit.at < MR_CACHE_MS) return hit.mr;
    const mr = await this.host.marketRead(symbol, "M15", 200);
    this.mrCache.set(symbol, { at: Date.now(), mr });
    return mr;
  }

  /** only one trader may own the state file at a time */
  private singleInstanceGuard(): boolean {
    try {
      const lockFile = STATE_FILE() + ".lock";
      const myPid = process.pid;
      if (fs.existsSync(lockFile)) {
        const prev = Number(fs.readFileSync(lockFile, "utf8").trim());
        if (prev && prev !== myPid) {
          try {
            process.kill(prev, 0); // throws if dead
            console.error(`[trader] SPLIT-BRAIN GUARD: pid ${prev} already owns the trader state — this instance stays passive`);
            return false;
          } catch { /* previous owner is dead — take over */ }
        }
      }
      fs.writeFileSync(lockFile, String(myPid));
      return true;
    } catch { return true; }
  }

  private think(text: string, tone: BrainThought["tone"] = "info") {
    this.brain.push({ at: Date.now(), text, tone });
    if (this.brain.length > BRAIN_MAX) this.brain.shift();
  }

  private journalLog(e: Omit<JournalEntry, "id" | "at">) {
    this.journal.push({ id: this.journalId++, at: Date.now(), ...e });
    if (this.journal.length > JOURNAL_MAX) this.journal.shift();
    this.saveState();
  }

  private lesson(symbol: string, text: string, tone: TraderLesson["tone"]) {
    this.lessons.push({ at: Date.now(), symbol, text, tone });
    if (this.lessons.length > LESSON_MAX) this.lessons.shift();
  }

  private rollDay(equity: number) {
    const key = new Date().toISOString().slice(0, 10);
    if (key === this.todayKey) return;
    this.todayKey = key;
    this.recomputeToday();
    this.dayStartEquity = equity > 0 ? equity : null;
    this.haltedToday = false;
    this.haltReason = "";
    this.think(`নতুন দিন — কাউন্টার রিসেট (equity রেফ ${equity.toFixed(2)})`, "info");
  }

  private async probeAccount() {
    try {
      const a = await this.host.account();
      if (a) {
        // Exness sometimes reports equity=0 on this protocol — fall back to balance
        const equity = a.equity > 0 ? a.equity : a.balance;
        const prevBalance = this.acct?.balance;
        this.acct = { balance: a.balance, equity, currency: a.currency };
        // ── v9 ACCOUNT FOLLOW-UP: session baseline + balance trend history.
        //    Every balance CHANGE is recorded (sparkline feed) — and a move
        //    with no brain settle in the last 8s is EXTERNAL activity (a
        //    manual MT5 close or a deposit) which the app follows out loud. ──
        if (this.sessionStartBalance == null && a.balance > 0) {
          this.sessionStartBalance = a.balance;
          this.balanceHist.push({ at: Date.now(), balance: a.balance });
        } else if (prevBalance != null && Math.abs(a.balance - prevBalance) > 0.005) {
          this.balanceHist.push({ at: Date.now(), balance: a.balance });
          if (this.balanceHist.length > 240) this.balanceHist.shift();
          const delta = a.balance - prevBalance;
          if (Date.now() - this.lastSettleAt > 8000 && Date.now() - this.lastExternalBalNote > 30_000) {
            this.lastExternalBalNote = Date.now();
            this.journalLog({
              action: "info", symbol: "",
              reason: `account balance ${prevBalance.toFixed(2)} → ${a.balance.toFixed(2)} (${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toFixed(2)}) — external activity (manual trade close or deposit)`,
            });
            this.think(`💰 ব্যালেন্স বদলেছে ${prevBalance.toFixed(2)} → ${a.balance.toFixed(2)} (${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toFixed(2)}) — MT5-এ বাইরে কিছু হয়েছে, ফলো করছি`, "info");
          }
          // v16: a balance MOVE pushes to the UI immediately — the strip must
          // not wait for the next 400ms-throttled beat
          this.emit(true);
        }
        this.rollDay(equity);
        if (a.balance <= 2) {
          if (!this.noFunds) {
            this.noFunds = true;
            this.think("⚠️ অ্যাকাউন্টে ব্যালেন্স নেই — এন্ট্রি বন্ধ, নজরদারি চালু", "warn");
          }
        } else if (this.noFunds) {
          this.noFunds = false;
          this.think("💰 ব্যালেন্স ফিরেছে — এন্ট্রি আবার সক্রিয়", "good");
        }
      }
    } catch { /* not connected yet */ }
  }

  /** the main heartbeat — perception → decisions → monitoring → broadcast */
  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // v16: the account probe moved to its OWN timer (start()) — the old
      // in-tick probe meant a 4.5s AI-judge deliberation froze the balance.
      // pre-warm the structural reads for every enabled symbol (decide()
      // then answers in tick-time, not fetch-time — the user's speed demand)
      if (Date.now() - this.lastMrWarm > 30_000) {
        this.lastMrWarm = Date.now();
        for (const r of this.cfg.symbols) {
          if (r.enabled) {
            this.marketReadCached(r.symbol, true).catch(() => {});
            this.mtfHigh(r.symbol).catch(() => {}); // v6: 30m/1H bias warm
          }
        }
      }
      this.perceive();
      if (this.cfg.enabled && this.host.connected && this.host.source === "mt5") {
        await this.decide();
      }
      await this.monitor(); // always watch open positions, even when disarmed
      this.checkDailyLimits();
      this.emit();
    } finally {
      this.busy = false;
    }
  }

  // ── PERCEPTION: feelings from the flow tape (every beat, tick-level) ──
  private perceive() {
    for (const rule of this.cfg.symbols) {
      if (!rule.enabled) continue;
      const tr = this.tracker(rule.symbol);
      if (!tr) continue;
      let fp: FlowPayload;
      try { fp = tr.payload(Date.now()); } catch { continue; }

      const sig = fp.sig;
      const conf = Math.min(1, Math.abs(sig.raw));           // smoothed bias
      const strength = sig.state !== "neutral" ? sig.strength : conf * 0.7;
      // fear: range expansion against us + wicks + adverse speed
      // (v6.2 recalibrated: the old ×1.6 wick weight pinned fear at 1.0
      //  permanently on indices/oil — "fearful" stopped meaning anything)
      const range = fp.h - fp.l || 1e-9;
      const wickTop = fp.h - Math.max(fp.o, fp.c);
      const wickBot = Math.min(fp.o, fp.c) - fp.l;
      const wickDanger = Math.max(wickTop, wickBot) / range;
      const fear = Math.min(1, wickDanger * 1.05 + Math.max(0, (fp.tpsAvg - fp.tps) / Math.max(fp.tpsAvg, 0.8)) * 0.45);
      // greed: strong one-sided delta on an extended candle (FOMO)
      const extension = Math.abs(fp.c - fp.o) / range;
      const greed = Math.min(1, Math.abs(fp.deltaPct) * 0.6 + extension * 0.5);
      // patience: quiet tape or balanced flow → wait
      const quiet = fp.tps < 1.5;
      const balanced = Math.abs(fp.deltaPct) < 0.15;
      const patience = Math.min(1, (quiet ? 0.7 : 0) + (balanced ? 0.3 : 0) + (sig.state === "neutral" ? 0.2 : 0));
      // tick momentum (last ~20s of the tape) — v6.2 HONEST SCALE: the old
      // formula used (last−first)/span as "direction", which is ALWAYS ±1
      // whenever the 20s net move was non-zero — momentum was pinned at
      // ±0.6+ all day, every 20s window raised a "candidate" and the gates
      // downstream drowned in noise (the user's "signal আসে না/ভুল হয়"
      // complaint). Now the net move is measured RELATIVE TO THE FULL 20s
      // TICK RANGE: a decisive one-sided push that closes at its extreme
      // scores high; a choppy drift that went nowhere scores near zero.
      const ticks = this.host.getTicks(rule.symbol, 20);
      let momentum = 0;
      if (ticks.length >= 4) {
        const first = ticks[0].p, last = ticks[ticks.length - 1].p;
        let hi = -Infinity, lo = Infinity;
        for (const tk of ticks) { if (tk.p > hi) hi = tk.p; if (tk.p < lo) lo = tk.p; }
        const tickRange = hi - lo || 1e-9;
        const netFrac = Math.max(-1, Math.min(1, (last - first) / tickRange)); // −1..1 move vs range
        const closePos = (last - lo) / tickRange;                              // 0..1 close within range
        let ups = 0;
        for (let i = 1; i < ticks.length; i++) if (ticks[i].p > ticks[i - 1].p) ups++;
        const upFrac = ups / (ticks.length - 1);
        momentum = Math.max(-1, Math.min(1,
          netFrac * 0.5 + (closePos - 0.5) * 0.55 + (upFrac - 0.5) * 0.6,
        ));
      }

      let mood: AiFeel["mood"];
      // v6.2: mood priority fixed — a scary tape is "fearful" even when slow
      // (the old "asleep" could sit on fear=1.0, which read as nonsense)
      if (fear >= 0.66) mood = "fearful";
      else if (quiet) mood = "asleep";
      else if (greed > 0.66 && strength > 0.5) mood = "greedy";
      else if (strength > 0.55 && fear < 0.4 && Math.abs(momentum) > 0.3) mood = "excited";
      else if (balanced) mood = "calm";
      else mood = "nervous";

      this.feelings.set(rule.symbol, {
        symbol: rule.symbol,
        mood,
        confidence: Math.round(strength * 100) / 100,
        fear: Math.round(fear * 100) / 100,
        greed: Math.round(greed * 100) / 100,
        patience: Math.round(patience * 100) / 100,
        bias: sig.state === "buy" ? "buy" : sig.state === "sell" ? "sell" : "none",
        momentum: Math.round(momentum * 100) / 100,
      });

      // ── INSTANT transition thoughts (tick-level awareness, no 60s wait) ──
      const prev = this.prevLamp.get(rule.symbol) ?? "neutral";
      if (prev !== sig.state) {
        this.prevLamp.set(rule.symbol, sig.state);
        if (sig.state === "buy" || sig.state === "sell") {
          this.think(
            `${rule.symbol}: 🎯 ল্যাম্প ${sig.state === "buy" ? "🟢 BUY" : "🔴 SELL"} জ্বললো — কনভিকশন ${(sig.strength * 100) | 0}%, মোমেন্টাম ${momentum >= 0 ? "+" : ""}${(momentum * 100) | 0}%`,
            sig.state === "buy" ? "good" : "warn",
          );
        } else if (prev !== "neutral" && !quiet) {
          this.think(`${rule.symbol}: ল্যাম্প নিভলো — ফ্লো মিশে গেছে, অপেক্ষা`, "info");
        }
      }
    }
  }

  /** M1 working-memory snapshot computed from ONE candle fetch — ATR + EMA
   *  trend + extension + the last-3-candle extremes (structure SL material). */
  private snapshotFrom(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]): {
    atr: number; ema: number; price: number; trendUp: boolean | null; extAtr: number;
    lo3: number; hi3: number;
  } | null {
    if (!bars || bars.length < 10) return null;
    // ATR(14) — v16.8 (user audit): WILDER smoothing (α = 1/n), identical to
    // lib/market/indicators.atr and every chart ATR. The old simple mean of
    // the last 14 TRs ran hotter than Wilder right after vol spikes and
    // silently disagreed with the whole stack (trader-sized SL ≠ chart SL).
    const trs: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    }
    let atr: number;
    if (trs.length >= 14) {
      let prev = 0;
      for (let i = 0; i < 14; i++) prev += trs[i];
      prev /= 14;
      for (let i = 14; i < trs.length; i++) prev = (prev * 13 + trs[i]) / 14;
      atr = prev;
    } else {
      atr = trs.reduce((a, b) => a + b, 0) / Math.max(1, trs.length);
    }
    // EMA(20) of closes
    const closes = bars.map((b) => b.c);
    const k = 2 / (20 + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    const price = closes[closes.length - 1];
    const last3 = bars.slice(-3);
    return {
      atr, ema, price,
      trendUp: atr > 0 ? price > ema : null,
      extAtr: atr > 0 ? Math.abs(price - ema) / atr : 0,
      lo3: Math.min(...last3.map((b) => b.l)),
      hi3: Math.max(...last3.map((b) => b.h)),
    };
  }

  /** v16.8: Wilder ATR(14) over a candle array (null when too short) —
   *  the M15 volatility basis for SL sizing. */
  private wilderAtrOf(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]): number | null {
    if (!bars || bars.length < 15) return null;
    const trs: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    }
    let prev = 0;
    for (let i = 0; i < 14; i++) prev += trs[i];
    prev /= 14;
    for (let i = 14; i < trs.length; i++) prev = (prev * 13 + trs[i]) / 14;
    return prev > 0 ? prev : null;
  }

  // ── MTF CONSENSUS (v6) — the user's multi-timeframe read: 1m/2m/3m must
  //    not fight the entry, 5m/10m/15m may not STRONGLY oppose, 30m/1H veto
  //    only real opposition. 2m..15m are aggregated from the fresh M1 fetch
  //    (one call — MT5 has no M2/M3/M10 codes); 30m/1H come from a warm
  //    2-minute cache. Every frame's bias = LR slope (in ATR) + last-candle
  //    lean as the tiebreak — exactly how the user eyeballs a chart. ──
  private mtfBiasFromM1(
    m1: { t: number; c: number }[],
    multMin: number,
    atr1: number,
  ): { dir: number; slopeAtr: number } {
    const sec = multMin * 60;
    const agg = new Map<number, number>(); // bucket → last close in bucket
    for (const b of m1) agg.set(Math.floor(b.t / sec), b.c);
    const closes = [...agg.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).slice(-10);
    if (closes.length < 3) return { dir: 0, slopeAtr: 0 };
    const n = closes.length;
    const meanX = (n - 1) / 2, meanY = closes.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (closes[i] - meanY); den += (i - meanX) ** 2; }
    // ATR scales ~√time on a random walk — good enough for a slope yardstick
    const scale = atr1 > 0 ? atr1 * Math.sqrt(multMin) : 0;
    const slopeAtr = scale > 0 && den > 0 ? (num / den) / scale : 0;
    let dir = 0;
    if (slopeAtr > 0.05) dir = 1;
    else if (slopeAtr < -0.05) dir = -1;
    else if (closes[n - 1] > closes[n - 2]) dir = 1;   // flat slope → last candle lean
    else if (closes[n - 1] < closes[n - 2]) dir = -1;
    return { dir, slopeAtr };
  }

  /** 30m/1H bias — cached 2 min (pre-warmed; decide() reads it warm) */
  private async mtfHigh(symbol: string): Promise<{
    m30: { dir: number; slopeAtr: number } | null;
    h1: { dir: number; slopeAtr: number } | null;
  }> {
    const hit = this.mtfHighCache.get(symbol);
    if (hit && Date.now() - hit.at < MTF_HIGH_TTL) return hit;
    const biasOf = async (tf: string, n: number) => {
      try {
        const bars = await this.host.getCandles(symbol, tf, n);
        if (bars.length < 4) return null;
        const closes = bars.map((b) => b.c).slice(-10);
        if (closes.length < 3) return null;
        let atr = 0;
        const trs: number[] = [];
        for (let i = 1; i < bars.length; i++) {
          trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
        }
        atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
        const k = closes.length;
        const meanX = (k - 1) / 2, meanY = closes.reduce((a, b) => a + b, 0) / k;
        let num = 0, den = 0;
        for (let i = 0; i < k; i++) { num += (i - meanX) * (closes[i] - meanY); den += (i - meanX) ** 2; }
        const slope = den ? num / den : 0;
        const slopeAtr = atr > 0 ? slope / atr : 0;
        let dir = 0;
        if (slopeAtr > 0.05) dir = 1;
        else if (slopeAtr < -0.05) dir = -1;
        else if (closes[k - 1] > closes[k - 2]) dir = 1;
        else if (closes[k - 1] < closes[k - 2]) dir = -1;
        return { dir, slopeAtr };
      } catch { return null; }
    };
    const [m30, h1] = await Promise.all([biasOf("M30", 40), biasOf("H1", 30)]);
    const entry = { at: Date.now(), m30, h1 };
    this.mtfHighCache.set(symbol, entry);
    return entry;
  }

  /** the full 8-frame consensus for one entry side */
  private async mtfConsensus(
    symbol: string,
    m1: { t: number; o: number; h: number; l: number; c: number; v: number }[],
    side: "buy" | "sell",
    atr1: number,
  ): Promise<{ ok: boolean; agree: number; total: number; note: string }> {
    const withSign = side === "buy" ? 1 : -1;
    const frames = [1, 2, 3, 5, 10, 15]; // minutes, aggregated from M1
    const lows: { dir: number; slopeAtr: number }[] = [];
    const mids: { dir: number; slopeAtr: number }[] = [];
    const dirs: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const b = this.mtfBiasFromM1(m1, frames[i], atr1);
      dirs.push(b.dir);
      if (i < 3) lows.push(b); else mids.push(b);
    }
    const high = await this.mtfHigh(symbol);
    if (high.m30) dirs.push(high.m30.dir);
    if (high.h1) dirs.push(high.h1.dir);
    const total = 8;
    const agree = dirs.filter((d) => d === withSign).length;
    // LOW (1m/2m/3m): the scalp engine — one may lean against only when
    // another leans with us ("1m says up → verify with 2m/3m")
    const lowAgainst = lows.filter((b) => b.dir === -withSign).length;
    const lowWith = lows.filter((b) => b.dir === withSign).length;
    const lowOk = lowAgainst === 0 || (lowAgainst === 1 && lowWith >= 1);
    // MID (5m/10m/15m): no STRONG opposition (|slope| ≥ 0.25 ATR/bar against)
    const midOk = mids.every((b) => !(b.dir === -withSign && Math.abs(b.slopeAtr) >= 0.25));
    // HIGH (30m/1H): no real opposition (|slope| ≥ 0.15 ATR/bar against)
    const hiOk = [high.m30, high.h1].every((b) => !b || !(b.dir === -withSign && Math.abs(b.slopeAtr) >= 0.15));
    const ok = lowOk && midOk && hiOk;
    const note = ok
      ? `${agree}/${total} aligned`
      : [
          !lowOk && "1m/2m/3m বিপক্ষে",
          !midOk && "5m/10m/15m শক্ত-বিপক্ষে",
          !hiOk && "30m/1H বিপক্ষে",
        ].filter(Boolean).join(" + ") || `${agree}/${total}`;
    return { ok, agree, total, note };
  }

  // ── DECISION: lamp candidate → REAL AI (LLM) JUDGE → entry ──────────────
  // The fast brain raises a candidate at a LOW bar; the real model (GLM via
  // z-ai-web-dev-sdk — free, keyless, server-side) looks at the SAME picture
  // the chart draws (S/R, POC/VAH/VAL, trend, tape, spread, its own lessons)
  // and confirms or vetoes. If the model is unreachable the deterministic
  // confluence rules decide alone — trading never stalls.
  private async decide() {
    if (this.noFunds || this.haltedToday) return;
    const prof = RISK[this.cfg.riskMode];
    const gen = this.generation; // a dying brain (hot-reload) must never place orders

    // global safety cap
    if (this.positions.size >= GLOBAL_MAX_POSITIONS) return;

    for (const rule of this.cfg.symbols) {
      if (!rule.enabled) continue;
      const openForSymbol = [...this.positions.values()].filter((p) => p.symbol === rule.symbol).length;
      if (openForSymbol >= rule.maxPositions) continue;

      const tr = this.tracker(rule.symbol);
      if (!tr) continue;
      let fp: FlowPayload;
      try { fp = tr.payload(Date.now()); } catch { continue; }
      const sig = fp.sig;

      const edge = this.edge(rule.symbol);
      const prio = PRIORITY_SYMBOLS.has(rule.symbol);

      // ══ v14 SESSION GATE — TRUE UTC (was: brokerNowSec = SERVER-LOCAL
      //    hours, so the "UTC 7–20" comment lied; the window ended 20h and
      //    Friday closed at 21h *server* — cutting the last NY hours the
      //    audit flagged. New window: London+NY = 07:00–24:00 UTC Mon–Fri
      //    PLUS Sat 00:00–01:00 UTC (Friday's late-NY tail — gold trades
      //    until ≈ Sat 01:00 UTC). Manual user orders are NOT affected. ══
      const g = new Date();               // machine clock = UTC (Railway/NTP)
      const h = g.getUTCHours();
      const dow = g.getUTCDay();          // 0=Sun … 6=Sat
      const inWindow = (dow >= 1 && dow <= 5 && h >= 7) || (dow === 6 && h < 1);
      if (!inWindow) {
        const why = (dow === 6 || dow === 0)
          ? "weekend (market closed)"
          : `outside London+NY window (UTC ${h}h, window 7–24 + Fri tail to Sat 01:00)`;
        // v14: session skips go through the SAME v6.2 throttle as every
        // other veto (≥90s per symbol OR category change). Before, this
        // branch journaled EVERY decide() pass (~1.2s per symbol) and
        // drowned the 240-entry journal cap inside ~5 minutes — the
        // audit's "real opens/closes evicted" + "narration sees only SKIP".
        const prevSkip = this.lastSkipLogAt.get(rule.symbol);
        if (!prevSkip || Date.now() - prevSkip.at >= 90_000 || prevSkip.cat !== "session") {
          this.lastSkipLogAt.set(rule.symbol, { at: Date.now(), cat: "session" });
          this.journalLog({ action: "skip", symbol: rule.symbol, reason: `session gate: ${why}` });
        }
        continue;
      }

      // ── CANDIDATE (v6): the LAMP **or** decisive TICK MOMENTUM. The user's
      //    method — “tick momentum দেখে, market structure দেখে এন্ট্রি”: the
      //    lamp is one trigger (deliberately slow — hysteresis), a hard
      //    one-sided 20s tape push is another that catches the impulse the
      //    lamp is still warming up to. ──
      let side: TradeSide | null = null;
      if (sig.state === "buy" || sig.state === "sell") side = sig.state;
      const feel = this.feelings.get(rule.symbol);
      const mom = feel?.momentum ?? 0;
      if (!side && Math.abs(mom) >= MOM_ENTRY_ABS) side = mom > 0 ? "buy" : "sell";
      if (!side) continue;
      // a HARD opposing lamp vetoes a momentum candidate
      if (sig.state !== "neutral" && sig.state !== side && sig.strength >= 0.5) continue;

      const dirSign = side === "buy" ? 1 : -1;
      const momWith = mom * dirSign;

      // ── candidate floor — LOW for priority pairs (the LLM judge filters
      //    quality); momentum candidates need the tape pushing one way ──
      const floor = (prio ? CAND_FLOOR_PRIO : CAND_FLOOR_STD)
        + (edge.consecLosses >= CONSEC_LOSS_BREAK ? 0.12 : 0);
      const lampOk = sig.state === side && sig.strength >= floor;
      const momentumOk = momWith >= MOM_GATE_WITH
        && sig.strength >= (sig.state === side ? floor * 0.55 : 0.18);
      if (!lampOk && !momentumOk) {
        // conviction building but not enough — a thought at most every ~10s per symbol
        const lastThink = this.lastEntryAt.get(`${rule.symbol}|think`) ?? 0;
        if ((sig.strength > floor * 0.75 || momWith > 0.15) && Date.now() - lastThink > 10_000) {
          this.lastEntryAt.set(`${rule.symbol}|think`, Date.now());
          this.think(
            `${rule.symbol}: ${side === "buy" ? "বাই" : "সেল"} দিকে চাপ তৈরি (ল্যাম্প ${(sig.strength * 100) | 0}%, মোমেন্টাম ${momWith >= 0 ? "+" : ""}${(momWith * 100) | 0}%) — ফ্লোর ${(floor * 100) | 0}%${edge.consecLosses >= CONSEC_LOSS_BREAK ? " (লস-স্ট্রিক পরে সতর্কতা বেশি)" : ""}`,
            "info",
          );
        }
        continue;
      }
      const viaTrigger = lampOk ? "lamp" : "momentum";

      // cooldown per symbol (shorter for priority pairs — the judge guards
      // quality now; deepened ×3 after a losing streak — learn to rest)
      const cooldown = prof.cooldownMs * (prio ? 0.5 : 1) * (edge.consecLosses >= CONSEC_LOSS_BREAK ? 3 : 1);
      const last = this.lastEntryAt.get(rule.symbol) ?? 0;
      if (Date.now() - last < cooldown) continue;

      // candle-age gate: only the first 8% (auction noise) and the last 5%
      // (exhaustion tail) are excluded — $-target scalps ride most of the candle.
      // v12: measured on the BROKER clock (server now + broker offset) — the
      // M1 bar boundary belongs to the broker, not to the container clock.
      const brokerNow = this.host.brokerNowSec();
      const ageFrac = ((brokerNow % 60) + 60) % 60 / 60;
      if (ageFrac < 0.08 || ageFrac > 0.95) continue;

      // one judge question per symbol at a time + per-symbol judge cooldown
      if ((this.judgeBusyUntil.get(rule.symbol) ?? 0) > Date.now()) continue;
      if (Date.now() - (this.lastJudgeAt.get(rule.symbol) ?? 0) < JUDGE_COOLDOWN_MS) continue;

      const q = this.host.getQuote(rule.symbol);
      if (!q || !q.bid || !q.ask) continue;
      const digits = this.host.digits(rule.symbol);

      // ── SPEED: the decision clock starts here (execMs is measured & shown) ──
      const tDecide0 = Date.now();

      // ONE M1 fetch feeds everything: ATR/EMA snapshot + judge tape + SL
      // structure + the 2m/3m/5m/10m/15m MTF aggregates (140 bars ≈ 2.3h).
      // v16.8 (user audit): plus ONE M15 fetch — SL sizing is now based on
      // the M15 ATR. An M1-ATR stop on gold ($0.7–1.5) is wick-food: a
      // normal 15-second fluctuation is $1–2.5, so every entry died inside
      // the first minute. M15 volatility is the honest floor for gold.
      let m1bars: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
      try { m1bars = await this.host.getCandles(rule.symbol, "M1", 140); } catch { continue; }
      const snap = this.snapshotFrom(m1bars);
      if (!snap || snap.atr <= 0) continue;
      let m15bars: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
      try { m15bars = await this.host.getCandles(rule.symbol, "M15", 60); } catch { /* sizing falls back below */ }
      const m15atr = this.wilderAtrOf(m15bars) ?? snap.atr * Math.sqrt(15);

      // CONFLUENCE (soft signals — the judge weighs them, one stays hard):
      const trendOk = snap.trendUp === null ? true : (side === "buy" ? snap.trendUp : !snap.trendUp);
      const momOk = momWith > -0.05;
      // HARD chase guard — never buy 1.75+ ATR above EMA (that IS the
      // "entry ভুল জায়গায়" the user complained about: chasing a blown-out move)
      if (snap.extAtr > EXT_MAX_ATR) {
        this.journalLog({
          action: "skip", symbol: rule.symbol,
          reason: `chase guard: ${snap.extAtr.toFixed(2)} ATR past EMA20 (cap ${EXT_MAX_ATR})`,
        });
        this.think(`${rule.symbol}: দূরে ছুটেছে (${snap.extAtr.toFixed(1)} ATR) — এখন ঢুকলে পিছন থেকে ছুটতে হয়, না`, "warn");
        this.lastEntryAt.set(rule.symbol, Date.now());
        continue;
      }

      // spread budget comes AFTER we know the SL distance — compute both now
      const spread = q.ask - q.bid;
      // v12: a dead/zero spread means the quote fell — risk sizing would be
      // garbage (the spread floor silently vanished and INVALID_STOPS followed)
      if (!(spread > 0)) {
        this.journalLog({ action: "skip", symbol: rule.symbol, reason: "spread unavailable (quote fell) — cannot size risk" });
        continue;
      }

      // ══ THE 3-CHART CONFLUENCE (v6) — the user reads three charts together,
      //    and so must the brain. All three must agree BEFORE the AI judge is
      //    even asked:
      //    1. MARKET STRUCTURE — 8-frame MTF consensus (1m/2m/3m/5m/10m/15m/
      //       30m/1H): low frames must not fight the entry, mids may not
      //       strongly oppose, 30m/1H veto only real opposition
      //    2. DELTA MICRO — the current M1 candle's cumulative delta pushes
      //       the entry way; the previous candle agrees or is neutral-small
      //    3. AREA (tick path) — the last ~30s path leans the entry way
      //       (2 of 3 path signals is enough — an AND-chain here starved the
      //       brain of entries, the user's loudest complaint) ══
      const mr = await this.marketReadCached(rule.symbol);
      const deep = tr.deepRead();
      const ticks30 = this.host.getTicks(rule.symbol, 30);

      // 1. market structure — the full multi-timeframe read
      const mtf = await this.mtfConsensus(rule.symbol, m1bars, side, snap.atr);
      const structureOk = mtf.ok;

      // 2. delta micro — current candle must push; previous may agree or rest
      let deltaOk: boolean;
      let deltaNote: string;
      if (deep.curDelta !== 0 || deep.prevDelta !== 0) {
        const curOk = deep.curDelta * dirSign > 0;
        const prevOk = deep.prevDelta * dirSign > 0
          || Math.abs(deep.prevDelta) <= Math.max(3, Math.abs(deep.curDelta) * 0.35);
        deltaOk = curOk && prevOk;
        deltaNote = `Δcandle ${curOk ? "✓" : "✗"} Δprev ${deep.prevDelta * dirSign > 0 ? "✓" : "~"} (${deep.agreeStreak} streak)`;
      } else {
        // fresh tracker with no candle history — fall back to live decisive delta
        deltaOk = fp.deltaPct * dirSign >= 0.25;
        deltaNote = `Δlive ${(fp.deltaPct * 100) | 0}%`;
      }

      // 3. tick path — 2 of 3 signals: net 30s push, close holding its end
      //    of the range, up-tick balance
      let pathOk: boolean;
      let pathNote: string;
      if (ticks30.length >= 8) {
        const first = ticks30[0].p, last30 = ticks30[ticks30.length - 1].p;
        const net = (last30 - first) * dirSign;
        const hi = Math.max(...ticks30.map((x) => x.p));
        const lo = Math.min(...ticks30.map((x) => x.p));
        const span = hi - lo || 1e-9;
        const closePos = (last30 - lo) / span;
        let ups = 0;
        for (let i = 1; i < ticks30.length; i++) if (ticks30[i].p > ticks30[i - 1].p) ups++;
        const upFrac = ups / (ticks30.length - 1);
        const s1 = net > 0 ? 1 : 0;
        const s2 = (side === "buy" ? closePos >= 0.55 : closePos <= 0.45) ? 1 : 0;
        const s3 = (side === "buy" ? upFrac >= 0.48 : upFrac <= 0.52) ? 1 : 0;
        pathOk = s1 + s2 + s3 >= 2;
        pathNote = `path ${s1 + s2 + s3}/3`;
      } else if (momWith >= 0.15) {
        pathOk = true;              // sparse tape but momentum is one-sided
        pathNote = "mom-path";
      } else {
        pathOk = false;
        pathNote = "no tape";
      }

      if (!(structureOk && deltaOk && pathOk)) {
        const why = [
          !structureOk && `MTF বিপক্ষে (${mtf.note})`,
          !deltaOk && `delta-micro not aligned [${deltaNote}]`,
          !pathOk && `tick-path not supporting [${pathNote}]`,
        ].filter(Boolean).join(" + ");
        // v6.2 throttled veto logging — the reason still reaches the brain
        // log at a human cadence, the journal keeps room for real trades
        const cat = why.split(" + ")[0].slice(0, 24);
        const prevSkip = this.lastSkipLogAt.get(rule.symbol);
        const catChanged = !prevSkip || prevSkip.cat !== cat;
        if (!prevSkip || catChanged || Date.now() - prevSkip.at > 90_000) {
          this.lastSkipLogAt.set(rule.symbol, { at: Date.now(), cat });
          this.journalLog({ action: "skip", symbol: rule.symbol, reason: `3-chart veto: ${why}` });
        }
        const lastVetoThink = this.lastSkipThinkAt.get(rule.symbol) ?? 0;
        if (Date.now() - lastVetoThink > 45_000 || catChanged) {
          this.lastSkipThinkAt.set(rule.symbol, Date.now());
          this.think(`${rule.symbol}: ৩-চার্ট মিললো না — ${why} — এন্ট্রি নয়`, "warn");
        }
        this.lastEntryAt.set(rule.symbol, Date.now()); // brief rest, not full cooldown
        continue;
      }

      // ── ask the REAL AI ──
      this.judgeBusyUntil.set(rule.symbol, Date.now() + JUDGE_TIMEOUT_MS);
      this.lastJudgeAt.set(rule.symbol, Date.now());
      let verdict: import("./ai-judge").JudgeVerdict | null = null;
      try {
        if (mr && mr.atr > 0) {
          const lessons = this.lessons
            .filter((l) => l.symbol === rule.symbol)
            .slice(-3)
            .map((l) => l.text);
          verdict = await Promise.race([
            this.judge.judgeEntry({
              symbol: rule.symbol,
              candidateSide: side,
              lampStrength: sig.strength,
              trendOk, momOk,
              extAtr: snap.extAtr,
              mtf: { agree: mtf.agree, total: mtf.total, note: mtf.note },
              momWith,
              tpUsd: this.cfg.tpUsd,
              market: {
                digits: mr.digits,
                price: mr.price,
                atr: mr.atr,
                trend: mr.trend,
                supports: mr.supports,
                resistances: mr.resistances,
                valueArea: mr.valueArea,
                bias: mr.bias ? { state: mr.bias.state, strength: mr.bias.strength } : null,
                candles: m1bars.slice(-18).map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
              },
              spreadInAtr: snap.atr > 0 ? spread / snap.atr : 0,
              lessons,
              edgeWinRate: edge.n >= 5 ? edge.winRate : null,
              openSame: [...this.positions.values()]
                .filter((p) => p.symbol === rule.symbol)
                .map((p) => ({ side: p.side, pnlR: p.pnlR })),
              riskMode: this.cfg.riskMode,
            }),
            new Promise<null>((res) => setTimeout(() => res(null), JUDGE_TIMEOUT_MS)),
          ]);
        }
      } catch { /* judge hiccup */ } finally {
        this.judgeBusyUntil.set(rule.symbol, 0);
      }

      let go = false;
      let aiNote = "";
      let aiConf = 0;
      let slAtrMult = prof.slAtrMult;
      let tpR = prof.tpR;
      let via = "local";

      if (verdict && (verdict.action === "buy" || verdict.action === "sell")) {
        go = true;
        via = "AI";
        aiNote = verdict.note;
        aiConf = verdict.conf;
        if (verdict.slAtrMult) slAtrMult = verdict.slAtrMult;
        if (verdict.tpR) tpR = verdict.tpR;
        this.recordVerdict({ symbol: rule.symbol, kind: "entry", side, decision: verdict.action, conf: verdict.conf, note: verdict.note, applied: true });
        this.think(`${rule.symbol}: AI জাজ বললো ${side === "buy" ? "🟢 বাই" : "🔴 সেল"} ✓ (কনফিডেন্স ${verdict.conf}%) — ${verdict.note}`, "good");
      } else if (verdict && verdict.action === "pass") {
        this.recordVerdict({ symbol: rule.symbol, kind: "entry", side, decision: "pass", conf: verdict.conf, note: verdict.note, applied: false });
        this.journalLog({ action: "skip", symbol: rule.symbol, reason: `AI judge pass: ${verdict.note}` });
        this.think(`${rule.symbol}: AI জাজ থামালো — ${verdict.note}`, "warn");
        this.lastEntryAt.set(rule.symbol, Date.now()); // brief rest, not a full cooldown
        continue;
      } else {
        // judge unavailable → deterministic confluence decides (old behavior)
        this.recordVerdict({ symbol: rule.symbol, kind: "entry", side, decision: "offline", conf: 0, note: "মডেল পাওয়া যায়নি — লোকাল নিয়মে", applied: false });
        const strict = Math.min(0.85, prof.minStrength * edge.adaptiveMin + (edge.consecLosses >= CONSEC_LOSS_BREAK ? 0.08 : 0));
        // momentum candidates pass on their own tape conviction
        const localPass = (sig.strength >= strict || (momentumOk && momWith >= 0.24)) && trendOk && momOk;
        if (localPass) {
          go = true;
          via = "local";
          this.think(`${rule.symbol}: AI নেই — লোকাল কনফ্লুয়েন্স পাস, ঢুকছি`, "info");
        } else {
          const why = [!trendOk && "ট্রেন্ড বিপরীত", !momOk && "টিক-মোমেন্টাম অসম্মত", sig.strength < strict && `কনভিকশন ${(sig.strength * 100) | 0}%<${(strict * 100) | 0}%`]
            .filter(Boolean).join(" + ");
          this.journalLog({ action: "skip", symbol: rule.symbol, reason: `AI offline, local confluence fail: ${why}` });
          this.think(`${rule.symbol}: AI অফলাইন আর লোকালও পাস নয় (${why}) — বাদ`, "warn");
          this.lastEntryAt.set(rule.symbol, Date.now());
          continue;
        }
      }

      // ── spread budget: SL wide enough that the spread is a small fraction,
      //    so gold / indices / oil (wide spreads) trade just like FX ──
      // v16.8 (user audit) — THREE fixes in one block:
      //   1. VOLATILITY FLOOR moves to the M15 ATR (gold: ≥ 1.2×M15 ATR and
      //      never under $3.50 / 35 pips — the user's own measured minimum;
      //      cap breathes with volatility instead of a flat $6.00)
      //   2. STRUCTURE SL is measured MID-to-MID: the old `ask − lo3` quietly
      //      ate the whole spread (ask is always above mid), planting the
      //      stop half-a-spread closer than intended — now + 0.5×spread is
      //      explicit, and structure may only WIDEN the stop, never tighten
      //      it below the volatility floor (the old [0.7×, 1.6×] band could
      //      CHOKE it)
      //   3. the M1 × slAtrMult stop is retired for gold; non-gold keeps the
      //      classic sizing on top of an M15 floor
      const isGold = /XAU|GOLD/i.test(rule.symbol);
      const entry = side === "buy" ? q.ask : q.bid; // order fills on THIS side
      let slDist = isGold
        ? Math.max(1.2 * m15atr, 3.5)
        : Math.max(snap.atr * slAtrMult, m15atr * 0.8);

      const mid = (q.ask + q.bid) / 2;
      const structExt = side === "buy" ? snap.lo3 : snap.hi3;
      const structDist = Math.abs(mid - structExt) + snap.atr * 0.5 + spread * 0.5;
      if (structDist > slDist) slDist = structDist;

      if (slDist < spread * SPREAD_BUDGET) slDist = spread * SPREAD_BUDGET;
      const slCap = isGold ? Math.max(6.0, 1.5 * m15atr) : snap.atr * SL_ATR_CAP;
      if (slDist > slCap) slDist = slCap;
      if (spread > slDist * 0.45) {
        // truly illiquid moment (spread wider than 45% of even the widened SL)
        this.journalLog({
          action: "skip", symbol: rule.symbol,
          reason: `spread pathological (${spread.toFixed(digits)} vs slDist ${slDist.toFixed(digits)})`,
        });
        continue;
      }

      const sl = side === "buy" ? entry - slDist : entry + slDist;

      // ══ v16.9 (audit E2) — RISK-% POSITION SIZING · OPT-IN, DEFAULT OFF ══
      // riskPct > 0 → size the entry from the LIVE balance so the SL costs
      // ≈ riskPct% of the account: lots = riskUsd / (slDist × cm), where cm
      // is the broker-deal-calibrated $-per-price-unit-per-lot (cmOf — the
      // same multiplier every P/L computation already uses; XAUUSD = 100/lot).
      // Round DOWN to the 0.01 lot step (never round UP into more risk),
      // clamp to [broker-min 0.01, MAX_LOT]. riskPct = 0 (the DEFAULT) keeps
      // the legacy fixed rule.lots EXACTLY — no silent behavior change. Any
      // missing input (no balance / no multiplier / degenerate SL) falls
      // back to the fixed lots: never trade a wrong size on a math hiccup.
      const cm = this.cmOf(rule.symbol, entry);
      let lots = rule.lots;
      let sizingNote = "";
      if (this.cfg.riskPct > 0) {
        const bal = this.acct?.balance ?? 0;
        if (bal > 0 && cm > 0 && slDist > 0) {
          const riskUsd = (bal * this.cfg.riskPct) / 100;
          const rawLots = riskUsd / (slDist * cm);
          const sized = Math.max(0.01, Math.min(MAX_LOT, Math.floor(rawLots * 100) / 100));
          lots = sized;
          sizingNote = rawLots < 0.01
            ? ` · lots ${sized.toFixed(2)} (${this.cfg.riskPct}% রিস্ক-বাজেট $${riskUsd.toFixed(2)} < 0.01-লট মিনিটাম — মিনিটাম লটে ঢুকছি)`
            : ` · lots ${sized.toFixed(2)} (${this.cfg.riskPct}% রিস্ক, SL ${slDist.toFixed(1)} দূরে)`;
        } else {
          // metadata missing/unreliable → legacy fixed lots, said out loud
          sizingNote = ` · রিস্ক-% সাইজিং স্কিপ (ব্যালেন্স/কন্ট্রাক্ট-ডেটা নেই) — ফিক্সড ${lots} লট`;
          this.journalLog({
            action: "info", symbol: rule.symbol,
            reason: `risk-% sizing fell back to fixed lots (balance ${bal.toFixed(2)}, cm ${cm.toFixed(2)}, slDist ${slDist.toFixed(2)}) — audit E2`,
          });
        }
      }
      // ── TP (v6): the user's fixed-dollar rule — BANK THE PROFIT at +$tpUsd
      //    (default $0.50). The broker-side TP is parked at that price (never
      //    inside the spread); the monitor()'s tick-side close is the exact
      //    primary (bid/ask correct side). tpUsd = 0 → classic R-multiple. ──
      let tp: number;
      if (this.cfg.tpUsd > 0) {
        const tickSize = Math.pow(10, -digits);
        const tpDist = Math.max(this.cfg.tpUsd / (lots * cm), spread * 1.25 + tickSize * 2);
        tp = side === "buy" ? entry + tpDist : entry - tpDist;
      } else {
        tp = side === "buy" ? entry + slDist * tpR : entry - slDist * tpR;
      }

      const reason =
        `${via === "AI" ? `AI✓ ${aiConf}%` : "local"} · ${viaTrigger === "momentum" ? "⚡mom" : "lamp"} ${(sig.strength * 100) | 0}%` +
        ` · MTF ${mtf.agree}/${mtf.total} · ${deltaNote} · ${pathNote}` +
        ` · ${this.cfg.tpUsd > 0 ? `TP$${this.cfg.tpUsd.toFixed(2)}` : `TP ${tpR.toFixed(1)}R`}` +
        ` · trend${trendOk ? "✓" : "✗"} · mom${momWith >= 0 ? "+" : ""}${(momWith * 100) | 0}%` +
        ` · SL@structure${Math.abs(structDist - slDist) < 1e-9 ? "✓" : "~"}` +
        ` · ${prio ? "★prio" : `edge×${edge.adaptiveMin.toFixed(2)}`} · spread ${((spread / slDist) * 100) | 0}%` +
        sizingNote +
        (aiNote ? ` · ${aiNote.slice(0, 60)}` : "");

      // serialize trade ops — and a brain that was stopped mid-thought
      // (hot-reload) must NOT fire its order (duplicate-entry armor)
      if (gen !== this.generation) return;
      // v16.4 (audit §7 pre-submit #8): final volume sanity at the door —
      // positive, ≥ broker min 0.01, and an exact 0.01-step multiple. The
      // config clamps should have made this impossible; this guard makes
      // it CERTAIN (a legacy persisted rule can't 10014 at the broker).
      // v16.9: checks the FINAL volume (risk-% sized or legacy fixed).
      const stepSnapped = Math.round(lots * 100) / 100;
      if (!(lots > 0) || lots < 0.01 || stepSnapped !== lots) {
        this.journalLog({
          action: "skip", symbol: rule.symbol,
          reason: `invalid lots ${lots} (min 0.01, step 0.01) — rejected before broker call`,
        });
        this.lastEntryAt.set(rule.symbol, Date.now());
        continue;
      }
      const res = await this.host.marketOrderAt(rule.symbol, side, lots, entry, {
        sl: Number(sl.toFixed(digits + 1)),
        tp: Number(tp.toFixed(digits + 1)),
        digits, comment: "ai-brain",
      });
      if (gen !== this.generation && res.retcode === 10009) {
        // order landed but this instance is dead — make sure the next brain
        // adopts it cleanly (it stays tracked via broker sync)
        this.journalLog({ action: "open", symbol: rule.symbol, side, price: res.price, lots, reason: `handoff: ${reason}` });
      }

      if (res.retcode === 10009) {
        // ── execution latency: signal→order, measured and shown live ──
        const execMs = Date.now() - tDecide0;
        const lampAgeMs = sig.sinceMs ? Date.now() - sig.sinceMs : 0;
        this.execLastMs = execMs;
        this.execN++;
        this.execAvgMs = Math.round(this.execAvgMs + 0.25 * (execMs - this.execAvgMs));
        const pos: TraderPosition = {
          ticket: res.order, symbol: rule.symbol, side, lots,
          lots0: lots,
          entry: res.price || entry, sl, tp, openedAt: Date.now(),
          reason, price: res.price || entry, pnl: 0, pnlR: 0, slDist, peakR: 0,
          beMoved: false, partialDone: false, adopted: false,
          origin: "brain", bankedPnl: 0, aiConfirmed: via === "AI",
          execMs, lampAgeMs,
        };
        this.positions.set(pos.ticket, pos);
        this.nextReviewAt.set(pos.ticket, Date.now() + REVIEW_FIRST_MS);
        this.aiCloseVotes.set(pos.ticket, 0);
        this.lastEntryAt.set(rule.symbol, Date.now());
        this.today.trades++;
        this.journalLog({ action: "open", symbol: rule.symbol, side, price: res.price, lots, reason });
        this.think(`${rule.symbol} ${side === "buy" ? "🟢 BUY" : "🔴 SELL"} ${lots} @ ${res.price} — ${reason}`, side === "buy" ? "good" : "warn");
        this.emit(true);
        // ── anti-phantom: verify the real broker ticket shortly after open ──
        setTimeout(() => { this.verifyTicket(pos).catch(() => {}); }, 2500);
      } else if (res.retcode === 10019) {
        this.noFunds = true;
        this.journalLog({ action: "error", symbol: rule.symbol, reason: "NO_MONEY — account has no funds" });
        this.think("⚠️ NO_MONEY — অ্যাকাউন্টে ব্যালেন্স নেই, এন্ট্রি সাসপেন্ড", "bad");
        this.emit(true);
        return;
      } else if (res.retcode !== -1) {
        this.journalLog({ action: "error", symbol: rule.symbol, reason: `open rejected: ${res.retcode} ${res.comment}` });
        this.think(`${rule.symbol} এন্ট্রি রিজেক্ট (${res.retcode})`, "bad");
        this.lastEntryAt.set(rule.symbol, Date.now()); // don't hammer a rejecting server
      }
    }
  }

  /** verdict log for the UI (the model's live decisions, newest last) */
  private recordVerdict(v: Omit<AiVerdictRecord, "at">) {
    this.verdicts.push({ at: Date.now(), ...v });
    if (this.verdicts.length > VERDICT_MAX) this.verdicts.shift();
    this.emit(true);
  }

  /**
   * REAL-AI position review — fire-and-forget from monitor(). The model sees
   * the live R / peak / age / structure and answers hold / tighten / close.
   * "close" must fire TWICE in a row before the brain acts (one bad verdict
   * must never cut a healthy trade).
   */
  private async aiReview(p: TraderPosition) {
    try {
      const q = this.host.getQuote(p.symbol);
      const mr = await this.marketReadCached(p.symbol); // cached — no fetch stall
      let bias: { state: string; strength: number } | null = null;
      try {
        const tr = this.tracker(p.symbol);
        if (tr) {
          const fp = tr.payload(Date.now());
          bias = { state: fp.sig.state, strength: fp.sig.strength };
        }
      } catch { /* tracker hiccup */ }
      if (!mr || mr.atr <= 0) return;
      const verdict = await this.judge.judgeReview({
        symbol: p.symbol, side: p.side, lots: p.lots,
        entry: p.entry, price: q?.mid ?? p.price,
        pnlR: p.pnlR, peakR: p.peakR,
        heldSec: Math.round((Date.now() - p.openedAt) / 1000),
        beMoved: p.beMoved, partialDone: p.partialDone,
        tpUsd: this.cfg.tpUsd, tpLeftUsd: p.tpUsdAway,
        market: {
          digits: mr.digits, price: mr.price, atr: mr.atr, trend: mr.trend,
          supports: mr.supports, resistances: mr.resistances,
          valueArea: mr.valueArea,
          bias: mr.bias ? { state: mr.bias.state, strength: mr.bias.strength } : bias,
          candles: [],
        },
        bias: bias ?? mr.bias,
      });
      if (!verdict) return;
      this.nextReviewAt.set(p.ticket, Date.now() + REVIEW_EVERY_MS);

      if (verdict.action === "close") {
        const votes = (this.aiCloseVotes.get(p.ticket) ?? 0) + 1;
        this.aiCloseVotes.set(p.ticket, votes);
        this.recordVerdict({ symbol: p.symbol, kind: "review", side: p.side, decision: "close", conf: verdict.conf, note: verdict.note, applied: votes >= 2 });
        if (votes >= 2) {
          this.think(`${p.symbol}: AI দুইবার বললো ক্লোজ — শুনছি (${verdict.note})`, "warn");
          await this.closeManaged(p, `AI review close: ${verdict.note}`, "AI");
        } else {
          this.think(`${p.symbol}: AI বলছে ক্লোজ (${verdict.note}) — আরেকবার বললে ক্লোজ করব`, "info");
        }
        return;
      }
      this.aiCloseVotes.set(p.ticket, 0);

      if (verdict.action === "tighten") {
        this.recordVerdict({ symbol: p.symbol, kind: "review", side: p.side, decision: "tighten", conf: verdict.conf, note: verdict.note, applied: true });
        const digits = this.host.digits(p.symbol);
        const dirMult = p.side === "buy" ? 1 : -1;
        const q2 = this.host.getQuote(p.symbol);
        // lock a meaningful slice of the peak — never loosen
        const target = p.entry + dirMult * p.slDist * Math.max(0.15, Math.min(p.peakR - 0.35, p.pnlR - 0.1));
        const improve = dirMult > 0 ? target - p.sl : p.sl - target;
        if (improve > p.slDist * 0.08 && q2) {
          const r = await this.host.modifyPosition(p.symbol, p.side, p.lots, q2.mid, p.ticket,
            Number(target.toFixed(digits + 1)), p.tp, { digits });
          if (r.retcode === 10009) {
            p.sl = target;
            if (!p.beMoved && dirMult > 0 ? target >= p.entry : target <= p.entry) p.beMoved = true;
            this.journalLog({ action: "manage", symbol: p.symbol, reason: `AI tighten SL → ${target.toFixed(digits)} (R ${p.pnlR.toFixed(2)}) — ${verdict.note}` });
            this.think(`${p.symbol}: AI বললো টাইট করতে — SL → ${target.toFixed(digits)} (${verdict.note})`, "good");
          }
        }
        return;
      }

      // hold
      this.recordVerdict({ symbol: p.symbol, kind: "review", side: p.side, decision: "hold", conf: verdict.conf, note: verdict.note, applied: false });
    } catch { /* review hiccup — next round will retry */ }
  }

  /**
   * ANTI-PHANTOM: right after opening, ask the broker for its own position
   * list and match ours by symbol/side/lots/entry/recency. If the cmd-19
   * `order` field disagrees with the real position id, FIX our ticket —
   * this is exactly what caused the Sep-29 phantom-close incident.
   */
  private async verifyTicket(p: TraderPosition) {
    if (!this.positions.has(p.ticket) && ![...this.positions.values()].some((x) => x === p)) return;
    try {
      const { positions } = await this.host.positions();
      const tol = Math.max(p.slDist * 0.5, p.entry * 0.002);
      const match = positions.find((bp) =>
        bp.symbol === p.symbol &&
        bp.side === p.side &&
        Math.abs(bp.lots - p.lots) < 1e-9 &&
        Math.abs(bp.openPrice - p.entry) <= tol &&
        Math.abs(bp.openTime - p.openedAt) < 90_000,
      );
      if (match) {
        const realKey = match.order || match.id;
        if (realKey && realKey !== p.ticket) {
          this.positions.delete(p.ticket);
          p.ticket = realKey;
          this.positions.set(realKey, p);
          this.journalLog({ action: "manage", symbol: p.symbol, reason: `ticket verified → broker id ${realKey}` });
          this.think(`${p.symbol}: টিকিট ব্রোকারের সাথে মিলিয়ে নিলাম (#${realKey}) — এখন নিরাপদ`, "info");
          this.emit(true);
        } else {
          this.vanish.delete(p.ticket);
        }
        // ── v16.4 (audit §7 + §13): SL/TP ATTACH VERIFICATION — an accepted
        //    order (10009) is not proof the stops live on the broker. A rare
        //    broker race can land the position with sl=0/tp=0; that trade
        //    would then run NAKED until the next manage pass noticed. Ask
        //    the broker's own position record; if the stop is missing or
        //    materially different from what we requested, RE-ATTACH it now
        //    via the same modify path breakeven uses. ──
        this.verifyStopsAttached(p, match).catch(() => {});
      }
    } catch { /* broker briefly away — sync will retry */ }
  }

  /** v16.4: broker-truth SL/TP check — re-attach when the broker disagrees. */
  private async verifyStopsAttached(p: TraderPosition, brokerPos: { sl: number; tp: number }) {
    const digits = this.host.digits(p.symbol);
    const tol = Math.max(p.slDist * 0.35, 3 * Math.pow(10, -digits));
    const slMissing = p.sl > 0 && (brokerPos.sl <= 0 || Math.abs(brokerPos.sl - p.sl) > tol);
    const tpMissing = p.tp > 0 && (brokerPos.tp <= 0 || Math.abs(brokerPos.tp - p.tp) > tol);
    if (!slMissing && !tpMissing) return;
    this.journalLog({
      action: "manage", symbol: p.symbol,
      reason: `stops attach check: broker sl=${brokerPos.sl.toFixed(digits)} tp=${brokerPos.tp.toFixed(digits)} vs requested sl=${p.sl.toFixed(digits)} tp=${p.tp.toFixed(digits)} — re-attaching`,
    });
    try {
      const q = this.host.getQuote(p.symbol);
      const r = await this.host.modifyPosition(
        p.symbol, p.side, p.lots, q?.mid ?? p.entry, p.ticket,
        p.sl, p.tp, { digits },
      );
      if (r.retcode === 10009) {
        this.think(`${p.symbol}: ব্রোকারে SL/TP আবার বসিয়ে দিলাম (attach নিশ্চিত) 🛡️`, "good");
        this.emit(true);
      } else {
        // don't spam: monitor()'s manage passes keep retrying organically
        this.journalLog({ action: "error", symbol: p.symbol, reason: `stop re-attach rejected: ${r.retcode} ${r.comment}` });
      }
    } catch (e) {
      this.journalLog({ action: "error", symbol: p.symbol, reason: `stop re-attach threw: ${(e as Error).message}` });
    }
  }

  // ── MONITORING: watch every position like a human, every beat ──
  private async monitor() {
    const prof = RISK[this.cfg.riskMode];
    for (const p of [...this.positions.values()]) {
      const q = this.host.getQuote(p.symbol);
      if (!q) continue;
      const digits = this.host.digits(p.symbol);
      const mark = p.side === "buy" ? q.bid : q.ask; // closing price
      p.price = mark;
      const dirMult = p.side === "buy" ? 1 : -1;
      const pts = (mark - p.entry) * dirMult;
      const cm = this.cmOf(p.symbol, p.entry);
      p.pnl = pts * p.lots * cm;
      // live $ distance to the TP target / the SL — the follow-up numbers the
      // narration layer and the position cards show on every beat
      if (p.tp > 0) p.tpUsdAway = Math.max(0, Math.abs(p.tp - mark) * p.lots * cm);
      if (p.sl > 0) p.slUsdAway = Math.max(0, Math.abs(p.sl - mark) * p.lots * cm);
      p.peakUsd = Math.max(p.peakUsd ?? 0, p.pnl);
      if (p.slDist > 0) {
        p.pnlR = pts / p.slDist;
        p.peakR = Math.max(p.peakR, p.pnlR);
      }

      // ══ v9 COPILOT MODE — the user's manual MT5 positions are FOLLOWED,
      //    never strategized over: live P/L + $-distance + entry tracking
      //    (above) plus CAPITAL PROTECTION (auto-breakeven at the trigger).
      //    No flip/time/adverse/AI/$-target closes on a trade the brain
      //    didn't open — the user asked for a copilot, not an autopilot. ══
      if (p.adopted) {
        const beTrigAdopted = this.beTriggerUsd();
        if (beTrigAdopted > 0 && !p.beMoved && p.pnl >= beTrigAdopted) {
          await this.moveBe(p, q);
        }
        continue;
      }
      if (p.slDist <= 0) continue; // safety net (brain positions always set SL)

      // ── REAL-AI review (fire-and-forget; one in-flight per position) ──
      if (!this.reviewing.has(p.ticket)) {
        const due = this.nextReviewAt.get(p.ticket) ?? (p.openedAt + REVIEW_FIRST_MS);
        if (Date.now() >= due) {
          this.reviewing.add(p.ticket);
          this.aiReview(p).catch(() => {}).finally(() => this.reviewing.delete(p.ticket));
        }
      }

      // one flow read per position per beat — feeds flip check, runner trail,
      // time-stop and adverse cut alike (the X-ray is the manager's eyes)
      const tr = this.tracker(p.symbol);
      let fp: FlowPayload | null = null;
      if (tr) {
        try { fp = tr.payload(Date.now()); } catch { /* tracker hiccup */ }
      }
      const flowWithUs = !!fp && fp.sig.state === p.side;
      const flowAgainst = !!fp && fp.sig.state === (p.side === "buy" ? "sell" : "buy");

      // 0) $-TARGET — the user's core rule: profit ≥ tpUsd → BANK IT, always.
      //    Small consistent wins; a winner must never round-trip to a loss.
      if (this.cfg.tpUsd > 0 && p.pnl >= this.cfg.tpUsd) {
        await this.closeManaged(p, `TP HIT +$${p.pnl.toFixed(2)} ✅ ($${this.cfg.tpUsd.toFixed(2)} target)`, "TP");
        continue;
      }

      // 1) flow flipped HARD against us and we're under water → cut (the
      //    human "feel"). v6: the bar is high (a moderate counter-flow must
      //    NOT scare the brain out at a tiny loss — the user's complaint:
      //    “অল্প লসেই ক্লোজ করে দেয়”). v16.8 (user audit): the bar is now a
      //    WALL — a very hard counter-flow (≥ 0.85 strength) AND already
      //    ≥ 0.45R under water. A trade must BREATHE: spread alone opens
      //    positions at −0.2R and the old 0.62–0.72 flipStrength finished
      //    them before the thesis had a chance.
      const losingNow = this.cfg.tpUsd > 0 ? p.pnl < 0 : p.pnlR < 0;
      if (fp && flowAgainst && fp.sig.strength >= Math.max(prof.flipStrength, 0.85) && losingNow && p.pnlR <= -0.45) {
        await this.closeManaged(p, `flow flipped ${(p.side === "buy" ? "sell" : "buy").toUpperCase()} @${(fp.sig.strength * 100) | 0}%`, "FLIP");
        continue;
      }

      // 2) PARTIAL PROFIT — R-mode only ($-target mode takes the whole win
      //    at +$tpUsd instead of splitting it)
      if (this.cfg.tpUsd <= 0 && !p.partialDone && p.pnlR >= 1.0 && p.lots >= MIN_LOT_SPLIT) {
        const ok = await this.takePartial(p);
        if (ok) continue;
      }

      // 3) BREAKEVEN (v9) — the user's profit-protection rule: when live
      //    profit reaches the trigger ($beUsd, or AUTO = 60% of the $ target /
      //    breakevenR in R-mode) the SL jumps to entry + a small lock
      //    (“আসল দামে, বা তার একটু উপরে”) — the trade becomes risk-free.
      const beTrig = this.beTriggerUsd();
      const beReady = beTrig > 0
        ? p.pnl >= beTrig
        : p.pnlR >= (p.partialDone ? Math.min(0.5, prof.breakevenR) : prof.breakevenR);
      if (!p.beMoved && beReady) {
        await this.moveBe(p, q);
        continue;
      }

      // 3b) $-LOCK TRAIL (v9) — after breakeven, ratchet the stop so the
      //     locked profit tracks (peak − give). The winner breathes, but a
      //     round-trip to a loss is impossible. Only meaningful moves are
      //     sent to the broker (≥ half the spread of improvement).
      if (p.beMoved && beTrig > 0 && (p.peakUsd ?? 0) > 0) {
        const giveUsd = Math.max(beTrig * 0.5, 0.1);
        const lockUsd = (p.peakUsd ?? 0) - giveUsd;
        if (lockUsd > 0) {
          const lockDist = lockUsd / (p.lots * cm);
          const target = p.entry + dirMult * lockDist;
          const improve = dirMult > 0 ? target - p.sl : p.sl - target;
          const spread = q.ask - q.bid;
          if (improve > Math.max(spread * 0.5, p.entry * 1e-6)) {
            const r = await this.host.modifyPosition(p.symbol, p.side, p.lots, q.mid, p.ticket,
              Number(target.toFixed(digits + 1)), p.tp, { digits });
            if (r.retcode === 10009) {
              p.sl = target;
              // journal the FIRST lock and then every $0.50 of extra protection
              const lastJournaled = this.trailLocks.get(p.ticket);
              if (lastJournaled === undefined || lockUsd - lastJournaled >= 0.5) {
                this.trailLocks.set(p.ticket, lockUsd);
                this.journalLog({
                  action: "manage", symbol: p.symbol,
                  reason: `profit-lock trail → SL ${target.toFixed(digits)} (locks +$${lockUsd.toFixed(2)} of $${(p.peakUsd ?? 0).toFixed(2)} peak)`,
                });
              }
            }
          }
        }
        continue;
      }

      // 4) R-trail — pure R-mode only ($-target mode exits at +$tpUsd; a
      //    beUsd trigger switches to the $-lock trail above). RUNNERS BREATHE:
      //    while the flow still pushes our way the give is loosened +0.35R so
      //    winners are not suffocated.
      if (this.cfg.tpUsd <= 0 && this.cfg.beUsd <= 0 && p.pnlR >= prof.trailR) {
        const give = prof.trailGive + (flowWithUs ? 0.35 : 0);
        const trailStop = p.entry + dirMult * p.slDist * Math.max(0.2, p.peakR - give);
        const improve = dirMult > 0 ? trailStop - p.sl : p.sl - trailStop;
        if (improve > p.slDist * 0.1) { // only meaningful moves
          const r = await this.host.modifyPosition(p.symbol, p.side, p.lots, q.mid, p.ticket,
            Number(trailStop.toFixed(digits + 1)), p.tp, { digits });
          if (r.retcode === 10009) {
            p.sl = trailStop;
            this.journalLog({ action: "manage", symbol: p.symbol, reason: `trail SL → ${trailStop.toFixed(digits)} (peak R ${p.peakR.toFixed(2)}${flowWithUs ? ", runner" : ""})` });
          }
        }
      }

      // 5) time stop — ONLY a dead trade: flow gone neutral/quiet AND not in
      //    profit. A trade the flow still supports is NEVER time-stopped, and
      //    a winner is handled by the $-target/trail instead.
      const flatEnough = this.cfg.tpUsd > 0 ? p.pnl < this.cfg.tpUsd * 0.2 : p.pnlR < 0.15;
      if (Date.now() - p.openedAt > prof.maxHoldMs && flatEnough) {
        const flowDead = !fp || fp.sig.state === "neutral" || fp.sig.quiet;
        if (flowDead) {
          await this.closeManaged(p, `time stop (${Math.round((Date.now() - p.openedAt) / 1000)}s, R ${p.pnlR.toFixed(2)}, flow dead)`, "TIME");
          continue;
        }
      }

      // 6) adverse cut — v16.8 (user audit): NEVER before the hard SL any
      //    more. The old maxAdverseR 0.55–0.7 + flowAgainst closed trades
      //    at −0.55R while the broker SL sat at −1R — the user saw "এন্ট্রি
      //    নিলেই SL হিট" when it was really this kill-switch. Now it can
      //    only fire at/inside the stop distance itself (≥ 1R underwater).
      if (p.pnlR <= -Math.max(prof.maxAdverseR, 1.0) && flowAgainst) {
        await this.closeManaged(p, `adverse cut R ${p.pnlR.toFixed(2)} + flow against`, "ADVERSE");
        continue;
      }
    }
  }

  /** bank half the position at +1R — the consistency engine */
  private async takePartial(p: TraderPosition): Promise<boolean> {
    const half = Math.round((p.lots / 2) * 100) / 100;
    if (half < 0.01 || p.lots - half < 0.01) return false;
    const q = this.host.getQuote(p.symbol);
    const digits = this.host.digits(p.symbol);
    const closePrice = p.side === "buy" ? (q?.bid ?? p.price) : (q?.ask ?? p.price);
    try {
      const r = await this.host.closePosition(p.symbol, p.side, half, closePrice, p.ticket, { digits, comment: "ai-brain" });
      if (r.retcode === 10009) {
        const pnl = (r.price - p.entry) * (p.side === "buy" ? 1 : -1) * half * this.cmOf(p.symbol, p.entry);
        p.lots = Math.round((p.lots - half) * 100) / 100;
        p.partialDone = true;
        p.bankedPnl = (p.bankedPnl ?? 0) + pnl;   // remembered for honest settle()
        this.today.pnl = Math.round((this.today.pnl + pnl) * 100) / 100;
        this.journalLog({
          action: "manage", symbol: p.symbol, side: p.side, price: r.price, lots: half,
          reason: `partial +1R: banked half (+${pnl.toFixed(2)})`, exitKind: "PARTIAL",
        });
        this.think(`${p.symbol}: +1R তে অর্ধেক প্রফিট ব্যাংক করলাম (+${pnl.toFixed(2)}) — বাকিটা ট্রেইলে ছেড়ে দিলাম`, "good");
        this.emit(true);
        return true;
      }
      return false;
    } catch { return false; }
  }

  /** approx money multiplier for live P/L (contract-size aware for the majors
   *  we trade). v10: USTEC x100 PROVEN = 100 by closed deals (0.01 lots on a
   *  9.63-pt move banked +$9.63 — the old value 1 under-reported P/L by 100×:
   *  the app showed −$0.13 while MT5 bled −$26.11, the "কয়েক সেন্ট" bug).
   *  cmOf() below lets the broker's own profit field correct any symbol. */
  private contractMultiplier(symbol: string, price: number): number {
    if (symbol.startsWith("XAUUSD")) return 100;         // 100 oz per lot (proven by deals)
    if (symbol.startsWith("XAGUSD")) return 5000;
    if (symbol.startsWith("BTCUSD")) return 1;           // proven by deals
    if (symbol.startsWith("ETHUSD")) return 10;
    if (symbol.startsWith("SOLUSD")) return 100;
    if (/JPY/.test(symbol)) return 100_000 / price;      // XXXJPYm (incl. suffix) — 1 lot = 100k base,
                                                         // P/L in JPY ÷ price → USD (proven: USDJPY ~637 @157)
    if (symbol.startsWith("USOIL") || symbol.startsWith("UKOIL")) return 1000; // proven
    if (symbol.startsWith("USTEC")) return symbol.includes("x100") ? 100 : 1;  // BOTH proven by deals:
                                                         // x100 = 100 (the 100× bug), plain USTECm = 1
    // v12 (the audit's High #8): US500_x100m starts with "US500" and needs the
    // SAME x100 rule as USTEC — a flat 10 put every $-gate 10× off. Unknown
    // suffixes fall back to the plain contract size.
    if (symbol.startsWith("US500")) return symbol.includes("x100") ? 100 : 10;
    // v12: KNOWN FX majors keep the 100k contract; anything else (a typo like
    // "XAUSDm") now returns 1 instead of 100_000 — a wrong symbol can no
    // longer make P/L explode by five orders of magnitude. The broker-truth
    // calibration (cmOf) locks the real value after 3 round-trips.
    if (/^[A-Z]{6}(m|[a-z]{1,4})?$/.test(symbol)) return 100_000;   // classic FX pair (± suffix)
    return 1;                                             // unknown — conservative, never explosive
  }

  /** v10 CALIBRATED multiplier — broker truth (cmCal) beats the static guess.
   *  Every P/L computation in the brain goes through here. */
  private cmOf(symbol: string, price: number): number {
    const cal = this.cmCal.get(symbol);
    return cal && cal > 0 ? cal : this.contractMultiplier(symbol, price);
  }

  /** v10 BROKER-TRUTH P/L CALIBRATION — from the account's own CLOSED deals
   *  (race-free: entry, exit and profit are ALL broker-side numbers, unlike
   *  the first attempt which compared the broker's profit snapshot against a
   *  possibly-stale local quote — a fast gold move then produced a nonsense
   *  129.75 instead of 100). One deals scan per symbol per session; the
   *  MEDIAN implied $/point/lot over real round-trips locks when it disagrees
   *  with the static table by >2%. Needs ≥3 round-trips as evidence. */
  private async calibrateCmFromDeals(symbol: string) {
    if (this.cmCalNoted.has(symbol) || this.cmCalTried.has(symbol)) return;
    this.cmCalTried.add(symbol);
    try {
      const from = Math.floor(Date.now() / 1000) - 7 * 86400;
      const deals = await this.host.deals(from, 0);
      const byPos = new Map<number, { entry: number; exit: number; profit: number; lots: number; side: TradeSide }>();
      for (const d of deals) {
        if (d.symbol !== symbol) continue;
        const e = byPos.get(d.positionId) ?? { entry: 0, exit: 0, profit: 0, lots: 0, side: d.side };
        if (d.entry === "in") { e.entry = d.price; e.lots = d.volume; e.side = d.side; }
        if (d.entry === "out") { e.exit = d.price; e.profit += d.profit + d.commission + d.swap; }
        byPos.set(d.positionId, e);
      }
      const imps: number[] = [];
      for (const e of byPos.values()) {
        if (!e.entry || !e.exit || e.lots <= 0) continue;
        const dir = e.side === "buy" ? 1 : -1;
        const move = (e.exit - e.entry) * dir;
        if (Math.abs(move) < 1e-9 || Math.abs(e.profit) < 0.02) continue; // noise
        const imp = e.profit / (move * e.lots);
        if (Number.isFinite(imp) && imp > 0.005 && imp < 5e6) imps.push(imp);
      }
      if (imps.length < 3) return; // not enough evidence — the table value stays
      imps.sort((a, b) => a - b);
      const implied = imps[Math.floor(imps.length / 2)];
      const cur = this.cmOf(symbol, this.host.getQuote(symbol)?.mid ?? 1);
      if (Math.abs(implied - cur) / implied > 0.02) {
        this.cmCal.set(symbol, implied);
        this.cmCalNoted.add(symbol);
        this.journalLog({
          action: "info", symbol,
          reason: `P/L calibrated from ${imps.length} closed deals: 1 point × 1 lot = $${implied.toFixed(2)} (static guess was ${cur.toFixed(2)} — live P/L now exact)`,
        });
        this.think(`${symbol}: ${imps.length}টি ক্লোজ্ড ডিল থেকে P/L স্কেল ক্যালিব্রেট করলাম (1 পয়েন্ট × 1 লট = $${implied.toFixed(2)}) — এখন অ্যাপে হুবহু MT5-এর মতো ডলার দেখাবে`, "good");
      } else {
        this.cmCalNoted.add(symbol); // table confirmed by real deals — silent
      }
    } catch { /* deals unavailable — the table value stays */ }
  }

  private async closeManaged(p: TraderPosition, reason: string, exitKind?: JournalEntry["exitKind"]): Promise<{ ok: boolean; error?: string }> {
    const digits = this.host.digits(p.symbol);
    let closePrice = p.price;
    const q = this.host.getQuote(p.symbol);
    if (q) closePrice = p.side === "buy" ? q.bid : q.ask;
    try {
      // v11: the brain's close orders carry an "ai-brain" comment so the DEAL
      // HISTORY can prove WHO closed a trade (brain close vs user close).
      const closeComment = exitKind === "MANUAL" ? "close" : "ai-brain";
      let r = await this.host.closePosition(p.symbol, p.side, p.lots, closePrice, p.ticket, { digits, comment: closeComment });
      if (r.retcode === 10036) {
        // POSITION_NOT_EXISTS — live probe proved the close protocol works with a
        // fresh ticket, so this is a transient/mismatched ticket. Re-fetch the
        // broker's truth and retry ONCE with the verified ticket before giving up.
        const still = await this.findBrokerPosition(p);
        if (still) {
          const realTicket = still.order || still.id;
          if (realTicket && realTicket !== p.ticket) {
            this.journalLog({ action: "manage", symbol: p.symbol, reason: `close ticket corrected ${p.ticket}→${realTicket}` });
            this.positions.delete(p.ticket);
            p.ticket = realTicket;
            this.positions.set(realTicket, p);
          }
          const q2 = this.host.getQuote(p.symbol);
          const price2 = q2 ? (p.side === "buy" ? q2.bid : q2.ask) : closePrice;
          r = await this.host.closePosition(p.symbol, p.side, p.lots, price2, p.ticket, { digits, comment: exitKind === "MANUAL" ? "close" : "ai-brain" });
        }
      }
      if (r.retcode === 10009) {
        const pnl = (r.price - p.entry) * (p.side === "buy" ? 1 : -1) * p.lots * this.cmOf(p.symbol, p.entry);
        this.settle(p, pnl, reason, exitKind);
        return { ok: true };
      }
      if (r.retcode === 10036) { // position really gone (SL/TP/manual elsewhere)
        await this.reconcileMissing(p, reason);
        return { ok: true };
      }
      this.journalLog({ action: "error", symbol: p.symbol, reason: `close rejected: ${r.retcode} ${r.comment}` });
      return { ok: false, error: `${r.retcode} ${r.comment}` };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // ── v10.3 RECYCLE-WINDOW RETRY ── a session recycle (wedge escape /
      //    storm recovery) throws "mt5 not connected" — the Sep-30 storm
      //    error-journaled 8 closes that way. Wait briefly for the session
      //    and retry ONCE instead of giving up on a live position.
      if (/not connected/i.test(msg)) {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (this.host.connected && this.host.source === "mt5") break;
        }
        try {
          const still = await this.findBrokerPosition(p);
          if (!still) { await this.reconcileMissing(p, reason); return { ok: true }; }
          const q2 = this.host.getQuote(p.symbol);
          const price2 = q2 ? (p.side === "buy" ? q2.bid : q2.ask) : p.price;
          const r2 = await this.host.closePosition(p.symbol, p.side, p.lots, price2, p.ticket, { digits, comment: exitKind === "MANUAL" ? "close" : "ai-brain" });
          if (r2.retcode === 10009) {
            const pnl = (r2.price - p.entry) * (p.side === "buy" ? 1 : -1) * p.lots * this.cmOf(p.symbol, p.entry);
            this.settle(p, pnl, reason, exitKind);
            return { ok: true };
          }
          if (r2.retcode === 10036) { await this.reconcileMissing(p, reason); return { ok: true }; }
          this.journalLog({ action: "error", symbol: p.symbol, reason: `close rejected after retry: ${r2.retcode} ${r2.comment}` });
          return { ok: false, error: `${r2.retcode} ${r2.comment}` };
        } catch (e2) {
          this.journalLog({ action: "error", symbol: p.symbol, reason: `close threw after retry: ${(e2 as Error).message}` });
          return { ok: false, error: (e2 as Error).message };
        }
      }
      this.journalLog({ action: "error", symbol: p.symbol, reason: `close threw: ${msg}` });
      return { ok: false, error: msg };
    }
  }

  /** find the broker's live record for one of our positions (by ticket, or by identity) */
  private async findBrokerPosition(p: TraderPosition): Promise<Mt5Position | null> {
    try {
      const { positions } = await this.host.positions();
      if (!positions.length) return null;
      return (
        positions.find((bp) => (bp.order || bp.id) === p.ticket) ??
        positions.find((bp) =>
          bp.symbol === p.symbol && bp.side === p.side &&
          Math.abs(bp.lots - p.lots) < 1e-9 &&
          Math.abs(bp.openPrice - p.entry) <= Math.max(p.slDist * 0.5, p.entry * 0.002),
        ) ?? null
      );
    } catch { return null; }
  }

  private settle(p: TraderPosition, pnlFinal: number, reason: string, exitKind?: JournalEntry["exitKind"], opts?: { silent?: boolean }) {
    // IDEMPOTENT + TOMBSTONE: a ticket settles exactly once. The phantom
    // re-adopt loop (settled ticket re-adopted from a stale list → settled
    // again every 4s) once booked 1000+ fake losses in a single day.
    if (!this.positions.has(p.ticket)) return;
    this.positions.delete(p.ticket);
    this.settled.set(p.ticket, Date.now());
    this.lastSettleAt = Date.now();
    this.trailLocks.delete(p.ticket);
    // v9: refresh the account right after a close — the balance/equity strip
    // and the trend history update within a second of the trade landing
    // v16.2: the HISTORY refresh rides along (a settle is exactly when the
    // deals changed — the E2E measured history rows at 5.8s on the push
    // gate alone; at settle-time it lands in ~1s)
    setTimeout(() => {
      this.probeAccount().catch(() => {});
      this.refreshHistory().catch(() => {});
    }, 700);
    if (this.settled.size > TOMBSTONE_MAX) {
      const keys = [...this.settled.keys()].sort((a, b) => this.settled.get(a)! - this.settled.get(b)!);
      for (const k of keys.slice(0, Math.floor(keys.length / 3))) this.settled.delete(k);
    }
    this.vanish.delete(p.ticket);
    this.nextReviewAt.delete(p.ticket);
    this.aiCloseVotes.delete(p.ticket);
    // honest accounting: `bankedPnl` (partial close) was already added to
    // today.pnl at partial time — only the FINAL portion is added here.
    // The journal/memory/thought see the TRADE TOTAL (banked + final).
    // v6.1 SILENT mode: an ADOPTED position that vanished (external close on
    // a stale-listed relic) is settled for bookkeeping only — journal gets
    // an "info" line, today's counters are NEVER touched (the 09:28 storm
    // booked 83 fake closes this way).
    // v9.2 COUNTER PURITY: only BRAIN trades feed today's counters — an
    // adopted (manual) close journals loudly with its exitKind + $ but never
    // counts, exactly matching what the episodic-memory rebuild shows after
    // a restart (memorize() never records adopted trades).
    const silent = !!opts?.silent;
    const countIt = !silent && !p.adopted;
    const banked = p.bankedPnl ?? 0;
    const total = Math.round((pnlFinal + banked) * 100) / 100;
    if (countIt) {
      this.today.pnl = Math.round((this.today.pnl + pnlFinal) * 100) / 100;
      if (total >= 0) this.today.wins++; else this.today.losses++;
      const n = this.today.wins + this.today.losses;
      this.today.winPct = n ? Math.round((this.today.wins / n) * 100) : 0;
    }
    if (silent) {
      this.journalLog({
        action: "info", symbol: p.symbol, side: p.side, price: p.price, lots: p.lots,
        reason: `manual-pos settled externally (${total >= 0 ? "+" : ""}${total.toFixed(2)}) — not a brain trade, not counted`,
      });
      if (Date.now() - this.lastSilentThinkAt > 60_000) {
        this.lastSilentThinkAt = Date.now();
        this.think(`${p.symbol}: বাইরের একটি পজিশন ক্লোজ হয়েছে (${total >= 0 ? "+" : ""}${total.toFixed(2)}) — আমার ট্রেড নয়, কাউন্টারে ধরিনি`, "info");
      }
    } else {
      this.journalLog({ action: "close", symbol: p.symbol, side: p.side, price: p.price, lots: p.lots, pnl: total, reason, exitKind });
      // the follow-up thoughts the user asked for — every TP/SL hit is SAID
      // out loud, with the dollar amount
      if (exitKind === "TP") {
        this.think(`${p.symbol}: 🎯 TP HIT! +$${total.toFixed(2)} প্রফিট ব্যাংক করলাম — ${reason}`, "good");
      } else if (exitKind === "SL") {
        this.think(`${p.symbol}: SL হিট ${total.toFixed(2)} — রিস্ক যেমন ছিল তেমনই কাটা গেল, পরের সেটআপে`, "bad");
      } else {
        this.think(`${p.symbol} ক্লোজ ${total >= 0 ? "✅ +" : "🔻 "}${total.toFixed(2)} (${exitKind ?? "close"}) — ${reason}`, total >= 0 ? "good" : "bad");
      }
    }
    // ── AGENTIC: remember + reflect + learn (brain trades only) ──
    if (countIt) this.memorize(p, total, reason, exitKind);
    this.emit(true);
  }

  /** episodic memory + reflection + adaptive learning (the "agentic" core) */
  private memorize(p: TraderPosition, pnl: number, reason: string, exitKind?: JournalEntry["exitKind"]) {
    if (p.adopted) return; // we didn't open it — no entry features to learn from
    const win = pnl >= 0;
    const heldSec = Math.max(1, Math.round((Date.now() - p.openedAt) / 1000));
    // v12: candle age at ENTRY on the BROKER clock (the container clock can be
    // offset — the same bug fixed in decide()'s age gate, applied to memory)
    const brokerOffset = this.host.brokerNowSec() - Math.floor(Date.now() / 1000);
    const ageFrac = ((((p.openedAt / 1000 + brokerOffset) % 60) + 60) % 60) / 60;
    const strengthMatch = p.reason.match(/(?:lamp|⚡mom) (\d+)%/);
    const entryStrength = strengthMatch ? Number(strengthMatch[1]) / 100 : 0.5;

    this.mem.push({
      at: Date.now(), symbol: p.symbol, side: p.side, entry: p.entry, exit: p.price,
      pnl, pnlR: p.slDist > 0 ? ((p.price - p.entry) * (p.side === "buy" ? 1 : -1)) / p.slDist : 0,
      peakR: p.peakR, heldSec, exitReason: reason,
      entryStrength, atrRatio: 0, ageFrac, session: sessionOf(p.openedAt), win,
    });
    if (this.mem.length > MEMORY_MAX) this.mem.shift();

    // learn the edge (EMA win-rate + consecutive losses)
    const e = this.edge(p.symbol);
    e.n++;
    if (win) e.wins++;
    e.winRate = e.n === 1 ? (win ? 1 : 0) : e.winRate + EDGE_EMA_ALPHA * ((win ? 1 : 0) - e.winRate);
    e.consecLosses = win ? 0 : e.consecLosses + 1;
    e.adaptiveMin = this.computeAdaptiveMin(e);

    // ── reflect: write the lesson (বাংলা) ──
    const r = Math.round((this.mem[this.mem.length - 1].pnlR) * 100) / 100;
    let text: string;
    let tone: TraderLesson["tone"];
    if (win && exitKind === "TP") {
      text = `${p.symbol}: টার্গেট-হিট জয় (+$${pnl.toFixed(2)}) — $-টার্গেট স্ক্যাল্প ঠিক কাজ করছে, এভাবেই চলব`;
      tone = "good";
    } else if (win && reason.includes("flow flipped") === false && p.peakR >= 1.8) {
      text = `${p.symbol}: বড় জয় (+${pnl.toFixed(2)}, peak ${p.peakR.toFixed(1)}R) — এই ধাঁচের ফ্লো-এন্ট্রি মনে রাখলাম, আরও নেব`;
      tone = "good";
    } else if (win && p.peakR >= 1.0) {
      text = `${p.symbol}: প্রফিটেবল এক্সিট (+${pnl.toFixed(2)}) — ব্রেকইভেন+ট্রেইল ঠিক কাজ করছে`;
      tone = "good";
    } else if (win) {
      text = `${p.symbol}: ছোট জয় (+${pnl.toFixed(2)}) — এন্ট্রি ঠিক ছিল, এক্সিট একটু তাড়াতাড়ি হলো (peak ${p.peakR.toFixed(1)}R)`;
      tone = "info";
    } else if (reason.includes("flip") || reason.includes("adverse")) {
      text = `${p.symbol}: ফ্লো উল্টে গিয়ে কাট (${pnl.toFixed(2)}) — এন্ট্রির মুহূর্তটা দেরিতে ছিল নাকি? কনভিকশন ${(entryStrength * 100) | 0}% এ আরও সাবধান হব`;
      tone = "bad";
    } else if (reason.includes("time stop")) {
      text = `${p.symbol}: সময় শেষে বেরোনো (${pnl.toFixed(2)}) — ডেড টেপে ঢুকে পড়েছিলাম, টেপ-স্পিড ফিল্টার শক্ত করব`;
      tone = "warn";
    } else {
      text = `${p.symbol}: SL হিট (${pnl.toFixed(2)}, ${r}R) — স্টপ দূরত্ব ${p.slDist.toFixed(this.host.digits(p.symbol))}; এন্ট্রি কোয়ালিটি নিয়ে ভাবব`;
      tone = "bad";
    }
    this.lesson(p.symbol, text, tone);
    this.think(`📓 শিক্ষা: ${text}`, tone === "good" ? "good" : tone === "bad" ? "bad" : "info");

    if (e.consecLosses >= CONSEC_LOSS_BREAK) {
      this.think(
        `${p.symbol}: টানা ${e.consecLosses}টি লস — এই পেয়ারে কুলডাউন ×3 আর কনভিকশন গেট +৮% (শিখে গেছি)`,
        "warn",
      );
    }
    this.saveState();
  }

  /** position vanished (SL/TP/manual elsewhere) — the closing DEAL is the truth.
   *  No deal → probably still open on a wedged session → retry, never guess.
   *  v3 hardening: settle ONLY when the out-deals' total volume covers ≈ the
   *  ORIGINAL lots (lots0) — a partial's out-deal alone must never settle the
   *  whole position (the remaining half would silently drop from tracking).
   *  requireProof: ghost-checks (adopted, unmanageable) settle ONLY with deal
   *  proof — never the give-up path, so a real manual position can't be dropped. */
  private async reconcileMissing(p: TraderPosition, via: string, requireProof = false) {
    this.vanish.delete(p.ticket);
    const tries = (this.reconcileTries.get(p.ticket) ?? 0) + 1;
    try {
      const deals = await this.host.deals(Math.floor(p.openedAt / 1000) - 5, 0);
      const outs = deals.filter((d) => d.positionId === p.ticket && d.entry === "out");
      const outVol = outs.reduce((a, d) => a + d.volume, 0);
      const expected = p.lots0 || p.lots;
      if (outs.length && expected > 0 && outVol >= expected * 0.9) {
        // gross across ALL out-deals = the full trade result (partials included)
        const gross = outs.reduce((a, d) => a + d.profit + d.commission + d.swap, 0);
        const banked = p.bankedPnl ?? 0;   // already counted at partial time
        // ── v6 EXIT CLASSIFICATION — the user's #1 follow-up demand: “SL হিট
        //    হলো কি হলো না” must be answered EXPLICITLY. Exness stamps the
        //    closing deal's comment with “sl …” / “tp …”; when it doesn't,
        //    infer from the exit price vs our SL/TP levels. ──
        const lastDeal = outs[outs.length - 1];
        const dc = (lastDeal.comment ?? "").toLowerCase();
        let exitKind: JournalEntry["exitKind"];
        let kindNote: string;
        if (/(^|[^a-z])tp([^a-z]|$)|takeprofit|take profit/.test(dc)) { exitKind = "TP"; kindNote = "TP hit (server)"; }
        else if (/(^|[^a-z])sl([^a-z]|$)|stoploss|stop loss|(^|[^a-z])so([^a-z]|$)/.test(dc)) { exitKind = "SL"; kindNote = "SL hit (server)"; }
        else {
          const tol = Math.max(p.slDist * 0.3, p.entry * 0.0004);
          const hitSl = p.sl > 0 && (p.side === "buy" ? lastDeal.price <= p.sl + tol : lastDeal.price >= p.sl - tol);
          const hitTp = p.tp > 0 && (p.side === "buy" ? lastDeal.price >= p.tp - tol : lastDeal.price <= p.tp + tol);
          if (hitTp) { exitKind = "TP"; kindNote = "TP hit (price)"; }
          else if (hitSl) { exitKind = "SL"; kindNote = "SL hit (price)"; }
          else { exitKind = "MANUAL"; kindNote = "closed externally"; }
        }
        this.reconcileTries.delete(p.ticket);
        // v9.2: adopted closes are LOUD (the user must SEE the SL/TP hit on
        // their manual trade — exitKind + $ journaled) but never counted
        // (counter purity, matches the memory rebuild). Only ghost-check
        // relics settle silent.
        const silent = p.adopted && via === "ghost-check";
        this.settle(p, gross - banked, `${via} · ${kindNote} @ ${lastDeal.price}`, exitKind, { silent });
        return;
      }
      // no full-volume closing deal — the position is likely STILL OPEN (suspect
      // sync data). Keep watching it; give up tracking after 6 tries.
      this.reconcileTries.set(p.ticket, tries);
      if (!requireProof && tries >= 6) {
        this.settle(p, 0, `${via} · close deal not found after ${tries} checks (P/L unknown)`);
      } else if (tries === 1) {
        this.think(`${p.symbol} sync-এ মিসিং কিন্তু ক্লোজ-ডিলও নেই — সত্য যাচাই চলছে (${tries}/৬)`, "warn");
      }
    } catch {
      this.reconcileTries.set(p.ticket, tries);
      if (!requireProof && tries >= 6) this.settle(p, 0, `${via} · deals unavailable (P/L unknown)`);
    }
  }

  /** v10.3 — single funnel for every sync-triggered session recycle.
   *  THE LIVELOCK: a wrong tombstone (a live position falsely settled during
   *  a wedged session) makes the broker list look "stale" on EVERY sync →
   *  recycle → reconnect → same list → recycle… forever (79 recycles in one
   *  storm, quotes flapping real→[sim], in-flight closes throwing "not
   *  connected"). Two armors here: (1) STORM BREAKER — max 4 recycles per
   *  4 minutes, then back off (monitoring continues; a suppressed recycle is
   *  strictly better than burning the session every 15 s); (2) COUNTER
   *  HYGIENE — emptySyncs/flatWedgeHits/staleListHits are per-session state
   *  and must never carry across a recycle (a carried emptySyncs ≥ 15 can
   *  never re-fire the === 15 escape, and carried hits re-trigger instantly). */
  private requestRecycle(why: string, tickets: number[] = []): void {
    const now = Date.now();
    this.recycleTimes = this.recycleTimes.filter((t) => now - t < 240_000);
    if (this.recycleTimes.length >= 4) {
      if (this.recycleTimes.length === 4) {
        this.recycleTimes.push(now); // fires the note exactly once per storm
        this.think("⚠️ সেশন রিসাইকল-ঝড় ধরা পড়েছে — ৪ মিনিট ব্যাক-অফ নিচ্ছি, মনিটরিং চালু থাকছে", "warn");
        this.journalLog({ action: "info", symbol: "", reason: `session-recycle storm (${why}) — backing off 4 min, monitoring continues` });
      }
      return;
    }
    this.recycleTimes.push(now);
    this.emptySyncs = 0;       // per-session counters — reset on recycle
    this.flatWedgeHits = 0;
    this.staleListHits = 0;
    if (tickets.length) {
      for (const t of tickets) this.staleTicketRecycles.set(t, (this.staleTicketRecycles.get(t) ?? 0) + 1);
      if (this.staleTicketRecycles.size > 60) this.staleTicketRecycles.clear(); // cap the memory
    }
    try { this.host.recycleSession(); } catch { /* host handles */ }
  }

  // ═══════════════ v16 EVENT-FIRST MIRROR ═══════════════
  /** The broker itself just said "something changed on the account" (cmd 14
   *  / 19 / 22 — a trade from ANY connection: this app, the user's MT5
   *  terminal, the server's own SL/TP execution, a deposit). This is the
   *  path the old app never had — it polled and waited instead.
   *  Order of operations: (1) targeted instant close-check — a cmd-19 naming
   *  a KNOWN position with a tp/sl/so/close comment goes straight to the
   *  deal-proof reconcile (no vanish streak, no 30s age gate); (2) a
   *  coalesced full re-sync (positions + pendings + account + history).
   *  Bursts coalesce at 180ms — a close lands as 19+22+14 within a few ms
   *  and must trigger ONE mirror pass, not three. */
  private onBrokerPush(ev: BrokerPush) {
    if (!this.host.connected || this.host.source !== "mt5") return;
    const now = Date.now();
    this.lastBrokerPushAt = now;
    // ── (1) targeted instant paths. VERIFIED LIVE (Oct-01): the broker's
    //    cmd-4 position list on an established session is a LOGIN-TIME
    //    SNAPSHOT — positions opened after login NEVER appear in it (a
    //    fresh connection sees them instantly; cmd-5 deals are live too).
    //    So the sync mirror alone can adopt nothing new — the PUSH + the
    //    DEALS are the truth. Every cmd-19 (retcode 10009) naming a
    //    position gets dealt with RIGHT HERE:
    //      · UNTRACKED position → adopt it from its opening deal (~300ms)
    //      · TRACKED position → deal-proof reconcile (a close from ANY
    //        source — phone MT5, server SL/TP, another terminal — settles
    //        with its TP/SL badge immediately; a modify harmlessly
    //        re-verifies) ──
    if (ev.kind === "trade" && ev.positionId && ev.retcode === 10009) {
      const pid = ev.positionId;
      const tracked = this.positions.get(pid);
      const lastAt = this.pushReconcileAt.get(pid) ?? 0;
      if (now - lastAt > 1_000) { // per-position 1s gate — modify bursts stay cheap
        this.pushReconcileAt.set(pid, now);
        if (tracked) {
          if (now - tracked.openedAt >= 3_000) { // give a just-opened ticket a breath
            this.reconcileMissing(tracked, "cmd19 push", true).catch(() => {});
          }
        } else if (!this.settled.has(pid)) {
          this.adoptFromDeal(pid).catch(() => {});
        }
      }
    }
    // ── (2) coalesced full re-sync ──
    if (now - this.pushSyncAt < 180) return;
    this.pushSyncAt = now;
    this.syncPositions("push").catch(() => {});
    this.probeAccount().catch(() => {});   // balance/equity at push latency
    // v16.1: history refresh on push is GATED at 2s — cmd-5 requests share
    // one FIFO queue, and an ungated 24h-deals fetch per push starved the
    // zombie pre-check behind it (new-position adoption fell past 12s).
    // A close still lands in history within ~2s — vs the old 5s cadence.
    if (now - this.historyAt > 2_000) {
      this.historyAt = now;
      this.refreshHistory().catch(() => {});
    }
  }

  /** v16.2 PUSH-DRIVEN ADOPTION — bypass the frozen cmd-4 snapshot: the
   *  DEALS (cmd-5) are live, so a position the broker just told us about
   *  (cmd-19, any connection — this app, the phone MT5 terminal, another
   *  terminal) is adopted from its OPENING DEAL at push latency. SL/TP are
   * unknown from the deal — the next honest cmd-4 that lists the position
   * fills them (the refresh branch). */
  private async adoptFromDeal(positionId: number) {
    try {
      const deals = await this.host.deals(Math.floor(Date.now() / 1000) - 900, 0);
      const inn = deals.find((d) => d.positionId === positionId && d.entry === "in");
      if (!inn) return;                       // no opening deal in 15min — stale echo, ignore
      if (this.positions.has(positionId) || this.settled.has(positionId)) return; // raced the sync
      const outs = deals.filter((d) => d.positionId === positionId && d.entry === "out");
      const outVol = outs.reduce((a, d) => a + d.volume, 0);
      if (inn.volume > 0 && outVol >= inn.volume * 0.9) return; // already fully closed — nothing to adopt
      const slDist = 0; // deals carry no SL — filled by the next sync that lists it
      this.positions.set(positionId, {
        ticket: positionId, symbol: inn.symbol, side: inn.side, lots: inn.volume,
        lots0: inn.volume,
        // inn.time is MILLISECONDS-epoch UTC (the deals parser emits ms —
        // verified live). Multiplying by 1000 once put openedAt in the year
        // 58719: every age gate went negative and the close reconcile's
        // deals window came back empty forever (the E2E catch).
        entry: inn.price, sl: 0, tp: 0, openedAt: inn.time,
        reason: "adopted (broker push)", price: inn.price, pnl: 0, pnlR: 0,
        slDist, peakR: 0, beMoved: false, partialDone: false, adopted: true, origin: "manual", bankedPnl: 0,
      });
      this.nextReviewAt.set(positionId, Date.now() + REVIEW_FIRST_MS);
      this.aiCloseVotes.set(positionId, 0);
      this.vanish.delete(positionId);
      this.think(`${inn.symbol} পজিশন অ্যাডপ্ট (পুশ-ট্রিগার্ড, ${inn.side} ${inn.volume} @ ${inn.price}) — cmd-4 ল্যাগ বাইপাস`, "info");
      this.journalLog({ action: "info", symbol: inn.symbol, reason: `adopted ${inn.side} ${inn.volume} @ ${inn.price} (push-driven — cmd-4 login-snapshot lag bypassed)` });
      this.emit(true);
    } catch { /* deals unavailable — the 500ms sync adopts it if/when cmd-4 catches up */ }
  }

  /** broker truth-sync: adopt positions we don't know, drop gone ones (phantom-proof).
   *  v16: trigger="push" when a broker push kicked this sync off — the
   *  deliberate waiting (vanish streaks, 30s age gate, empty-list counters)
   *  was armor against PUSH-SILENT lies (wedged lists); when the broker
   *  itself just spoke, absence from the list is real evidence and the
   *  deal-proof reconcile runs immediately. Settling still REQUIRES the
   *  broker's own closing deal (requireProof) on every push path. */
  private async syncPositions(trigger: "poll" | "push" = "poll") {
    if (!this.host.connected || this.host.source !== "mt5") return;
    if (this.syncBusy) {
      // v16: a push-triggered sync is QUEUED, never dropped — the broker's
      // state changed while the previous snapshot was in flight, so that
      // snapshot is already outdated. Polls still back off (v10 semantics).
      if (trigger === "push") this.syncQueued = "push";
      return; // v10: cadence — never overlap syncs
    }
    this.syncBusy = true;
    try {
      const { positions, orders } = await this.host.positions();
      const live = new Set<number>();
      const now = Date.now();
      this.syncErrStreak = 0;
      this.lastSyncOkAt = now;
      // EMPTY-LIST GUARD: a wedged session can return an empty position list
      // while positions are truly open (the Sep-29 phantom-close incident).
      // An empty list proves NOTHING — only a non-empty list can prove absence.
      const emptyList = positions.length === 0;
      // v16: a broker push landed within the last 4s (or triggered this very
      // sync) — the empty list / missing rows are then the EXPECTED aftermath
      // of real closes, not wedge symptoms. The waiting armors stand down;
      // the DEAL-PROOF armor does not (requireProof on every settle path).
      const pushRecent = trigger === "push" || (now - this.lastBrokerPushAt < 4_000);
      // ── v11 PENDING-ORDERS MIRROR — every limit/stop order on the account
      //    (opened in MT5 by hand or from this app) is reflected in the state
      //    on EVERY sync (500ms). Disappearances journal WHY (filled → the
      //    position appears via adoption; canceled → noted). ──
      const prevPendings = new Map(this.pendingOrders.map((o) => [o.ticket, o]));
      this.pendingOrders = orders.map((o) => ({
        ticket: o.ticket, symbol: o.symbol, orderType: o.orderType,
        orderTypeName: ORDER_TYPE_NAMES[o.orderType] ?? `TYPE ${o.orderType}`,
        lots: o.lots, price: o.price, sl: o.sl, tp: o.tp,
        priceCurrent: o.priceCurrent, timeSetup: o.timeSetup, comment: o.comment,
      }));
      for (const [ticket, prev] of prevPendings) {
        if (this.pendingOrders.some((o) => o.ticket === ticket)) continue;
        // gone from the broker's pending list — why?
        if (positions.some((p) => (p.order || p.id) === ticket)) {
          this.journalLog({ action: "info", symbol: prev.symbol, reason: `pending order #${ticket} FILLED → position opened (${prev.orderTypeName} @ ${prev.price})` });
          this.think(`📌 ${prev.symbol} পেন্ডিং অর্ডার ফিল হয়েছে (${prev.orderTypeName} @ ${prev.price}) — পজিশন ওপেন`, "info");
        } else {
          this.journalLog({ action: "info", symbol: prev.symbol, reason: `pending order #${ticket} gone (${prev.orderTypeName} @ ${prev.price}) — canceled/expired` });
        }
      }
      if (this.pendingOrders.length !== orders.length || this.pendingOrders.some((o, i) => orders[i] && o.ticket !== orders[i].ticket)) {
        this.emit(true);
      }
      // the whole list is clean of settled tickets → reset the stale counter
      let anySettled = false;
      for (const bp of positions) {
        if (this.settled.has(bp.order || bp.id)) { anySettled = true; break; }
      }
      if (!anySettled) this.staleListHits = 0;
      for (const bp of positions) {
        // position id (Exness fills trade_order=0 in this record — use the id)
        const key = bp.order || bp.id;
        live.add(key);
        // ══ PHANTOM ARMOR (v5) ══ — a settled ticket can NEVER come back. If
        // the broker lists one, the cmd-4 list is STALE (wedged session), not
        // a real position: skip it, count the stale hit, recycle on repeat.
        if (this.settled.has(key)) {
          this.staleListHits++;
          if (this.staleListHits === 1) {
            this.think(`⚠️ sync একটি সেটেল-হওয়া টিকিট (#${key}) দেখাচ্ছে — লিস্ট পুরোনো হতে পারে, রি-অ্যাডপ্ট করছি না`, "warn");
          }
          // ══ v10.3 TOMBSTONE SELF-HEAL — the livelock core ══
          // If the SAME ticket is listed again AFTER a recycle, the list is
          // probably NOT stale — OUR TOMBSTONE is wrong (a live position
          // falsely settled during a wedged session, e.g. by a garbage deals
          // window). Verify against the deal history: still-open (in-volume
          // > out-volume) → un-settle, persist, and let the next sync adopt
          // the live position again. Without this the armor itself becomes
          // an infinite recycle loop (the Sep-30 storm: 79 recycles).
          const seen = (this.staleTicketRecycles.get(key) ?? 0) + 1;
          this.staleTicketRecycles.set(key, seen);
          if (seen === 2 || (seen > 2 && seen % 10 === 0)) { // first check + backoff retry if deals were unavailable
            let inVol = 0, outVol = 0, healed = false;
            try {
              const dh = await this.host.deals(Math.floor(now / 1000) - 86400, 0);
              for (const d of dh) {
                if (d.positionId !== key) continue;
                if (d.entry === "in") inVol += d.volume;
                else if (d.entry === "out") outVol += d.volume;
              }
              healed = inVol > 0 && outVol < inVol * 0.9; // deals prove it is STILL OPEN
            } catch { /* deals unavailable — keep the tombstone, storm breaker caps the damage */ }
            if (healed) {
              this.settled.delete(key);
              this.staleTicketRecycles.delete(key);
              this.staleListHits = 0;
              this.think(`🔄 #${key} আসলে এখনও খোলা (ডিল: ইন ${inVol.toFixed(2)} / আউট ${outVol.toFixed(2)}) — ভুল টম্বস্টোন সরালাম, আবার ট্র্যাক করছি`, "good");
              this.journalLog({ action: "info", symbol: bp.symbol, reason: `tombstone #${key} was WRONG (deals: in ${inVol.toFixed(2)} > out ${outVol.toFixed(2)}) — un-settled, re-tracking live position` });
              continue; // next sync re-adopts it through the normal path
            }
          }
          if (this.staleListHits >= STALE_LIST_RECYCLE) {
            this.staleListHits = 0;
            this.think("⚠️ ব্রোকার পজিশন-লিস্ট বারবার পুরোনো দেখাচ্ছে — সেশন রিসাইকল করছি (ফ্যান্টম লুপ আর্মার)", "warn");
            this.requestRecycle("stale cmd-4 list", [key]);
          }
          continue;
        }
        this.vanish.delete(key);
        this.reconcileTries.delete(key); // it's back — restore a clean slate for its next close
        if (!this.positions.has(key)) {
          // ══ v6.1 ZOMBIE PRE-CHECK ══ — a wedged cmd-4 keeps listing
          // positions that are ALREADY CLOSED on the server (the 09:28 storm:
          // 83 phantom closes in one burst). An unknown position whose deals
          // show a full out-volume is a stale-list relic: tombstone it
          // silently, NEVER adopt, and count the stale hit — the list itself
          // is provably old, so recycle the session on repeat.
          // v16.1: a position YOUNGER than 60s skips the check — a relic is
          // by definition OLD, and the check's cmd-5 deals query serializes
          // behind every other cmd-5 (a 24h history fetch made fresh manual
          // positions wait 12s+ to adopt — the exact latency this version
          // exists to kill). Young = adopt NOW.
          let zombie = false;
          if (now - (bp.openTime || now) >= 60_000) {
            try {
              const dz = await this.host.deals(Math.floor((bp.openTime || now) / 1000) - 5, 0);
              const outz = dz.filter((d) => d.positionId === key && d.entry === "out");
              const volz = outz.reduce((a, d) => a + d.volume, 0);
              zombie = outz.length > 0 && bp.lots > 0 && volz >= bp.lots * 0.9;
            } catch { /* deals unavailable — fall through to normal adoption */ }
          }
          if (zombie) {
            this.settled.set(key, now);
            this.staleListHits++;
            if (this.staleListHits <= 3 || this.staleListHits % 10 === 1) {
              this.think(`⚠️ sync এ বন্ধ-হয়ে-যাওয়া পুরোনো পজিশন (#${key}) দেখাচ্ছে — লিস্ট পুরোনো, অ্যাডপ্ট করছি না`, "warn");
            }
            if (this.staleListHits >= STALE_LIST_RECYCLE) {
              this.staleListHits = 0;
              this.think("⚠️ ব্রোকার পজিশন-লিস্ট বারবার পুরোনো দেখাচ্ছে — সেশন রিসাইকল করছি (ফ্যান্টম-স্টর্ম আর্মার)", "warn");
              this.requestRecycle("stale cmd-4 list (zombie relic)", [key]);
            }
            continue;
          }
          // adopted (opened before restart / by hand) — brain watches it too
          const slDist = bp.sl > 0
            ? Math.abs(bp.openPrice - bp.sl)
            : (bp.tp > 0 ? Math.abs(bp.tp - bp.openPrice) / 2 : 0);
          this.positions.set(key, {
            ticket: key, symbol: bp.symbol, side: bp.side, lots: bp.lots,
            lots0: bp.lots,
            entry: bp.openPrice, sl: bp.sl, tp: bp.tp, openedAt: bp.openTime || now,
            reason: "adopted (existing position)", price: bp.openPrice, pnl: bp.profit, pnlR: 0,
            slDist, peakR: 0, beMoved: bp.sl > 0 && Math.abs(bp.sl - bp.openPrice) < 1e-9,
            partialDone: false, adopted: true, origin: "manual", bankedPnl: 0,
          });
          this.nextReviewAt.set(key, now + REVIEW_FIRST_MS);
          this.aiCloseVotes.set(key, 0);
          this.calibrateCmFromDeals(bp.symbol).catch(() => {}); // v10: lock the symbol's true $-scale from its closed deals
          this.think(`${bp.symbol} পজিশন অ্যাডপ্ট করা হলো (${bp.side} ${bp.lots}) — নজরদারি শুরু`, "info");
          this.journalLog({ action: "info", symbol: bp.symbol, reason: `adopted ${bp.side} ${bp.lots} @ ${bp.openPrice}` });
          this.emit(true);
        } else {
          // refresh broker-side SL/TP (manual edits respected)
          const mine = this.positions.get(key)!;
          if (bp.sl > 0) mine.sl = bp.sl;
          if (bp.tp > 0) mine.tp = bp.tp;
          mine.lots = bp.lots;
          mine.pnl = bp.profit;        // the broker's own P/L — exactly what MT5 shows
          this.calibrateCmFromDeals(bp.symbol).catch(() => {}); // v10: keep the symbol's $-scale locked to broker truth
        }
      }
      // history refresh (15s cadence — v16.2: was 5s. Deals (cmd-5) share
      // one FIFO response order at the broker; the poll's 24h fetches were
      // queue-jamming the small push-time queries (adoption once measured
      // 4.9s behind one). Real events are covered at push latency: the push
      // gate (2s) + the settle-time refresh; this poll is only a safety net
      // for missed pushes.)
      if (Date.now() - this.historyAt > 15_000) {
        this.historyAt = Date.now();
        this.refreshHistory().catch(() => {});
      }
      if (emptyList && this.positions.size > 0 && pushRecent) {
        // ══ v16 PUSH-EXPLAINED EMPTY LIST ══ the broker JUST pushed a trade
        // event and now the position list is empty — that is the EXPECTED
        // aftermath of "everything closed", not a wedge. Prove each tracked
        // position against the deal history immediately (no 3-empty-sync
        // wait; a 3s fresh-open grace replaces the 15s poll-mode one — a
        // just-opened position CAN legitimately hit SL within seconds and
        // the app must show that close, not 30 seconds of fake live P/L).
        // Deal-proof still REQUIRED — this is not the old phantom path.
        for (const p of [...this.positions.values()]) {
          if (now - p.openedAt < 3_000) continue;
          if ((this.reconcileTries.get(p.ticket) ?? 0) >= 12) continue;
          await this.reconcileMissing(p, "push-empty proof", true);
        }
      } else if (emptyList && this.positions.size > 0) {
        this.emptySyncs = (this.emptySyncs ?? 0) + 1;
        if (this.emptySyncs === 2) {
          this.think("⚠️ ব্রোকার sync খালি তালিকা দিচ্ছে কিন্তু আমার পজিশন আছে — ডেটা সন্দেহজনক, কিছু বন্ধ করছি না", "warn");
        }
        if (this.emptySyncs >= 8 && this.emptySyncs % 8 === 0) {
          // ~8s of consistently-empty lists while holding positions → the
          // session is wedged for cmd-4. Quotes still flow, deals still work:
          // keep monitoring but keep logging.
          console.error(`[trader] sync returned empty list ${this.emptySyncs}× while tracking ${this.positions.size} positions — session may be wedged for cmd-4`);
        }
        // WEDGE ESCAPE: 15 consecutive empty syncs (~15s at the 1s cadence)
        // while tracking positions = the cmd-4 waiter chain is corrupted.
        // Quotes can't fix that — recycle the whole MT5 session (fresh socket
        // = fresh waiters). v10.3: re-armed every 15 syncs (not just === 15)
        // and funneled through the storm breaker.
        if (this.emptySyncs >= 15 && this.emptySyncs % 15 === 0) {
          this.think("⚠️ ব্রোকার sync আটকে গেছে (~১৫ সেকেন্ড খালি তালিকা) — সেশন রিসাইকল করছি", "warn");
          this.requestRecycle("empty-list wedge");
        }
        // ══ v10.1 EMPTY-LIST DEAL-PROOF — the backtest caught this: when the
        //    account's ONLY position closes on the MT5 side (SL/TP/manual),
        //    the broker list goes EMPTY and the old guard skipped the
        //    reconcile forever — the app kept showing the closed position
        //    with a fake live P/L ("অ্যাপ দেখাচ্ছে মাত্র কয়েক সেন্ট" — a dead
        //    position's cents). An empty list proves nothing about CLOSURE
        //    either — but the DEALS do: after 3 consecutive empty syncs,
        //    every tracked ticket is checked against the deal history, and a
        //    full out-volume settles it with the broker's own truth. ══
        if (this.emptySyncs >= 3 && this.emptySyncs % 3 === 0) {
          for (const p of [...this.positions.values()]) {
            if (now - p.openedAt < 15_000) continue;                          // give a fresh open a moment
            if ((this.reconcileTries.get(p.ticket) ?? 0) >= 12) continue;     // checked enough — keep watching
            await this.reconcileMissing(p, "empty-list proof", true);         // settle ONLY with deal proof
          }
        }
      } else if (emptyList && this.positions.size === 0) {
        // ══ v9.1 FLAT-ACCOUNT WEDGE DETECTOR — the Sep-29 failure mode in
        //    disguise: we track nothing, the broker lists nothing, yet a
        //    DEALS scan can PROVE an open position exists on this login
        //    (in-volume > out-volume — opened from another terminal; note
        //    this account reports equity=0 on this protocol, so equity≠balance
        //    is NOT a usable signal). An empty cmd-4 list then is a WEDGE,
        //    not truth — the app must never go blind on the user's manual
        //    trades. Two consecutive suspicious scans (~16s) → recycle. ══
        if (now - this.lastFlatDealsCheck > 8_000) {
          this.lastFlatDealsCheck = now;
          let suspicious = false;
          try {
            const deals = await this.host.deals(Math.floor(now / 1000) - 3 * 3600, 0);
            const vol = new Map<number, number>();
            for (const d of deals) {
              if (!d.positionId) continue;
              const delta = d.entry === "in" ? d.volume : d.entry === "out" ? -d.volume : 0;
              if (delta) vol.set(d.positionId, (vol.get(d.positionId) ?? 0) + delta);
            }
            suspicious = [...vol.values()].some((v) => v > 1e-9);
          } catch { /* deals unavailable — try again next window */ }
          if (suspicious) {
            this.flatWedgeHits++;
            if (this.flatWedgeHits === 1) {
              this.think("⚠️ ব্রোকার পজিশন-লিস্ট খালি দেখাচ্ছে কিন্তু ডিল-হিস্ট্রিতে ওপেন পজিশন আছে — লিস্টটা সন্দেহজনক", "warn");
            }
            if (this.flatWedgeHits >= 2) {
              this.flatWedgeHits = 0;
              this.think("⚠️ খালি লিস্ট কিন্তু ডিল-প্রমাণ ওপেন পজিশন — সেশন রিসাইকল করছি (অন্ধ হয়ে যাওয়া থেকে বাঁচতে)", "warn");
              this.requestRecycle("flat-account wedge");
            }
          } else {
            this.flatWedgeHits = 0;
          }
        }
      } else {
        this.emptySyncs = 0;
      }
      // GHOST-CHECK: adopted but UNMANAGEABLE relics (no SL → no risk unit →
      // monitor skips them) are live grenades. When the broker does NOT list
      // one, verify its truth against the deals history (every 3rd sync, up to
      // 12 tries): deal-proof of closure settles + tombstones it; no proof →
      // it stays watched (a real manual position is never dropped).
      for (const p of [...this.positions.values()]) {
        if (!p.adopted || p.slDist > 0) continue;
        if (now - p.openedAt < 120_000) continue;            // give it 2 min
        if (positions.some((bp) => (bp.order || bp.id) === p.ticket)) continue; // broker lists it — wait
        const tries = (this.reconcileTries.get(p.ticket) ?? 0);
        if (tries >= 12) continue;                           // checked enough — keep watching
        // v16.1: fire-and-forget — an awaited ghost-check cmd-5 once blocked
        // every sync pass and starved adoption behind it
        if (tries % 3 === 0) this.reconcileMissing(p, "ghost-check", true).catch(() => {});
      }
      for (const p of [...this.positions.values()]) {
        if (live.has(p.ticket)) continue;
        if (emptyList) continue; // no evidence — keep watching (quotes still mark price)
        const streak = (this.vanish.get(p.ticket) ?? 0) + 1;
        const age = now - p.openedAt;
        if (pushRecent) {
          // ── v16 PUSH-TRIGGERED CLOSE PATH: the broker said something
          //    changed and this position is no longer in the broker's list.
          //    The old 2-streak + 30s-age gate existed to survive push-silent
          //    wedged lists lying to us; when the broker itself just spoke,
          //    the absence is real evidence. reconcile with requireProof:
          //    the closing DEAL must confirm — no deal → keep watching
          //    (armor intact), deal → settle + TP/SL badge + emit(true) now. ──
          this.vanish.delete(p.ticket);
          await this.reconcileMissing(p, "broker-push", true);
        } else if (streak >= 2 && age > 30_000) {
          // ── ANTI-PHANTOM (poll-only): require 2 consecutive missing syncs AND age > 30s
          this.vanish.delete(p.ticket);
          await this.reconcileMissing(p, "sync");
        } else {
          this.vanish.set(p.ticket, streak);
          if (streak === 1 && age > 12_000) {
            this.think(`${p.symbol} একবার sync-এ দেখা যায়নি — আবার যাচাই করছি (ভুল ক্লোজ নয়)`, "warn");
          }
        }
      }
    } catch (e) {
      // ── v11 CMD-4 WEDGE ESCAPE ── positions() itself failed (timeout /
      //    dead waiter chain). The OLD code just logged — the sync stayed
      //    dead for HOURS while quotes flowed (the "burning positions in the
      //    app that are closed on MT5" bug). Now: (a) the DEALS still work on
      //    a cmd-4-wedged session (proven live) → sweep every tracked
      //    position against the deal history and settle anything the broker
      //    has already closed; (b) persistent errors recycle the session
      //    (through the storm breaker).
      this.syncErrStreak++;
      console.error(`[trader] syncPositions error (#${this.syncErrStreak}):`, (e as Error)?.message ?? e);
      if (this.syncErrStreak >= 3) {
        this.requestRecycle("cmd-4 timing out");
      }
      if (this.syncErrStreak >= 2 && Date.now() - (this.lastDealsSweepAt ?? 0) > 3_000) {
        this.lastDealsSweepAt = Date.now();
        this.dealsTruthSweep().catch(() => {});
      }
    } finally {
      this.syncBusy = false;
      // v16.2 PERIODIC DEALS-TRUTH SWEEP: on a session whose cmd-4 list is
      // frozen (login-time snapshot — VERIFIED LIVE on Exness), a close that
      // produced NO cmd-19 push (missed during a reconnect window) would
      // never leave the frozen list and the position would show open
      // forever. Every ~30s of syncs, settle anything the DEALS prove
      // closed (requireProof — the armor is not negotiable).
      this.syncCount++;
      if (this.positions.size > 0 && this.syncCount % 60 === 0) {
        this.dealsTruthSweep().catch(() => {});
      }
      // v16: a push arrived while this sync was running — its state change
      // was newer than the snapshot we just processed; run one more pass so
      // it is never dropped (the 180ms coalesce in onBrokerPush bounds the
      // re-run rate)
      if (this.syncQueued) {
        const t = this.syncQueued;
        this.syncQueued = null;
        setTimeout(() => { this.syncPositions(t).catch(() => {}); }, 30);
      }
    }
  }

  /** v11 — cmd-4-INDEPENDENT position truth: settle every tracked position
   *  the DEAL HISTORY proves closed (full out-volume). Works while the
   *  positions list command is wedged (quotes + deals keep flowing) — this
   *  is the path that would have settled the Sep-30 "burning positions"
   *  within seconds instead of hours. */
  private async dealsTruthSweep() {
    if (!this.host.connected || this.host.source !== "mt5") return;
    for (const p of [...this.positions.values()]) {
      if (Date.now() - p.openedAt < 15_000) continue;       // give a fresh open a moment
      try {
        await this.reconcileMissing(p, "deals-sweep", true); // settle ONLY with deal proof
      } catch { /* deals hiccup — next sweep retries */ }
    }
  }

  /** v11 — rebuild the closed-trades history from the broker's deal history
   *  (24h window): every position that opened AND fully closed, with $ P/L,
   *  exit classification and WHO opened it (ai-brain comment = the brain). */
  private async refreshHistory() {
    try {
      const from = Math.floor(Date.now() / 1000) - 24 * 3600;
      const deals = await this.host.deals(from, 0);
      const byPos = new Map<number, TraderHistoryEntry>();
      for (const d of deals) {
        if (!d.positionId) continue;
        let e = byPos.get(d.positionId);
        if (!e) {
          e = {
            positionId: d.positionId, symbol: d.symbol, side: d.side,
            origin: "manual", lots: 0, entry: 0, exit: 0, pnl: 0,
            openedAt: d.time, closedAt: d.time,
            exitKind: "MANUAL", comment: "",
          };
          byPos.set(d.positionId, e);
        }
        if (d.entry === "in") {
          e.side = d.side; e.entry = d.price; e.openedAt = d.time;
          e.lots = Math.max(e.lots, d.volume);
          if (/ai-brain/i.test(d.comment)) e.origin = "brain";
        } else if (d.entry === "out") {
          e.exit = d.price; e.closedAt = d.time;
          e.pnl += d.profit + d.commission + d.swap;
          e.lots = Math.max(e.lots, d.volume);
          const c = (d.comment ?? "").toLowerCase();
          if (/(^|[^a-z])tp([^a-z]|$)|takeprofit/.test(c)) e.exitKind = "TP";
          else if (/(^|[^a-z])sl([^a-z]|$)|stoploss|(^|[^a-z])so([^a-z]|$)/.test(c)) e.exitKind = "SL";
          else if (/ai-brain/i.test(c)) e.exitKind = "AI";   // the brain closed it (comment we stamp)
          else if (/close/.test(c)) e.exitKind = "MANUAL";
          if (d.comment) e.comment = d.comment;
        }
      }
      // only COMPLETE round-trips, newest first, capped
      this.recentHistory = [...byPos.values()]
        .filter((e) => e.entry > 0 && e.exit > 0)
        .sort((a, b) => b.closedAt - a.closedAt)
        .slice(0, 30);
    } catch { /* deals unavailable — keep the last good history */ }
  }

  private checkDailyLimits() {
    if (!this.cfg.enabled || this.haltedToday || this.acct == null) return;
    // v10: maxDailyTrades = 0 → UNLIMITED — no count-based halt at all
    if (this.cfg.maxDailyTrades > 0 && this.today.trades >= this.cfg.maxDailyTrades) {
      this.haltedToday = true;
      this.haltReason = `max daily trades (${this.cfg.maxDailyTrades})`;
      this.journalLog({ action: "halt", symbol: "", reason: this.haltReason });
      this.think(`⏸ আজকের ট্রেড লিমিট (${this.cfg.maxDailyTrades}) — আগামান কাল`, "warn");
      this.emit(true);
      return;
    }
    if (this.dayStartEquity) {
      // v12 LIVE EQUITY (the audit's Medium #18): the probe account snapshot
      // can lag seconds behind — when positions are open, compute equity as
      // balance + Σ floating P/L (monitor() refreshes p.pnl from live quotes
      // every beat), and use the WORST of probe/live so a fast bleed can't
      // hide behind a stale probe.
      let equity = this.acct.equity;
      if (this.positions.size > 0) {
        let floating = 0;
        for (const p of this.positions.values()) floating += p.pnl;
        const live = this.acct.balance + floating;
        if (live > 0 && this.acct.balance > 0) equity = Math.min(equity, live);
      }
      if (equity > 0) {
        const lossPct = ((this.dayStartEquity - equity) / this.dayStartEquity) * 100;
        if (lossPct >= this.cfg.dailyLossLimitPct) {
          this.haltedToday = true;
          this.haltReason = `daily loss limit −${lossPct.toFixed(1)}% (cap ${this.cfg.dailyLossLimitPct}%)`;
          this.journalLog({ action: "halt", symbol: "", reason: this.haltReason });
          this.think(`⏸ ডেইলি লস লিমিট ছুঁয়েছে (−${lossPct.toFixed(1)}%) — আজ আর নতুন এন্ট্রি নেই`, "bad");
          this.emit(true);
          // v12: the halt also FLATTENS the brain's own positions — the audit:
          // "halt only blocks new entries; open positions keep bleeding".
          // The USER's manual positions are respected; only origin=brain
          // positions are cut, best-effort (a failed close retries next beat
          // via monitor's own guards).
          void (async () => {
            for (const p of [...this.positions.values()]) {
              if (p.origin === "brain") {
                try {
                  await this.closeManaged(p, `daily loss halt — flatten brain position`, "AI");
                } catch { /* monitor retries */ }
              }
            }
          })();
        }
      }
    }
  }
}
