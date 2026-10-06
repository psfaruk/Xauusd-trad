/**
 * MT5 data manager — one persistent MT5 session with auto-reconnect across
 * gateway IPs, live tick → bar building for every timeframe, a candle cache,
 * broker→UTC offset detection.
 *
 * v13: NO SILENT SIMULATOR. Fake prices masquerading as the real market are
 * strictly worse than no prices (they once fed the trading brain and the
 * chart while the user believed they were watching the real market).
 * v20 replaces that with an HONEST demo mode: when (and only when) no
 * credentials exist, the manager serves a clearly-labelled synthetic feed
 * (source "demo") so the terminal stays explorable — the demo state is
 * visible in every status surface, the trader NEVER trades on it (its
 * execution gates stay locked to source === "mt5"), and demo ticks are
 * never recorded into the real-tick archive. Connecting a real MT5 account
 * from Settings (or MT5_LOGIN / MT5_PASSWORD env) replaces it instantly.
 */

import { Mt5WsClient, TF_CODE, type SymbolInfo, type AccountInfo, type Mt5Position, type Mt5Order, type Mt5Deal, type TradeResult, type TradeSide, type BrokerPush } from "./mt5-client";
import { DemoFeed } from "./demo";
import { FlowTracker, TickRecorder, type FlowPayload } from "./flow";
import { maskLogin } from "./credentials";
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
export type FeedSource = "mt5" | "disconnected" | "demo";
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

/** Verified access IPs for Exness-MT5Trial6 (PROTOCOL.md, 2026-09-27).
 *  Any OTHER server's IPs are resolved live via the MetaQuotes broker
 *  directory under the hardened discovery contract below (audit P2) and
 *  cached with the stored credentials. */
const TRIAL6_GATEWAYS = [
  "47.130.41.116", "57.182.183.85", "16.79.3.122", "18.61.99.175",
  "8.219.172.6", "47.236.224.248", "47.81.62.132", "43.210.112.100",
  "35.154.31.85",
];

// ── discovery hardening (audit P2: external discovery dependency) ──
// The broker directory is an EXTERNAL endpoint this service used to trust
// over plain http with no allowlist, no retry and no result validation.

/** Strict dot-quad parse → octets, or null when malformed (bad shape,
 *  out-of-range octets, leading zeros). Anything unparseable is dropped. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const s = m[i + 1];
    if (s.length > 1 && s.startsWith("0")) return null; // strict: no "010" style
    const n = Number(s);
    if (!Number.isInteger(n) || n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** Public-unicast IPv4 test — rejects 0.0.0.0/8 ("this network"),
 *  10.0.0.0/8 + 172.16.0.0/12 + 192.168.0.0/16 (RFC1918 private),
 *  100.64.0.0/10 (CGNAT), 127.0.0.0/8 (loopback), 169.254.0.0/16
 *  (link-local), 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved,
 *  incl. 255.255.255.255). */
function isPublicIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return false;           // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return false;  // 172.16.0.0/12
  if (a === 192 && b === 168) return false;           // 192.168.0.0/16
  if (a >= 224) return false;                         // 224.0.0.0/4 + 240.0.0.0/4
  return true;
}

/** Expand a strict IPv6 literal to its 8 numeric groups, or null when
 *  invalid (double compression, wrong group count, bad hex, zone ids).
 *  Embedded IPv4 tails (::ffff:1.2.3.4) are folded into their hex groups. */
function ipv6Groups(ip: string): number[] | null {
  if (!ip.includes(":") || ip.includes("%")) return null; // zone ids rejected
  let s = ip;
  const v4 = /^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const oct = ipv4Octets(v4[2]);
    if (!oct) return null;
    s = `${v4[1]}:${((oct[0] << 8) | oct[1]).toString(16)}:${((oct[2] << 8) | oct[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const gs: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      gs.push(parseInt(g, 16));
    }
    return gs;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!tail) return null;
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null; // "::" must cover ≥1 group
    const zeros = new Array<number>(8 - head.length - tail.length).fill(0);
    return [...head, ...zeros, ...tail];
  }
  return head.length === 8 ? head : null;
}

/** Public-unicast IPv6 test — rejects ::/96 (unspecified "::", loopback
 *  "::1", deprecated v4-compatible), fc00::/7 (unique-local), fe80::/10
 *  (link-local) and ff00::/8 (multicast). IPv4-mapped ::ffff:x.x.x.x
 *  addresses are unwrapped and re-checked with the IPv4 rules. */
function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g || g.length !== 8) return false;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    // IPv4-mapped — unwrap the embedded IPv4 and re-check it
    return isPublicIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1, ::x.y
  if ((g[0] & 0xfe00) === 0xfc00) return false;          // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false;          // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return false;          // ff00::/8
  return true;
}

/** SSRF guard for discovery RESULTS (untrusted input): keep only
 *  strict-format public unicast addresses, deduped. A tampered endpoint
 *  must never be able to aim the WS client at internal addresses. */
function filterPublicIps(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cand of candidates) {
    const ip = String(cand ?? "").trim();
    if (!ip || seen.has(ip)) continue;
    const ok = ip.includes(":") ? isPublicIpv6(ip) : isPublicIpv4(ip);
    if (!ok) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

/** Resolve a server name (e.g. "Exness-MT5Real8") to its access IPs.
 *
 *  Hardened contract (audit P2 — discovery is an EXTERNAL dependency this
 *  service must not blindly trust):
 *   · MT5_DISCOVERY_URL — endpoint, default https://search.mtapi.io/Search.
 *     MUST be https: — a non-https configuration throws immediately (fail
 *     closed; never a silent fallback to plain http).
 *   · MT5_DISCOVERY_ALLOW_HOST — discovery-hostname allowlist (default:
 *     exactly "search.mtapi.io"; comma-separated list allowed). Any other
 *     host throws — blocks URL/userinfo tricks that redirect the lookup.
 *   · MT5_DISCOVERY_ENABLED=0 — opt-out for offline/private installs: no
 *     network call at all; resolution falls through to MT5_GATEWAYS.
 *   · MT5_GATEWAYS — manual fallback configuration: comma-separated
 *     IPs/hostnames used when discovery is disabled or unreachable.
 *     Operator-trusted, so NOT run through the public-IP filter (private
 *     installs may legitimately point at LAN gateways).
 *   · Retry: up to 2 attempts, each with a 6s timeout. Only network
 *     errors, 5xx and malformed bodies consume an attempt — a clean 200
 *     without the requested server is a definitive "not found".
 *   · SSRF guard on results: every discovered IP must be a strict-format
 *     PUBLIC unicast address (see filterPublicIps); private, loopback,
 *     link-local, CGNAT, multicast and reserved ranges (v4 and v6) are
 *     dropped, and an all-filtered answer throws.
 *
 *  Throws a human-readable error when the server is unknown — the connect
 *  endpoint surfaces it straight into the Settings form. Logging is one
 *  concise line per resolution; NEVER credentials. */
export async function resolveGateways(server: string): Promise<string[]> {
  // cheap sanity gate: 3–64 chars of letters/digits/dash/dot/underscore.
  // Discovery itself decides whether the server truly exists.
  if (!/^[\w.-]{3,64}$/.test(server)) {
    throw new Error(`invalid server name "${server}"`);
  }
  if (/^Exness-MT5Trial6$/i.test(server)) return [...TRIAL6_GATEWAYS];

  const discoveryUrl = (process.env.MT5_DISCOVERY_URL ?? "https://search.mtapi.io/Search").trim();
  const allowHosts = (process.env.MT5_DISCOVERY_ALLOW_HOST ?? "search.mtapi.io")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowHosts.length) allowHosts.push("search.mtapi.io");
  const manualGateways = (process.env.MT5_GATEWAYS ?? "")
    .split(",").map((g) => g.trim()).filter(Boolean);
  const discoveryEnabled = process.env.MT5_DISCOVERY_ENABLED !== "0";

  const fail = (msg: string): never => {
    console.log("[mt5] discovery:", server, "→", msg);
    throw new Error(msg);
  };

  // opt-out: offline / private installs never touch the network
  if (!discoveryEnabled) {
    if (manualGateways.length) {
      console.log("[mt5] discovery:", server, "→", manualGateways.length, "gateways (MT5_GATEWAYS — discovery disabled)");
      return manualGateways;
    }
    return fail(
      `server "${server}" not found — live discovery disabled (MT5_DISCOVERY_ENABLED=0) and no manual gateways configured (set MT5_GATEWAYS=ip1,ip2)`,
    );
  }

  // fail CLOSED on config, before any network call: https-only + allowlist
  let base: URL;
  try {
    base = new URL(discoveryUrl);
  } catch {
    return fail(`invalid MT5_DISCOVERY_URL "${discoveryUrl}"`);
  }
  if (base.protocol !== "https:") {
    return fail(`discovery endpoint must be https (got ${discoveryUrl})`);
  }
  if (!allowHosts.includes(base.hostname)) {
    return fail(`discovery host ${base.hostname} not allowlisted (set MT5_DISCOVERY_ALLOW_HOST to override)`);
  }

  // live discovery — ≤ 2 attempts, 6s timeout each. Only network errors,
  // 5xx and malformed bodies consume an attempt; a parsed 200 is definitive.
  let resolved: string[] | null = null; // discovery's answer (public IPs only)
  let emptyAnswer = false;              // answered, but every IP was filtered
  let answered = false;                 // got a clean, parseable 200
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r: Response;
    try {
      const u = new URL(base);
      u.searchParams.set("company", server);
      u.searchParams.set("mt5", "true");
      r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    } catch (e) {
      lastErr = `network: ${String((e as Error)?.message ?? "error").slice(0, 120)}`;
      continue;
    }
    if (r.status >= 500) {
      lastErr = `http ${r.status}`;
      continue; // 5xx — retry
    }
    if (!r.ok) {
      lastErr = `http ${r.status}`;
      break; // 4xx — the endpoint refused; retrying cannot help
    }
    let j: { result?: { results?: { name?: string; access?: string[] }[] }[] };
    try {
      j = (await r.json()) as { result?: { results?: { name?: string; access?: string[] }[] }[] };
    } catch {
      lastErr = "malformed response";
      continue; // garbage body — retry once
    }
    answered = true;
    for (const block of j.result ?? []) {
      for (const s of block.results ?? []) {
        if (
          s.name === server &&
          Array.isArray(s.access) && s.access.length
        ) {
          const ips = filterPublicIps(s.access.map((a) => String(a).split(":")[0]));
          if (ips.length) resolved = ips;
          else emptyAnswer = true;
          break;
        }
      }
      if (resolved || emptyAnswer) break;
    }
    break; // a parsed 200 is a definitive answer — never retry it
  }

  if (resolved) {
    console.log("[mt5] discovery:", server, "→", resolved.length, "gateways");
    return resolved;
  }
  if (emptyAnswer) {
    return fail(
      `all resolved gateways for "${server}" were rejected (non-public addresses) — the discovery response may be tampered`,
    );
  }
  if (answered) {
    return fail(
      `server "${server}" not found — check the exact name in your MT5 app (e.g. Exness-MT5Trial6)`,
    );
  }
  // discovery unreachable / refused → manual fallback (the audit's "fallback
  // configuration"), else the standard not-found error
  if (manualGateways.length) {
    console.log("[mt5] discovery:", server, "→", manualGateways.length, `gateways (MT5_GATEWAYS fallback — discovery ${lastErr || "unreachable"})`);
    return manualGateways;
  }
  return fail(
    `server "${server}" not found — discovery unreachable (${lastErr || "no route"}); configure MT5_GATEWAYS=ip1,ip2 as a manual fallback`,
  );
}

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

interface CacheEntry { bars: Bar[]; fetchedAt: number; }

export class Mt5Manager {
  // ── public state ──
  source: FeedSource = "disconnected";
  connected = false;
  symbols = new Map<string, SymbolInfo>();
  watch: string[] = [];
  account: AccountInfo | null = null;
  serverName: string;
  offsetSec = 0; // broker server time − UTC (seconds, 30-min quantized)
  latencyMs: number | null = null;
  reason = "not configured";

  // ── v16 EVENT-FIRST ACCOUNT MIRROR ──
  /** trader hook: a broker push (cmd 14/19/22) just landed — the trader
   *  re-syncs positions/history instantly instead of waiting for its poll. */
  onTradePush: ((ev: BrokerPush) => void) | null = null;
  /** ms-timestamp of the last broker push — the poll paths consult this to
   *  short-circuit their deliberate waiting when the broker already spoke. */
  lastTradePushAt = 0;
  /** account refresh cadence (the status snapshot stays fresh even without pushes) */
  private acctTimer: ReturnType<typeof setInterval> | null = null;
  private acctRefreshAt = 0;

  // ── internal ──
  private client: Mt5WsClient | null = null;
  private _login = 0;
  private _password = "";
  /** gateway IPs for the CURRENT server (resolved via resolveGateways) */
  private gateways: string[] = [...TRIAL6_GATEWAYS];
  /** set by disconnect() — blocks auto-reconnect until new credentials land */
  private manualDisconnect = false;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  // ── v20 DEMO DATA MODE ── when no MT5 account is configured the manager
  //    serves a clearly-labelled synthetic feed (see demo.ts) so the whole
  //    terminal stays explorable; a real connect (Settings → MT5 Account)
  //    replaces it instantly.
  private demo: DemoFeed | null = null;
  /** first no-credentials sighting — demo waits 3s so a stored-credential
   *  auto-connect (boot order race) never flashes through demo first */
  private demoGraceAt = 0;

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

  // ═══════════════ v16 EVENT-FIRST ACCOUNT MIRROR ═══════════════
  // The broker pushes cmd 14/19/22 the MOMENT account state changes (any
  // connection — this app, the user's MT5 terminal, the server's own SL/TP
  // execution). The old app ignored these and polled; balance/equity went
  // stale for seconds and closes were invisible for 30s. Now every push
  // refreshes the account snapshot immediately (one cmd-3 round-trip) and
  // nudges the trader to re-sync positions/history at push latency.
  /**
   * Bound in connectLoop() to client.onTradeEvent. Coalesces bursts (a
   * close often lands as 19+22+14 within a few ms) into ONE account
   * refetch per 250ms — a single push still reflects in one round-trip. */
  private handleTradePush(ev: BrokerPush) {
    this.lastTradePushAt = Date.now();
    const now = Date.now();
    if (now - this.acctRefreshAt >= 250) {
      this.acctRefreshAt = now;
      this.refreshAccount().catch(() => { /* transient — the 5s timer retries */ });
    }
    try { this.onTradePush?.(ev); } catch { /* never let a consumer error kill the socket handler */ }
  }

  /** fresh cmd-3 → this.account → status broadcast (top bar / status bar /
   *  settings all read from the status event, so one broadcast updates them). */
  async refreshAccount() {
    if (!this.connected || this.source !== "mt5" || !this.client) return;
    try {
      const acct = await this.client.account();
      if (!Number.isFinite(acct.equity) || acct.equity <= 0) acct.equity = acct.balance;
      this.account = { ...acct, login: this.login };
      this.emitStatus();
    } catch { /* not connected anymore — reconnect path handles it */ }
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
    // SECURITY: credentials come from env (MT5_LOGIN / MT5_PASSWORD) or from
    // the in-app Settings → MT5 Account form (stored encrypted — see
    // credentials.ts). Never hard-coded in a public repo. Missing creds →
    // the manager sits in the "disconnected" state (v13: no simulator).
    this._login = Number(opts?.login ?? process.env.MT5_LOGIN ?? 0);
    this._password = opts?.password ?? process.env.MT5_PASSWORD ?? "";
  }

  /** The MT5 login currently configured (0 when none) — display only. */
  get login(): number { return this._login; }

  /** True when broker credentials are configured (env or in-app). */
  get hasCredentials(): boolean {
    return !!this._login && !!this._password;
  }

  // ═══════════════ v13: in-app credential control ═══════════════
  /** Live-test credentials WITHOUT touching the persistent session — a
   *  one-shot dial + login + account read on a throw-away socket. Throws a
   *  human-readable error the connect endpoint forwards to the Settings
   *  form. Returns the broker's account snapshot on success. */
  async testCredentials(login: number, password: string, server: string): Promise<{ account: AccountInfo; gateways: string[] }> {
    const gateways = await resolveGateways(server);
    let lastErr: Error | null = null;
    // try up to 2 gateways — a single dead IP must not read as "bad password"
    for (const gw of gateways.slice(0, 2)) {
      let client: Mt5WsClient | null = null;
      try {
        client = await Mt5WsClient.connect(gw);
        await client.auth();
        await client.login(login, password);
        const acct = await client.account();
        if (!Number.isFinite(acct.equity) || acct.equity <= 0) acct.equity = acct.balance;
        return { account: { ...acct, login }, gateways };
      } catch (e) {
        lastErr = e as Error;
      } finally {
        try { client?.close(); } catch { /* already closed */ }
      }
    }
    throw lastErr ?? new Error("Exness gateway unreachable");
  }

  /** Adopt new credentials (Settings → Connect). Recycles the live session
   *  onto the new server immediately. `gateways` may come from the stored
   *  cache (credentials.ts) to skip discovery on boot. */
  applyCredentials(creds: { login: number; password: string; server: string; gateways?: string[] }): void {
    this.manualDisconnect = false;
    this.stopDemo(); // a real account replaces the demo feed instantly
    this.demoGraceAt = 0; // a future no-cred cycle starts its grace fresh
    this._login = creds.login;
    this._password = creds.password;
    this.serverName = creds.server;
    this.gateways = creds.gateways?.length ? creds.gateways : [...TRIAL6_GATEWAYS];
    this.gatewayIdx = 0;
    this.failedRounds = 0;
    this.firstFailAt = 0;
    // drop any session on the OLD server, then dial the new one right away
    this.stopClient();
    this.connected = false;
    this.source = "mt5";
    this.reason = `connecting (${creds.server})`;
    this.emitStatus();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connectLoop(), 100);
  }

  /** Owner-initiated disconnect (Settings → Disconnect / Forget). Kills the
   *  broker session; auto-reconnect stays off until new credentials arrive.
   *  (A plain network drop does NOT set this — connectLoop keeps retrying.) */
  disconnect(reason = "disconnected by owner"): void {
    this.manualDisconnect = true;
    this.stopDemo(); // the owner chose no data — demo must not linger
    this.stopClient();
    this.connected = false;
    this.source = "disconnected";
    this.account = null;
    this.reason = reason;
    this.watch = [];
    this.symbols.clear();
    this.cache.clear();
    this.emitStatus();
  }

  /** Close the broker socket + its heartbeat without touching the rest. */
  private stopClient(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.acctTimer) { clearInterval(this.acctTimer); this.acctTimer = null; }
    try { this.client?.close(); } catch { /* already closed */ }
    this.client = null;
  }

  // ═══════════════ v20: HONEST DEMO MODE ═══════════════
  /** Start the clearly-labelled synthetic feed (only when no credentials
   *  exist). Populates the symbol universe, seeds the quote path and flips
   *  the manager into source "demo" — every downstream consumer (quotes,
   *  bars, flow, analysis) works unchanged; trading stays locked. */
  startDemo(): void {
    if (this.demo) return;
    const feed = new DemoFeed(
      () => this.nowSec(),
      (symbol) => [...(this.activeTfs.get(symbol) ?? [])],
    );
    // demo quotes ride the NORMAL quote path: offset detection, quote map,
    // tick emit, bar building, flow trackers — everything stays consistent
    feed.injectQuote = (symbol, digits, bid, ask) => {
      const div = 10 ** digits;
      this.handleQuote(0, this.nowSec(), Math.round(bid * div), Math.round(ask * div), symbol, digits);
    };
    this.demo = feed;
    // symbol universe + watch list (same shape a real session provides)
    let id = 900000;
    this.symbols.clear();
    for (const name of feed.symbolNames()) {
      this.symbols.set(name, { id: id++, digits: feed.symbolDigits(name), name });
    }
    this.watch = [...this.symbols.keys()];
    this.account = null;          // NO fake balance — demo is data-only
    this.connected = true;        // data flows (quotes/bars), source says demo
    this.source = "demo";
    this.reason = "demo data — connect your MT5 account in Settings for live prices";
    this.cache.clear();
    this.emitStatus();
    feed.start();
    this.preloadDayCloses().catch(() => {}); // change% on the watchlist
    console.log(`[mt5] DEMO DATA MODE — ${this.watch.length} synthetic symbols (no MT5 account connected; trading locked)`);
  }

  /** Stop the demo feed and clear its caches (a real connect, an owner
   *  disconnect, or shutdown). The next state transition owns the status. */
  stopDemo(): void {
    if (!this.demo) return;
    this.demo.stop();
    this.demo = null;
    this.cache.clear();
    this.quotes.clear();
    this.dayClose.clear();
    this.lastKnownMid.clear();
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
    // wedge self-check: a healthy manager recovers within ~2 min. If we
    // stay "mt5 + connecting" for 4 min, the hot-reload wedge or a dead
    // timer loop is certain — exit so the port watchdog respawns us fresh
    // (24/7 resilience).
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
    if (this.acctTimer) { clearInterval(this.acctTimer); this.acctTimer = null; }
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
    this.stopDemo();
    this.client?.close();
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.acctTimer) clearInterval(this.acctTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
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
    // v20: without credentials (and after an owner-initiated disconnect) the
    // HONEST DEMO feed keeps the terminal explorable — clearly labelled,
    // trading stays locked. applyCredentials() pokes connectLoop immediately
    // when the owner connects from Settings; a 3s grace on first boot keeps
    // the stored-credential auto-connect from racing the demo start.
    if (!this.hasCredentials || this.manualDisconnect) {
      if (!this.manualDisconnect && !this.demo) {
        if (!this.demoGraceAt) {
          this.demoGraceAt = Date.now();
          this.connected = false;
          this.source = "disconnected";
          this.reason = "MT5 account not connected — open Settings → MT5 Account";
          this.emitStatus();
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.connectLoop(), 3200);
          return;
        }
        if (Date.now() - this.demoGraceAt < 3000) {
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.connectLoop(), 3200);
          return;
        }
        this.startDemo();
      }
      if (this.demo) {
        // demo owns the state — no polling churn, just a slow env re-check
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connectLoop(), 60_000);
        return;
      }
      this.connected = false;
      this.source = "disconnected";
      this.reason = this.manualDisconnect
        ? "disconnected — reconnect from Settings → MT5 Account"
        : "MT5 account not connected — open Settings → MT5 Account";
      this.emitStatus();
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connectLoop(), 30_000);
      return;
    }
    // outage window starts at the first connect attempt (wedge detection:
    // even a hang INSIDE Mt5WsClient.connect with no retry will be caught)
    if (!this.firstFailAt) this.firstFailAt = Date.now();
    const gw = this.gateways[this.gatewayIdx % this.gateways.length];
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
      await client.login(this.login, this._password);
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
      this.cache.clear(); // server/account switchover → fresh data
      this.emitStatus();
      // audit P2 (credential-log audit): the FULL account number never goes
      // to the logs either — masked form only, same as the API payloads
      console.log(
        `[mt5] connected via ${gw} — account ${maskLogin(this.login) ?? "—"} (${acct.balance.toFixed(2)} ${acct.currency}), ${symbols.size} symbols, watching ${w.length}`,
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
      // v16 EVENT-FIRST: bind the broker's account/trade pushes (cmd 14/19/22).
      // The old app created these events in the client but NEVER bound the
      // handler here — balance went stale, closes invisible for 30s.
      client.onTradeEvent((ev) => this.handleTradePush(ev));

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

      // v16: periodic account refresh (~5s) — the status snapshot (balance/
      // equity in the top bar/status bar/Settings) stays fresh even on a
      // broker that does not push cmd-14, and deposits/withdrawals land
      // within seconds instead of never (the old code read the account
      // exactly ONCE, at connect).
      if (this.acctTimer) clearInterval(this.acctTimer);
      this.acctTimer = setInterval(() => {
        if (this.connected && this.source === "mt5") this.refreshAccount().catch(() => {});
      }, 5000);
      this.acctTimer.unref?.();

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

    // v13: no simulator fallback — a broker outage shows as "reconnecting"
    // everywhere and the stale cache keeps the chart alive meanwhile.
    this.emitStatus();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connectLoop(), delay);
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
    // v14 FIX: the old gate `if (Math.abs(drift) < 900)` tested the WHOLE
    // drift — an Exness server (UTC+2/+3) has |drift| ≈ 7200/10800s, so
    // the gate NEVER fired and offsetSec stayed 0 forever: every bar ship
    // server-local times stamped as "UTC" (killzones/PDH/drawings 2–3h
    // off). Correct logic: quantize FIRST, then trust q when the RESIDUAL
    // (drift − q, i.e. network latency + sub-30m skew) is < 15 min.
    const utcNow = this.nowSec();
    const drift = timeSec - utcNow;
    const q = Math.round(drift / 1800) * 1800;
    const residual = drift - q;
    if (Math.abs(residual) < 900 && q !== this.offsetSec) {
      this.offsetSec = q;
      this.cache.clear(); // re-stamp everything in UTC
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
    // v20: demo ticks must NEVER land in the real-tick archive — the
    // backtest + delta deep-seed replay real tape only
    if (this.source !== "demo") {
      this.recordTick(name, mid);
      this.recordTickRing(name, mid);
    }
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

  async getCandles(symbol: string, tf: string, limit: number): Promise<Bar[]> {
    limit = Math.max(10, Math.min(3000, limit));
    const key = `${symbol}|${tf}`;
    const tfSec = TF_SEC[tf] ?? 60;

    // v20 — DEMO MODE: deterministic synthetic history + the live tick-built
    // continuation (the cache's forming bars win for their timestamps)
    if (this.source === "demo" && this.demo) {
      const entry = this.cache.get(key);
      const bars = this.demo.serveCandles(symbol, tf, limit, entry?.bars ?? null);
      this.cache.set(key, { bars, fetchedAt: Date.now() });
      return bars;
    }

    const entry = this.cache.get(key);
    const stale = !entry || Date.now() - entry.fetchedAt > Math.min(tfSec * 1000 * 0.5, 60000);

    if (stale) {
      // v13: disconnected → no data, loudly. (A stale cache may still serve
      // the chart during a transient reconnect.)
      if (this.source !== "mt5") {
        if (entry?.bars.length) return entry.bars.slice(-limit);
        throw new Error("MT5 not connected — open Settings → MT5 Account");
      }
      let bars: Bar[] = [];
      try {
        bars = await this.fetchCandlesMt5(symbol, tf, limit);
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
      // last D1 close → last known mid. (v13: no seeded sim price — a
      // disconnected feed shows no price, not a fabricated one.)
      let mid = q?.mid ?? 0;
      if (!q) {
        const fallback = prev
          ?? this.lastKnownMid.get(name)
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
