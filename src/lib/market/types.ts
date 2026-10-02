/** Shared market/data types across engine, API and UI. */

export interface Candle {
  t: number; // UTC seconds (bar open)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  f?: 1; // forming bar
}

export interface SymbolQuote {
  name: string;
  digits: number;
  bid: number;
  ask: number;
  mid: number;
  change: number;
  changePct: number;
  spread: number;
  live: boolean;
  ts: number;
}

/** Running-candle order-flow (the "X-ray" scalpers read). */
export interface FlowTick { p: number; d: 1 | -1 | 0; t: number; seq: number }
export interface FlowNode { p: number; b: number; s: number }
export interface FlowPrev { t: number; dir: 1 | -1; d: number; dp: number }
export interface FlowScore {
  bullProb: number;
  verdict: "buyers" | "sellers" | "absorb_top" | "absorb_bottom" | "balanced";
  drivers: { confirm: boolean; speed: number; wick: number; closePos: number; recentPct: number };
}

/** The signal lamp — stable BUY/SELL light driven by the tick state machine. */
export interface FlowSignalEpisode { state: "buy" | "sell"; pts: number; holdMs: number; at: number; won: boolean }
export interface FlowSignal {
  state: "buy" | "sell" | "neutral";
  sinceMs: number;
  entryPrice: number;
  strength: number; // 0..1
  raw: number; // −1..1
  pnlPts: number;
  flips: number;
  quiet?: boolean; // tape asleep (< quietTps) — the UI explains WHY the lamp waits
  stats: { fired: number; won: number; winPct: number; avgPts: number; avgHoldMs: number };
  recent: FlowSignalEpisode[];
}

export interface FlowPayload {
  s: string; tf: string;
  t: number; now: number;
  o: number; h: number; l: number; c: number;
  buy: number; sell: number; flat: number;
  delta: number; deltaPct: number; recentDelta: number;
  tps: number; tpsAvg: number;
  lastTickMs: number;
  tape: FlowTick[];
  deltaHist: { t: number; d: number }[];
  /** cross-candle cumulative-delta history (each candle restarts at 0) for the
   *  2-candle delta-micro chart; attached ~every 2s — the fresh running tail
   *  always comes from deltaHist at the full emit rate */
  histDeep?: { t: number; d: number }[];
  nodes: FlowNode[];
  prev: FlowPrev[];
  score: FlowScore;
  sig: FlowSignal;
}

export interface FeedStatus {
  connected: boolean;
  /** v13: the simulator is gone — when MT5 is not connected the whole app
   *  shows a disconnected/offline state (no fake prices ever). */
  source: "mt5" | "disconnected";
  server: string;
  account: { balance: number; equity: number; currency: string } | null;
  latencyMs: number | null;
  /** broker wall-clock seconds (UTC + offsetSec). True UTC = serverTime − offsetSec.
   *  v16.3: optional — older service builds omit it; treat as 0. */
  serverTime: number;
  offsetSec?: number;
  reason: string;
}

// ═══════════════ AI auto-trader (mirrors mt5-service/src/trader.ts) ═══════════════

export type TraderRiskMode = "conservative" | "balanced" | "aggressive";

export interface TraderSymbolRule {
  symbol: string;
  enabled: boolean;
  lots: number;
  maxPositions: number;
}

export interface AiFeel {
  symbol: string;
  mood: "greedy" | "fearful" | "calm" | "excited" | "nervous" | "asleep";
  confidence: number;
  fear: number;
  greed: number;
  patience: number;
  bias: "buy" | "sell" | "none";
  momentum: number; // -1..1 — live tick momentum (last ~20s)
}

export interface TraderPosition {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  sl: number;
  tp: number;
  openedAt: number;
  reason: string;
  price: number;
  pnl: number;
  pnlR: number;
  slDist: number;
  peakR: number;
  beMoved: boolean;
  partialDone: boolean;
  adopted: boolean;
  lots0?: number;          // original lots (partials reduce `lots`)
  bankedPnl?: number;      // profit already banked by a partial close
  aiConfirmed?: boolean;   // entry confirmed by the real-AI judge
  execMs?: number;         // decision→order latency (ms)
  lampAgeMs?: number;      // how old the lamp signal was at entry
  tpUsdAway?: number;      // live $ remaining to the fixed-dollar TP target (brain-beat fresh; undefined on old data)
  slUsdAway?: number;      // live $ remaining before the stop is hit (negative ⇒ already past)
  origin?: "brain" | "manual"; // v11: WHO opened it — the AI brain or a human (MT5 app / app UI); undefined on old data
}

/** v11: a live PENDING (limit/stop) order mirrored from the broker —
 *  orderType: 2=BUY LIMIT 3=SELL LIMIT 4=BUY STOP 5=SELL STOP */
export interface TraderPendingOrder {
  ticket: number;
  symbol: string;
  orderType: number;          // 2=BUY LIMIT 3=SELL LIMIT 4=BUY STOP 5=SELL STOP
  orderTypeName: string;      // "BUY LIMIT" etc — human name, use for display
  lots: number;
  price: number;              // trigger price
  sl: number;
  tp: number;
  priceCurrent: number;       // live market price (distance-to-trigger calc)
  timeSetup: number;          // epoch ms
  comment: string;
}

/** v11: a CLOSED trade from the broker's own deal history (24h, newest
 *  first, max 30) — brain AND manual trades, classified. */
export interface TraderHistoryEntry {
  positionId: number;
  symbol: string;
  side: "buy" | "sell";
  origin: "brain" | "manual";  // WHO opened it — the mystery-order answer
  lots: number;
  entry: number;
  exit: number;
  pnl: number;                // gross $ across all out-deals
  openedAt: number;           // epoch ms
  closedAt: number;           // epoch ms
  exitKind: "TP" | "SL" | "FLIP" | "ADVERSE" | "TIME" | "AI" | "MANUAL" | "PARTIAL";
  comment: string;
}

export interface TraderJournalEntry {
  id: number;
  at: number;
  symbol: string;
  action: "open" | "close" | "skip" | "halt" | "error" | "manage" | "info";
  side?: "buy" | "sell";
  price?: number;
  lots?: number;
  pnl?: number;
  reason: string;
  /** how the trade ended — on close/manage entries going forward; absent on
   *  historical entries and on open/skip/halt/error/info entries */
  exitKind?: "TP" | "SL" | "FLIP" | "ADVERSE" | "TIME" | "AI" | "MANUAL" | "PARTIAL";
}

export interface BrainThought {
  at: number;
  text: string;
  tone: "info" | "good" | "bad" | "warn";
}

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
  n: number;
  wins: number;
  winRate: number;
  adaptiveMin: number;
  consecLosses: number;
}

/** one live verdict from the REAL AI model (LLM judge) inside the brain */
export interface AiVerdictRecord {
  at: number;
  symbol: string;
  kind: "entry" | "review";
  side?: "buy" | "sell";
  decision: string;    // buy / sell / pass / hold / tighten / close / offline
  conf: number;        // 0..100
  note: string;        // বাংলা
  applied?: boolean;
}

export interface TraderState {
  /** v14: present (and true) ONLY on the password-locked stub payload — a
   *  locked mt5-service answers anonymous sockets/REST with {locked:true}
   *  and none of the other fields. useFeed normalizes it away (null state +
   *  a traderLocked flag) so consumers never see this shape as a TraderState. */
  locked?: boolean;
  enabled: boolean;
  riskMode: TraderRiskMode;
  /** fixed-dollar take-profit target — every trade banks profit at +$tpUsd.
   *  0 = R-multiple mode (tpR × risk); $-mode requires ≥ 3 (server range
   *  3–50, v14 — the old 0.1–50 UI clamp sent values the server rejects). */
  tpUsd: number;
  /** v9 breakeven trigger — live profit ≥ this $ moves SL to entry(+lock).
   *  0 = AUTO (60% of tpUsd, or breakevenR in R-mode). */
  beUsd: number;
  /** v9: $ locked above entry when breakeven fires */
  beLockUsd?: number;
  /** v14: daily trade cap, 1–100 (backend default 12). 0/invalid input
   *  commits as 12 — unlimited mode is gone. */
  maxDailyTrades?: number;
  /** v10: the MT5 login the brain follows — verify it matches your MT5 app */
  accountLogin?: number;
  /** v10: broker server name */
  serverName?: string;
  connected: boolean;
  source: string;
  noFunds: boolean;
  balance: number;
  /** v9 LIVE equity: balance + floating P/L, recomputed every brain beat */
  equity: number;
  /** v9: balance when the brain session began (trend baseline) */
  sessionStartBalance?: number;
  /** v9: balance trend history — every change recorded (sparkline feed) */
  balanceHist?: { at: number; balance: number }[];
  /** v9: Σ live position P/L (running profit on open trades) */
  floatingPnl?: number;
  currency: string;
  haltedToday: boolean;
  haltReason: string;
  positions: TraderPosition[];
  /** v11: live pending (limit/stop) orders mirrored from the broker */
  pendingOrders?: TraderPendingOrder[];
  /** v11: recent closed trades from the broker's own deal history (24h, newest first, max 30) */
  recentHistory?: TraderHistoryEntry[];
  /** v11: epoch ms of the last successful broker positions-sync — the app is
   *  a LIVE mirror, so age is typically < 600ms (0 = never synced) */
  lastSyncAt?: number;
  rules: TraderSymbolRule[];
  feelings: AiFeel[];
  journal: TraderJournalEntry[];
  brain: BrainThought[];
  today: { trades: number; wins: number; losses: number; pnl: number; winPct: number };
  memory?: {
    lessons: TraderLesson[];
    edges: SymbolEdgeStat[];
    tradesAnalyzed: number;
    winRate: number;
    avgR: number;
  };
  ai?: {
    verdicts: AiVerdictRecord[];
    stats: { ok: number; fail: number; avgMs: number; lastError: string; model: string };
    exec?: { lastMs: number; avgMs: number; n: number }; // signal→order latency
  };
  updatedAt: number;
}

export type Tone = "bull" | "bear" | "gold" | "violet" | "neutral";

/** Auto-drawing kinds — same visual grammar as the reference engine. */
export type AutoDrawing =
  | { kind: "hline"; price: number; label: string; tone: Tone; style?: "solid" | "dash" }
  | {
      kind: "zone";
      side: "supply" | "demand" | "ob_bull" | "ob_bear" | "fvg_bull" | "fvg_bear";
      lo: number; hi: number; t: number; source_tf?: string; state?: "active" | "faded";
    }
  | { kind: "channel"; dir: "up" | "down"; upper: { t1: number; p1: number; t2: number; p2: number }; lower: { t1: number; p1: number; t2: number; p2: number } }
  | { kind: "trendline"; t1: number; p1: number; t2: number; p2: number; tone: Tone; broken?: boolean; state?: "active" | "faded" }
  | { kind: "fib"; t0: number; p0: number; t1: number; p1: number; dir: "up" | "down"; levels: { ratio: number; price: number }[]; ote?: [number, number] }
  | { kind: "sweep"; t: number; price: number; side: "high" | "low" }
  | { kind: "structure"; t: number; price: number; dir: "up" | "down"; label: "BOS" | "CHoCH"; fromT?: number }
  /** market-structure zigzag — connects the confirmed swings (HH/HL/LH/LL path) */
  | { kind: "zigzag"; points: { t: number; p: number; side: "high" | "low" }[] }
  | { kind: "arrow"; t: number; price: number; dir: "up" | "down"; tone?: Tone }
  | { kind: "swing"; t: number; price: number; tag: "HH" | "HL" | "LH" | "LL"; side: "high" | "low" }
  | {
      kind: "setup"; dir: "BUY" | "SELL"; zone: [number, number]; entry: number; sl: number; tp: number; rr: number;
      t0: number; status: "forming" | "triggered" | "pending" | "active" | "projected"; note?: string;
      entryType?: "market" | "limit"; createdAt?: string; symbol?: string; tf?: string; trigger?: string;
    }
  | { kind: "magnet"; price: number; source: string; dist_atr: number }
  | { kind: "liq"; side: "BSL" | "SSL"; price: number; t: number; state: "untouched" | "swept" | "run" }
  | { kind: "path"; dir: "up" | "down"; from_price: number; to_price: number }
  | { kind: "pattern"; name: string; family: "reversal" | "continuation"; points: { t: number; price: number; n: number }[]; neckline?: { t1: number; p1: number; t2: number; p2: number }; target?: number };

/** User-created drawings (persisted). */
export interface UserDrawing {
  id: string;
  symbol: string;
  timeframe: string;
  kind: "trendline" | "ray" | "hline" | "vline" | "rect" | "fib" | "text" | "measure";
  points: { t: number; p: number }[];
  style: { color?: string; width?: number; text?: string };
  createdAt?: string;
}

export interface CheckItem {
  name: string;
  ok: boolean;
  value: string;
}

export interface SignalPayload {
  id?: string;
  symbol: string;
  timeframe: string;
  direction: "BUY" | "SELL";
  trigger: "sfp" | "zone" | "pullback";
  entryType: "market" | "limit";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  confidence: number;
  status: "active" | "pending" | "won" | "lost" | "expired" | "cancelled";
  resultR?: number | null;
  barTime: number;
  targetNote?: string;
  entryNote?: string;
  flowNote?: string;
  factors: string[];
  checks: CheckItem[];
  createdAt?: string;
}

export interface RoadmapData {
  direction: "BULL" | "BEAR" | "NEUTRAL";
  directionWhy: string;
  run: number;
  runDir: "up" | "down" | "flat";
  phase: string;
  pReversal: number;
  magnets: { label: string; price: number; distAtr: number }[];
  liquidity: { side: "BSL" | "SSL"; price: number; state: string; distAtr: number }[];
  path: { dir: "up" | "down"; target: number; note: string } | null;
  bullScenario: { entry: number; targets: number[]; note: string };
  bearScenario: { entry: number; targets: number[]; note: string };
  keyLevels: { label: string; price: number; tone: Tone }[];
}

export interface IndicatorSnapshot {
  rsi: number;
  atr: number;
  adx: number;
  er: number;
  macdHist: number;
  stochK: number;
  stochD: number;
  bbUpper: number;
  bbLower: number;
  bbPctB: number;
  ema9: number;
  ema21: number;
  ema50: number;
  volZ: number;
  regime: string;
  regimeNote: string;
  trendM5: string;
  trendM15: string;
  trendH1: string;
  trendH4: string;
  battle: { buyPct: number; sellPct: number; state: string };
  whale: { bias: string; note: string } | null;
}

export interface AnalysisResponse {
  symbol: string;
  timeframe: string;
  price: number;
  digits: number;
  /** v16.4 (audit §10): explicit engine verdict for THIS symbol+tf —
   *  "OK" = data good, a live/pending signal exists;
   *  "NO_SETUP" = data good, no signal right now (see nearMiss);
   *  data failures never reach this shape — they are HTTP 503 + code
   *  DATA_UNAVAILABLE so the UI can tell outage from quiet market. */
  status: "OK" | "NO_SETUP";
  signal: SignalPayload | null;
  /** planned next entry when no live signal exists (entry/SL/TP projection) */
  nextSetup: {
    dir: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    reason: string;
    source: string;
  } | null;
  nearMiss: string[];
  drawings: AutoDrawing[];
  roadmap: RoadmapData;
  snapshot: IndicatorSnapshot;
  /** v16.4 (audit §4/§10): timeframe/data identity — candle open time of
   *  the last CLOSED bar the engine evaluated, plus an age/freshness read
   *  so the UI can flag a stale feed instead of showing it as live. */
  lastCandleTime: number;
  dataFreshness: { lastCandleTime: number; ageSec: number; fresh: boolean };
  /** v16.4.1 (audit §10 completion): the tf the CLIENT asked for and the tf
   *  the signal (if any) was generated on — carried separately so a
   *  multi-tf consumer can never conflate the two. */
  requestedTimeframe: string;
  signalTimeframe: string | null;
  /** v16.4.1 (audit §10): which timeframes ACTUALLY fed the engine (had
   *  candle data) and which were unavailable — a partial feed degrades the
   *  MTF bias silently otherwise; now it is part of the contract. */
  sourceTimeframes: string[];
  missingTimeframes: string[];
  /** v16.4 (audit §10): the strategy build that produced this payload —
   *  cache keys and consumers can compare across deploys. */
  strategyVersion: string;
  generatedAt: number;
}
