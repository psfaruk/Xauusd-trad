/**
 * MT5 data manager — one persistent MT5 session with auto-reconnect across
 * gateway IPs, live tick → bar building for every timeframe, a candle cache,
 * broker→UTC offset detection and a labelled SIMULATOR fallback (used only if
 * every Exness gateway is unreachable, e.g. network egress blocked).
 */

import { Mt5WsClient, TF_CODE, type SymbolInfo, type AccountInfo, type Mt5Position, type Mt5Order, type Mt5Deal, type TradeResult, type TradeSide } from "./mt5-client";
import { FlowTracker, TickRecorder, type FlowPayload } from "./flow";
import fs from "node:fs";
import path from "node:path";

export type { FlowPayload } from "./flow";

export interface Bar {
  t: number; // UTC seconds (bar open)
  o: number; h: number; l: number; c: number; v: number;
}
export interface Tick {
  symbol: string; bid: number; ask: number; mid: number; ts: number; // UTC sec
}
export type BarEvent = { symbol: string; tf: string; ev: "open" | "update" | "close"; bar: Bar };
export type FeedSource = "mt5" | "sim";
export interface StatusPayload {
  connected: boolean;
  source: FeedSource;
  server: string;
  account: { login: number; balance: number; equity: number; currency: string } | null;
  latencyMs: number | null;
  serverTime: number;
  offsetSec: number;
  reason: string;
}

const GATEWAYS = [
  "47.130.41.116", "57.182.183.85", "16.79.3.122", "18.61.99.175",
  "8.219.172.6", "47.236.224.248", "47.81.62.132", "43.210.112.100",
  "35.154.31.85",
];

const WATCH_CANDIDATES = [
  "XAUUSDm", "XAUUSD247m", "XAGUSDm", "USOILm", "UKOILm",
  "USTECm", "USTEC_x100m", "US500m", "US500_x100m",
  "BTCUSDm", "ETHUSDm", "SOLUSDm",
  "EURUSDm", "GBPUSDm", "USDJPYm", "AUDUSDm", "USDCADm", "USDCHFm", "NZDUSDm",
  "EURJPYm", "GBPJPYm", "EURGBPm",
];

const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000,
};
// fetch window (days) per tf — wide enough to survive weekend gaps
const TF_DAYS: Record<string, number> = {
  M1: 12, M5: 25, M15: 45, M30: 70, H1: 150, H4: 320, D1: 900, W1: 3650, MN1: 15000,
};

const SIM_SEED: Record<string, { p: number; vol: number; digits: number }> = {
  XAUUSDm: { p: 4285.9, vol: 0.00035, digits: 3 },
  XAGUSDm: { p: 50.85, vol: 0.0005, digits: 3 },
  USOILm: { p: 78.42, vol: 0.0006, digits: 2 },
  UKOILm: { p: 82.15, vol: 0.0006, digits: 2 },
  USTECm: { p: 21450, vol: 0.0005, digits: 1 },
  USTEC_x100m: { p: 21450, vol: 0.0005, digits: 1 },
  US500m: { p: 6820, vol: 0.0004, digits: 1 },
  US500_x100m: { p: 6820, vol: 0.0004, digits: 1 },
  BTCUSDm: { p: 84815, vol: 0.0006, digits: 2 },
  ETHUSDm: { p: 2995, vol: 0.0008, digits: 2 },
  SOLUSDm: { p: 198.4, vol: 0.001, digits: 2 },
  EURUSDm: { p: 1.0865, vol: 0.00006, digits: 5 },
  GBPUSDm: { p: 1.2698, vol: 0.00007, digits: 5 },
  USDJPYm: { p: 155.32, vol: 0.00007, digits: 3 },
  AUDUSDm: { p: 0.6512, vol: 0.00007, digits: 5 },
  USDCADm: { p: 1.3715, vol: 0.00006, digits: 5 },
  USDCHFm: { p: 0.8842, vol: 0.00006, digits: 5 },
  NZDUSDm: { p: 0.5945, vol: 0.00008, digits: 5 },
  EURJPYm: { p: 168.55, vol: 0.00007, digits: 3 },
  GBPJPYm: { p: 197.28, vol: 0.00008, digits: 3 },
  EURGBPm: { p: 0.8556, vol: 0.00005, digits: 5 },
};

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface CacheEntry { bars: Bar[]; fetchedAt: number; }

export class Mt5Manager {
  // ── public state ──
  source: FeedSource = "mt5";
  connected = false;
  symbols = new Map<string, SymbolInfo>();
  watch: string[] = [];
  account: AccountInfo | null = null;
  serverName: string;
  offsetSec = 0; // broker server time − UTC (seconds, 30-min quantized)
  latencyMs: number | null = null;
  reason = "connecting";

  // ── internal ──
  private client: Mt5WsClient | null = null;
  readonly login: number;
  private password: string;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private gatewayIdx = 0;
  private failedRounds = 0;
  private stopped = false;
  private firstFailAt = 0; // wedge detection: when the current mt5 outage started
  private wedgeTimer: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, CacheEntry>();
  private quotes = new Map<string, { bid: number; ask: number; mid: number; ts: number }>();
  private activeTfs = new Map<string, Set<string>>(); // symbol → tfs clients watch
  private barRefs = new Map<string, number>();        // "sym|tf" → socket refcount
  private lastBarEmit = new Map<string, number>(); // "sym|tf" → ts of last throttled emit
  private dayClose = new Map<string, number>(); // symbol → previous day close (for change%)
  private lastKnownMid = new Map<string, number>();
  private reconciles = new Set<string>();

  // ── callbacks (set by server) ──
  onTick: ((t: Tick) => void) | null = null;
  onBar: ((e: BarEvent) => void) | null = null;
  onStatus: ((s: StatusPayload) => void) | null = null;
  onFlow: ((p: FlowPayload) => void) | null = null;

  // ── order-flow (running-candle X-ray) ──
  private flowTrackers = new Map<string, FlowTracker>(); // "sym|tf" → tracker
  private flowRefs = new Map<string, number>();          // "sym|tf" → subscriber count
  private flowReap = new Map<string, ReturnType<typeof setTimeout>>(); // "sym|tf" → pending idle-reap timer

  // ── raw-tick recorder (real ticks for honest backtests) ──
  private recorders = new Map<string, TickRecorder>();
  private static readonly RECORDER_SYMBOLS = new Set(["XAUUSDm", "BTCUSDm"]);

  // ── live tick rings (per-symbol, last ~30 min) for the focus area chart
  //    (deep zoom-out on M1 needs ~16 min of tape; 30 gives headroom) ──
  private tickRings = new Map<string, { t: number; p: number }[]>();
  private static readonly TICK_RING_MS = 30 * 60_000;
  private static readonly TICK_RING_MAX = 20_000;

  /** recent ticks (t = epoch ms, p = mid) for a symbol — backfills the area chart */
  getTicks(symbol: string, sec = 180): { t: number; p: number }[] {
    const ring = this.tickRings.get(symbol);
    if (!ring || !ring.length) return [];
    const from = Date.now() - Math.min(Math.max(sec, 10), 1800) * 1000;
    // rings are push-ordered (ascending t) — binary-search the start
    let lo = 0, hi = ring.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ring[mid].t < from) lo = mid + 1; else hi = mid; }
    return ring.slice(lo);
  }

  private recordTickRing(symbol: string, mid: number) {
    let ring = this.tickRings.get(symbol);
    if (!ring) { ring = []; this.tickRings.set(symbol, ring); }
    const t = Date.now();
    ring.push({ t, p: mid });
    const horizon = t - Mt5Manager.TICK_RING_MS;
    while (ring.length > Mt5Manager.TICK_RING_MAX || (ring.length > 0 && ring[0].t < horizon)) ring.shift();
  }

  digits(symbol: string): number { return this.symbols.get(symbol)?.digits ?? 2; }

  /** internal (trader-owned) flow tracker — no socket refcount */
  getOrCreateTracker(symbol: string, tf: string): FlowTracker {
    const key = `${symbol}|${tf}`;
    let tr = this.flowTrackers.get(key);
    if (!tr) {
      tr = new FlowTracker(symbol, tf, this.digits(symbol));
      this.seedDeepFromRecorder(symbol, tr);
      this.flowTrackers.set(key, tr);
      const seeded = tr;
      this.getCandles(symbol, tf, 2)
        .then((bars) => {
          const last = bars[bars.length - 1];
          if (last && this.flowTrackers.get(key) === seeded) seeded.seedBar(last.t, last.o, last.h, last.l, last.c);
        })
        .catch(() => {});
    }
    return tr;
  }

  /** give a fresh tracker an instant cross-candle delta path from the raw-tick
   *  recording (when this symbol is recorded) — restarts/hot-reloads must not
   *  blank the 2-candle delta view for the next half hour. */
  private seedDeepFromRecorder(symbol: string, tr: FlowTracker) {
    try {
      const rec = this.getRecorder(symbol);
      if (rec) tr.seedDeep(rec.recent(60_000));
    } catch { /* best-effort — the deep path fills in live anyway */ }
  }

  // ── TraderHost implementation (used by the AI trader) ──
  async traderAccount(): Promise<AccountInfo | null> {
    if (!this.connected || this.source !== "mt5" || !this.client) return null;
    try { return await this.client.account(); } catch { return null; }
  }
  async traderPositions(): Promise<{ positions: Mt5Position[]; pendingOrders: number; orders: Mt5Order[] }> {
    if (!this.connected || this.source !== "mt5" || !this.client) return { positions: [], pendingOrders: 0, orders: [] };
    return this.client.positions();
  }
  /** v11: place a pending (limit/stop) order from the app */
  async traderPendingOrder(symbol: string, orderType: 2 | 3 | 4 | 5, lots: number, price: number, opts: { sl?: number; tp?: number; digits?: number; comment?: string }): Promise<TradeResult> {
    if (!this.client || !this.connected) throw new Error("mt5 not connected");
    return this.client.pendingOrder(symbol, orderType, lots, price, opts);
  }
  /** v11: cancel a pending order from the app */
  async traderCancelOrder(symbol: string, orderType: number, lots: number, price: number, ticket: number, opts: { digits?: number }): Promise<TradeResult> {
    if (!this.client || !this.connected) throw new Error("mt5 not connected");
    return this.client.cancelOrder(symbol, orderType, lots, price, ticket, opts);
  }
  async traderMarketOrder(symbol: string, side: TradeSide, lots: number, price: number, opts: { sl: number; tp: number; digits: number; comment: string }): Promise<TradeResult> {
    if (!this.client || !this.connected) throw new Error("mt5 not connected");
    return this.client.marketOrderAt(symbol, side, lots, price, opts);
  }
  async traderClose(symbol: string, side: TradeSide, lots: number, price: number, ticket: number, opts: { digits: number }): Promise<TradeResult> {
    if (!this.client || !this.connected) throw new Error("mt5 not connected");
    return this.client.closePosition(symbol, side, lots, price, ticket, opts);
  }
  async traderModify(symbol: string, side: TradeSide, lots: number, price: number, ticket: number, sl: number, tp: number, opts: { digits: number }): Promise<TradeResult> {
    if (!this.client || !this.connected) throw new Error("mt5 not connected");
    return this.client.modifyPosition(symbol, side, lots, price, ticket, sl, tp, opts);
  }
  async traderDeals(fromSec: number, toSec: number): Promise<Mt5Deal[]> {
    if (!this.client || !this.connected) return [];
    return this.client.deals(fromSec, toSec);
  }

  constructor(opts?: { server?: string; login?: number; password?: string }) {
    this.serverName = opts?.server ?? process.env.MT5_SERVER ?? "Exness-MT5Trial6";
    // SECURITY: credentials come ONLY from env (MT5_LOGIN / MT5_PASSWORD) —
    // never hard-code broker credentials in a public repo. Missing creds →
    // the manager stays in SIM mode (connectLoop checks every attempt).
    this.login = Number(opts?.login ?? process.env.MT5_LOGIN ?? 0);
    this.password = opts?.password ?? process.env.MT5_PASSWORD ?? "";
  }

  /** True when broker credentials are configured (env or options). */
  get hasCredentials(): boolean {
    return !!this.login && !!this.password;
  }

  nowSec() { return Math.floor(Date.now() / 1000); }

  // ═════════════════════ lifecycle ═════════════════════
  start() {
    // HOT-RELOAD SAFETY (Sep-29 leak): bun --hot re-evaluates index.ts on every
    // edit — each eval used to create a NEW manager (new broker connection,
    // new heartbeat timer) while the old one kept running. 15 reloads left 17
    // live sockets to the broker. Exactly one manager per process — stop the
    // previous one, like the AiTrader guard does.
    const G = globalThis as unknown as { __mt5Manager?: Mt5Manager };
    if (G.__mt5Manager && G.__mt5Manager !== this) {
      try {
        console.log("t5] hot-reload: stopping previous manager instance");
        G.__mt5Manager.stop();
      } catch { /* already dead */ }
    }
    G.__mt5Manager = this;
    this.stopped = false;
    this.connectLoop();
    // wedge self-check: a healthy manager recovers (or falls back to sim)
    // within ~2 min. If we stay "mt5 + connecting" for 4 min, the hot-reload
    // wedge or a dead timer loop is certain — exit so the port watchdog
    // respawns us fresh (24/7 resilience).
    if (!this.wedgeTimer) {
      this.wedgeTimer = setInterval(() => {
        if (
          this.stopped ||
          this.connected ||
          this.source !== "mt5" ||
          !this.firstFailAt ||
          Date.now() - this.firstFailAt < 4 * 60_000
        ) return;
        console.error("[mt5] WEDGE DETECTED: not connected for 4 min while source=mt5 — exiting for fresh respawn");
        process.exit(1);
      }, 30_000);
      this.wedgeTimer.unref?.();
    }
  }

  /** force a fresh broker session (wedged cmd-4 waiter chain) — quotes can
   *  flow while position lists die; only a new socket resets the waiters. */
  forceReconnect() {
    console.log("[mt5] forcing session recycle (wedged request chain)");
    this.connected = false;
    this.reason = "recycling session";
    this.emitStatus();
    try { this.client?.close(); } catch { /* already closed */ }
    // NEVER rely on onClose firing: a silently-dead socket never emits it and
    // the manager stayed "recycling session" forever (wedge timer disarmed
    // because firstFailAt was reset on the last successful connect). Schedule
    // the reconnect directly — scheduleRetry/onClose clears this timer if the
    // close event does fire, so exactly one connectLoop runs.
    if (!this.firstFailAt) this.firstFailAt = Date.now(); // re-arm the wedge escape
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connectLoop(), 1500);
  }

  stop() {
    this.stopped = true;
    this.client?.close();
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.simTimer) clearInterval(this.simTimer);
    if (this.wedgeTimer) clearInterval(this.wedgeTimer);
  }

  private emitStatus() {
    this.onStatus?.({
      connected: this.connected,
      source: this.source,
      server: this.serverName,
      account: this.account
        ? {
            login: this.login,
            balance: this.account.balance,
            equity: this.account.equity,
            currency: this.account.currency,
          }
        : null,
      latencyMs: this.latencyMs,
      serverTime: this.nowSec() + this.offsetSec,
      offsetSec: this.offsetSec,
      reason: this.reason,
    });
  }

  private async connectLoop() {
    if (this.stopped) return;
    // No broker credentials → SIM mode (no point hammering the gateway with
    // doomed logins). Re-check every 60s in case env/opts changed (hot reload).
    if (!this.hasCredentials) {
      this.startSim(
        "MT5_LOGIN / MT5_PASSWORD not set — SIM mode. Set them as environment variables for live broker data.",
      );
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connectLoop(), 60_000);
      return;
    }
    // outage window starts at the first connect attempt (wedge detection:
    // even a hang INSIDE Mt5WsClient.connect with no retry will be caught)
    if (!this.firstFailAt) this.firstFailAt = Date.now();
    const gw = GATEWAYS[this.gatewayIdx % GATEWAYS.length];
    this.gatewayIdx++;
    this.connected = false;
    this.reason = `connecting via ${gw}`;
    this.emitStatus();

    let client: Mt5WsClient;
    try {
      client = await Mt5WsClient.connect(gw);
    } catch (e) {
      this.scheduleRetry((e as Error).message);
      return;
    }
    // hot-reload races: stop() may have run WHILE we were connecting — never
    // let a stopped manager finish a fresh login (leaked socket + zombie timer)
    if (this.stopped) { client.close(); return; }

    try {
      await client.auth();
      await client.login(this.login, this.password);
      if (this.stopped) { client.close(); return; } // same race, one gate deeper
      const acct = await client.account();
      if (!Number.isFinite(acct.equity) || acct.equity <= 0) acct.equity = acct.balance;
      this.account = { ...acct, login: this.login };
      const symbols = await client.symbols();
      this.symbols = symbols;

      // resolve watch list
      const w: string[] = [];
      for (const cand of WATCH_CANDIDATES) {
        if (symbols.has(cand)) w.push(cand);
      }
      if (!w.some((s) => s.startsWith("XAUUSD"))) {
        const gold = [...symbols.keys()].find((s) => s.toUpperCase().startsWith("XAUUSD"));
        if (gold) w.unshift(gold);
      }
      this.watch = w;

      this.client = client;
      this.connected = true;
      this.source = "mt5";
      this.reason = "connected";
      this.failedRounds = 0;
      this.firstFailAt = 0; // recovered — reset the wedge clock
      this.stopSim();
      this.cache.clear(); // sim/MT5 switchover → fresh data
      this.emitStatus();
      console.log(
        `[mt5] connected via ${gw} — account ${this.login} (${acct.balance.toFixed(2)} ${acct.currency}), ${symbols.size} symbols, watching ${w.length}`,
      );

      client.onClose(() => {
        if (this.stopped) return;
        console.log("[mt5] connection closed — reconnecting");
        this.connected = false;
        this.reason = "connection lost";
        this.emitStatus();
        this.scheduleRetry("closed");
      });
      client.onQuotes((q) => this.handleQuote(q.symbolId, q.timeSec, q.bidRaw, q.askRaw));

      // subscribe watch symbols
      const ids = w.map((s) => symbols.get(s)!.id);
      client.subscribe(...ids);

      // heartbeat + watchdog
      if (this.hbTimer) clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => {
        const c = this.client;
        if (!c || !c.isOpen) return;
        if (Date.now() - c.lastRecvAt > 30000) {
          console.log("[mt5] watchdog: no data for 30s — forcing reconnect");
          c.close();
          return;
        }
        try { c.heartbeat(); } catch { /* closed */ }
      }, 4000);

      // preload day-close for change% + latency estimate
      this.preloadDayCloses().catch(() => {});
    } catch (e) {
      client.close();
      this.scheduleRetry((e as Error).message);
    }
  }

  private scheduleRetry(errMsg: string) {
    if (this.stopped) return;
    this.connected = false;
    this.failedRounds++;
    if (!this.firstFailAt) this.firstFailAt = Date.now();
    this.reason = `reconnecting (${errMsg})`;
    const delay = Math.min(2000 * 2 ** Math.min(this.failedRounds, 5), 60000);
    console.log(`[mt5] retry in ${delay}ms — ${errMsg}`);

    if (this.failedRounds >= 3 && this.source !== "sim") {
      this.startSim(`MT5 unreachable (${errMsg}) — simulator active, keep retrying`);
    }
    this.emitStatus();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connectLoop(), delay);
  }

  // ═════════════════════ simulator fallback ═════════════════════
  private simPrices = new Map<string, { p: number; digits: number }>();

  private startSim(reason: string) {
    this.source = "sim";
    this.reason = reason;
    this.simPrices.clear();
    for (const [sym, cfg] of Object.entries(SIM_SEED)) {
      this.simPrices.set(sym, { p: cfg.p, digits: cfg.digits });
      if (!this.symbols.has(sym)) {
        this.symbols.set(sym, { id: -1, digits: cfg.digits, name: sym });
      }
    }
    if (!this.watch.length) this.watch = Object.keys(SIM_SEED);
    this.account = {
      login: this.login, balance: 407.42, equity: 407.42,
      currency: "USD", group: "sim", server: this.serverName,
    };
    this.cache.clear();
    this.emitStatus();
    console.log(`[sim] ${reason}`);
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = setInterval(() => {
      for (const [sym, st] of this.simPrices) {
        const cfg = SIM_SEED[sym];
        const dt = 0.7; // seconds between sim ticks
        st.p *= 1 + cfg.vol * gauss() * Math.sqrt(dt / 60) * 8;
        const spread = st.p * 0.00004;
        const bid = st.p - spread / 2;
        const ask = st.p + spread / 2;
        this.handleQuote(-1, this.nowSec(), bid, ask, sym, cfg.digits);
      }
    }, 700);
  }

  private stopSim() {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
    this.simPrices.clear();
  }

  // ═════════════════════ quotes → ticks → bars ═════════════════════
  private handleQuote(
    symbolId: number, timeSec: number, bidRaw: number, askRaw: number,
    forcedName?: string, forcedDigits?: number,
  ) {
    let name = forcedName;
    let digits = forcedDigits;
    if (!name) {
      for (const [n, info] of this.symbols) {
        if (info.id === symbolId) { name = n; digits = info.digits; break; }
      }
    }
    if (!name || digits === undefined) return;

    // broker sends ask=0 (or bid=0) for symbols without a live book yet —
    // a half-quote that would poison mid as (bid+0)/2. Skip until both
    // sides are real.
    if (bidRaw <= 0 || askRaw <= 0) return;

    // broker→UTC offset (30-min quantized, only from fresh ticks)
    const utcNow = this.nowSec();
    const drift = timeSec - utcNow;
    if (Math.abs(drift) < 900) {
      const q = Math.round(drift / 1800) * 1800;
      if (q !== this.offsetSec) {
        this.offsetSec = q;
        this.cache.clear(); // re-stamp everything in UTC
      }
    }

    const div = 10 ** digits;
    const bid = bidRaw / div;
    const ask = askRaw / div;
    const mid = (bid + ask) / 2;
    const tsUtc = timeSec - this.offsetSec;

    this.quotes.set(name, { bid, ask, mid, ts: tsUtc });
    this.onTick?.({ symbol: name, bid, ask, mid, ts: tsUtc });
    this.buildBars(name, mid, tsUtc);
    this.updateFlow(name, mid, tsUtc);
    this.recordTick(name, mid);
    this.recordTickRing(name, mid);
  }

  // ── raw-tick recorder (persists every tick for backtest replay) ──
  /** lazily create the per-symbol recorder, continuing from the previous
   *  process's recording (a restart must not wipe the accumulated real-tick
   *  history the backtest — and the delta deep-seed — depends on). */
  private getRecorder(symbol: string): TickRecorder | null {
    if (!Mt5Manager.RECORDER_SYMBOLS.has(symbol)) return null;
    let rec = this.recorders.get(symbol);
    if (!rec) {
      const dir = path.join(process.cwd(), "data");
      const file = path.join(dir, `ticks-${symbol}.json`);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only fs — recorder degrades to memory-only */ }
      let seed: { t: number; p: number }[] = [];
      try {
        const prev = JSON.parse(fs.readFileSync(file, "utf8"));
        if (prev?.ticks?.length) seed = prev.ticks;
      } catch { /* first boot */ }
      rec = new TickRecorder(symbol, 260_000, (sym, ticks) => {
        try { fs.writeFileSync(path.join(dir, `ticks-${sym}.json`), JSON.stringify({ symbol: sym, n: ticks.length, ticks })); } catch { /* best-effort */ }
      }, seed);
      this.recorders.set(symbol, rec);
    }
    return rec;
  }

  private recordTick(symbol: string, mid: number) {
    const rec = this.getRecorder(symbol);
    if (!rec) return;
    rec.tick(Date.now(), mid);
    rec.maybeFlush(Date.now());
  }

  // ── order-flow plumbing ──
  private updateFlow(symbol: string, mid: number, tsSec: number) {
    if (!this.flowTrackers.size) return;
    const nowMs = Date.now();
    for (const [key, tr] of this.flowTrackers) {
      if (!key.startsWith(`${symbol}|`)) continue;
      try {
        tr.tick(mid, tsSec, nowMs);
        if (tr.shouldEmit(nowMs)) this.onFlow?.(tr.payload(nowMs));
      } catch (e) {
        // A bug in ONE tracker must NEVER kill the market service again
        // (this exact class of bug took the whole service down on Sep 28).
        console.error(`[flow] tracker ${key} threw (isolated, replacing):`, (e as Error)?.stack ?? e);
        const tf = key.slice(symbol.length + 1);
        const refs = this.flowRefs.get(key) ?? 1;
        try {
          const fresh = new FlowTracker(symbol, tf, this.symbols.get(symbol)?.digits ?? 2);
          this.flowTrackers.set(key, fresh);
          this.flowRefs.set(key, refs); // keep subscribers alive — stream self-heals
        } catch {
          this.flowTrackers.delete(key);
          this.flowRefs.delete(key);
        }
      }
    }
  }

  addFlowSub(symbol: string, tf: string): FlowTracker {
    const key = `${symbol}|${tf}`;
    this.flowRefs.set(key, (this.flowRefs.get(key) ?? 0) + 1);
    // re-subscribed inside the grace window → cancel the pending reap so the
    // warm tracker (with its delta history) survives the churn
    if (this.flowReap.has(key)) {
      clearTimeout(this.flowReap.get(key));
      this.flowReap.delete(key);
    }
    let tr = this.flowTrackers.get(key);
    if (!tr) {
      const digits = this.symbols.get(symbol)?.digits ?? 2;
      tr = new FlowTracker(symbol, tf, digits);
      this.seedDeepFromRecorder(symbol, tr);
      this.flowTrackers.set(key, tr);
      // seed the running candle with the real bar OHLC so the X-ray
      // is correct even when subscribing mid-candle (delta still counts from now)
      const seeded = tr;
      this.getCandles(symbol, tf, 2)
        .then((bars) => {
          const last = bars[bars.length - 1];
          if (last && this.flowTrackers.get(key) === seeded) {
            seeded.seedBar(last.t, last.o, last.h, last.l, last.c);
            // quiet market (no ticks): push the seeded candle to subscribers now
            this.onFlow?.(seeded.payload(Date.now()));
          }
        })
        .catch(() => {});
    } else {
      tr.forceEmitReady(); // resubscribe → immediate fresh payload
    }
    return tr;
  }

  removeFlowSub(symbol: string, tf: string) {
    const key = `${symbol}|${tf}`;
    const n = (this.flowRefs.get(key) ?? 1) - 1;
    if (n <= 0) {
      this.flowRefs.delete(key);
      // SERVER-SIDE GRACE (2 min): the frontend churns flowsub/flowunsub as
      // the user switches views/tabs/reloads — deleting the tracker on the
      // last unsub wiped the running candle's whole delta history every time
      // (the X-ray "forgot" everything). Keep the tracker warm; re-subscribe
      // within the window simply reuses it (forceEmitReady gives an instant
      // fresh payload). Only truly idle trackers are reaped.
      if (this.flowReap.has(key)) clearTimeout(this.flowReap.get(key));
      this.flowReap.set(key, setTimeout(() => {
        this.flowReap.delete(key);
        // still no subscribers after the grace window → reap for real
        if (!this.flowRefs.has(key)) this.flowTrackers.delete(key);
      }, 120_000));
    } else this.flowRefs.set(key, n);
  }

  getFlowSnapshot(symbol: string, tf: string): FlowPayload | null {
    const tr = this.flowTrackers.get(`${symbol}|${tf}`);
    // forceDeep — a REST peek must always carry the cross-candle delta buffer
    return tr ? tr.payload(Date.now(), true) : null;
  }

  private buildBars(symbol: string, mid: number, tsUtc: number) {
    const tfs = new Set(["M1"]);
    for (const t of this.activeTfs.get(symbol) ?? []) tfs.add(t);
    for (const tf of tfs) {
      const tfSec = TF_SEC[tf];
      const bucket = Math.floor(tsUtc / tfSec) * tfSec;
      const key = `${symbol}|${tf}`;
      const entry = this.cache.get(key);
      if (!entry || !entry.bars.length) continue;
      const bars = entry.bars;
      const last = bars[bars.length - 1];
      if (last.t === bucket) {
        last.h = Math.max(last.h, mid);
        last.l = Math.min(last.l, mid);
        last.c = mid;
        last.v += 1;
        this.throttledBar(symbol, tf, "update", last);
      } else if (bucket > last.t) {
        // close previous
        this.emitBar(symbol, tf, "close", last);
        // open new
        const nb: Bar = { t: bucket, o: mid, h: mid, l: mid, c: mid, v: 1 };
        bars.push(nb);
        if (bars.length > 4000) bars.shift();
        this.emitBar(symbol, tf, "open", nb);
        this.scheduleReconcile(symbol, tf, last.t);
      }
      // bucket < last.t: stale tick — ignore
    }
  }

  private throttledBar(symbol: string, tf: string, ev: "update", bar: Bar) {
    const key = `${symbol}|${tf}`;
    const now = Date.now();
    const lastEmit = this.lastBarEmit.get(key) ?? 0;
    if (now - lastEmit < 130) return; // ≤ ~8 emits/sec
    this.lastBarEmit.set(key, now);
    this.emitBar(symbol, tf, ev, bar);
  }

  private emitBar(symbol: string, tf: string, ev: BarEvent["ev"], bar: Bar) {
    this.onBar?.({ symbol, tf, ev, bar: { ...bar } });
  }

  /** After a bar closes, refetch authoritative OHLCV from MT5 and patch cache. */
  private scheduleReconcile(symbol: string, tf: string, closedT: number) {
    const rk = `${symbol}|${tf}|${closedT}`;
    if (this.reconciles.has(rk)) return;
    this.reconciles.add(rk);
    if (this.reconciles.size > 200) this.reconciles.clear();
    setTimeout(async () => {
      if (this.source !== "mt5" || !this.client) return;
      try {
        const tfSec = TF_SEC[tf];
        const fresh = await this.client.candles(
          symbol, TF_CODE[tf], closedT + this.offsetSec, closedT + this.offsetSec + tfSec,
        );
        const entry = this.cache.get(`${symbol}|${tf}`);
        if (!entry || !fresh.length) return;
        const fb = { t: fresh[0].time - this.offsetSec, o: fresh[0].open, h: fresh[0].high, l: fresh[0].low, c: fresh[0].close, v: fresh[0].tickVolume };
        const idx = entry.bars.findIndex((b) => b.t === closedT);
        if (idx >= 0) {
          entry.bars[idx] = fb;
          this.emitBar(symbol, tf, "close", fb); // corrected values
        }
      } catch { /* non-fatal */ }
    }, 2500);
  }

  // ═════════════════════ subscriptions (socket.io clients) ═════════════════════
  addSubscription(symbol: string, tf: string) {
    // refcounted so several sockets can watch the same symbol|tf safely
    const key = `${symbol}|${tf}`;
    this.barRefs.set(key, (this.barRefs.get(key) ?? 0) + 1);
    if (!this.activeTfs.has(symbol)) this.activeTfs.set(symbol, new Set());
    this.activeTfs.get(symbol)!.add(tf);
  }
  removeSubscription(symbol: string, tf: string) {
    const key = `${symbol}|${tf}`;
    const n = (this.barRefs.get(key) ?? 1) - 1;
    if (n <= 0) {
      this.barRefs.delete(key);
      this.activeTfs.get(symbol)?.delete(tf);
    } else this.barRefs.set(key, n);
  }

  // ═════════════════════ REST data ═════════════════════
  private async fetchCandlesMt5(symbol: string, tf: string, limit: number): Promise<Bar[]> {
    const client = this.client;
    if (!client || !client.isOpen) throw new Error("mt5 not connected");
    const t0 = Date.now();
    const nowServer = this.nowSec() + this.offsetSec;
    let days = TF_DAYS[tf] ?? 30;
    let bars: import("./mt5-client").Mt5Candle[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      bars = await client.candles(
        symbol, TF_CODE[tf], nowServer - days * 86400, nowServer,
      );
      if (bars.length >= Math.min(limit, 50)) break;
      days *= 3; // widen window (weekend / new symbol)
    }
    this.latencyMs = Date.now() - t0;
    return bars.map((b) => ({
      t: b.time - this.offsetSec,
      o: b.open, h: b.high, l: b.low, c: b.close, v: b.tickVolume,
    }));
  }

  private simHistory(symbol: string, tf: string, limit: number): Bar[] {
    const cfg = SIM_SEED[symbol];
    if (!cfg) return [];
    const tfSec = TF_SEC[tf];
    const now = this.nowSec();
    const bucket = Math.floor(now / tfSec) * tfSec;
    const out: Bar[] = [];
    // walk backwards generating a random-walk, then reverse
    let p = cfg.p;
    const m1Count = Math.max(limit, 300) * (tfSec / 60);
    const stepVol = cfg.vol * Math.sqrt(tfSec / 60) * 4;
    for (let i = 0; i < m1Count; i++) {
      const o = p;
      let h = o, l = o, c = o;
      for (let k = 0; k < 4; k++) {
        c *= 1 + stepVol * gauss() / 2;
        h = Math.max(h, c); l = Math.min(l, c);
      }
      p = c;
      out.push({ t: bucket - i * tfSec, o, h, l, c, v: 40 + Math.floor(Math.random() * 200) });
    }
    out.reverse();
    return out;
  }

  async getCandles(symbol: string, tf: string, limit: number): Promise<Bar[]> {
    limit = Math.max(10, Math.min(3000, limit));
    const key = `${symbol}|${tf}`;
    const tfSec = TF_SEC[tf] ?? 60;
    const entry = this.cache.get(key);
    const stale = !entry || Date.now() - entry.fetchedAt > Math.min(tfSec * 1000 * 0.5, 60000);

    if (stale) {
      let bars: Bar[] = [];
      try {
        bars = this.source === "mt5"
          ? await this.fetchCandlesMt5(symbol, tf, limit)
          : this.simHistory(symbol, tf, limit);
      } catch (e) {
        // serve stale cache if fetch fails
        if (entry?.bars.length) return entry.bars.slice(-limit);
        throw e;
      }
      // ── MONOTONIC MERGE — the cache must NEVER move backwards ──
      // The Sep 28 "frozen candle" incident: a mis-delivered (older-window)
      // response replaced the live cache wholesale, rolling the chart back
      // 30 minutes and wiping the ticks-built forming bar. Merge instead:
      //   • bars already cached stay (history can't shrink or regress)
      //   • fetched bars refresh/patch matching timestamps (authoritative)
      //   • fetched bars newer than the cache extend the history
      const live = entry?.bars ?? [];
      if (live.length) {
        const byT = new Map<number, Bar>();
        for (const b of live) byT.set(b.t, b);
        const liveLast = live[live.length - 1].t;
        let extended = false;
        for (const b of bars) {
          if (b.t > liveLast) { extended = true; break; }
        }
        for (const b of bars) byT.set(b.t, b); // fetched is authoritative for its bars
        let merged = [...byT.values()].sort((a, b) => a.t - b.t);
        if (merged.length > 4000) merged = merged.slice(-4000);
        // sanity: only ACCEPT the merge if the live forming bar survived.
        // (protects against a fetch that somehow ends before our live edge)
        const mergedLast = merged[merged.length - 1];
        if (!extended && mergedLast && mergedLast.t < liveLast) {
          // fetched data is entirely older — keep the live cache untouched
          this.cache.set(key, { bars: live, fetchedAt: Date.now() });
        } else {
          this.cache.set(key, { bars: merged, fetchedAt: Date.now() });
        }
      } else {
        this.cache.set(key, { bars, fetchedAt: Date.now() });
      }
    }
    const cur = this.cache.get(key)!;
    return cur.bars.slice(-limit);
  }

  getQuote(symbol: string) {
    return this.quotes.get(symbol) ?? null;
  }

  symbolList() {
    const out: {
      name: string; digits: number; bid: number; ask: number; mid: number;
      change: number; changePct: number; spread: number; live: boolean; ts: number;
    }[] = [];
    for (const name of this.watch) {
      const info = this.symbols.get(name);
      if (!info) continue; // not resolved on this feed — skip safely
      const q = this.quotes.get(name);
      const prev = this.dayClose.get(name);
      // fallback price when market is closed (no live quote yet):
      // last D1 close → last known mid → seeded price
      let mid = q?.mid ?? 0;
      if (!q) {
        const fallback = prev
          ?? this.lastKnownMid.get(name)
          ?? SIM_SEED[name]?.p
          ?? 0;
        mid = fallback;
        if (fallback && prev) this.lastKnownMid.set(name, fallback);
      } else {
        this.lastKnownMid.set(name, mid);
      }
      const base = prev ?? mid;
      const change = base ? mid - base : 0;
      out.push({
        name,
        digits: info.digits,
        bid: q?.bid ?? mid,
        ask: q?.ask ?? mid,
        mid,
        change,
        changePct: base ? (change / base) * 100 : 0,
        spread: q ? q.ask - q.bid : 0,
        live: q ? this.nowSec() - q.ts < 180 : false,
        ts: q?.ts ?? 0,
      });
    }
    return out;
  }

  private async preloadDayCloses() {
    for (const name of this.watch) {
      try {
        const bars = await this.getCandles(name, "D1", 3);
        if (bars.length >= 2) this.dayClose.set(name, bars[bars.length - 2].c);
        else if (bars.length === 1) this.dayClose.set(name, bars[0].o);
      } catch { /* skip */ }
    }
  }
}
