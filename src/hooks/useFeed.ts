"use client";

/**
 * Market feed store — one socket.io connection to mt5-service, candle caches,
 * throttled tick distribution (no re-render storms).
 *
 * Socket:  io("/?XTransformPort=3030")            (gateway → mt5-service socket.io)
 * REST:    /api/mt5/<endpoint>?…                  (same-origin Next.js proxy →
 *         127.0.0.1:3031 — v12.1: the old /api/<ep>?XTransformPort=3031 direct
 *         calls 404'd on every edge that routes /api/* to the app, which
 *         broke the chart history bootstrap in ALL real preview sessions)
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { Candle, FeedStatus, FlowPayload, SymbolQuote, TraderState } from "@/lib/market/types";

export const MT5_WS_PORT = 3030;
/** /api/<mt5-endpoint> → /api/mt5/<mt5-endpoint> (same-origin proxy route). */
export const restUrl = (path: string) =>
  path.startsWith("/api/") ? `/api/mt5/${path.slice(5)}` : path;

const EMPTY: Candle[] = [];
const EMPTY_SYMBOLS: SymbolQuote[] = []; // stable reference — getSnapshot must never return a fresh array
export interface TickPoint { t: number; p: number }

const TICK_RING_MS = 31 * 60_000; // client-side tick history horizon (deep area-chart zoom)
const TICK_RING_MAX = 6500;
const NO_TICKS: TickPoint[] = []; // stable reference — getSnapshot must never return a fresh array

function ringTrim(ring: TickPoint[]) {
  const horizon = Date.now() - TICK_RING_MS;
  while (ring.length > TICK_RING_MAX || (ring.length > 0 && ring[0].t < horizon)) ring.shift();
}

class FeedStore {
  private socket: Socket | null = null;
  private status: FeedStatus | null = null;
  private ticks = new Map<string, SymbolQuote>();
  private symbolsSnapshot: SymbolQuote[] = [];
  private bars = new Map<string, Candle[]>(); // "SYMBOL|tf"
  private barsSnapshot = new Map<string, Candle[]>();
  private symbolSubs = new Set<() => void>();
  private barSubs = new Map<string, Set<() => void>>();
  private statusSubs = new Set<() => void>();
  private keySubs = new Map<string, Set<() => void>>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** v16.3 SIGNATURE — the 250ms flush notifies symbol subscribers only when
   *  the quotes map actually changed (see rebuildSymbols). */
  private symbolsSig = "";
  private fetching = new Map<string, Promise<Candle[]>>();
  private basePrice = new Map<string, number>(); // day-open reference for change%
  private flowSubs = new Map<string, Set<() => void>>(); // "SYMBOL|tf" → flow listeners
  private flowSnapshot = new Map<string, FlowPayload>();
  /** "SYMBOL|tf" → latest cross-candle delta slice (updated ~every 2s) */
  private deepHist = new Map<string, { t: number; d: number }[]>();
  /** v16.3 REFCOUNT (was a Set): in the Flow trio view FocusAreaChart holds
   *  symbol|M1 AND the bare chart holds symbol|<tf> — when tf is M1 both share
   *  ONE key. The Set-based unsubscribe deleted the key (and emitted "unsub"!)
   * when the FIRST holder unmounted, freezing the still-mounted chart's M1
   * stream forever. Count holders; emit "sub" on 0→1, "unsub" on 1→0. */
  private liveBarRefCount = new Map<string, number>();
  private liveFlowKeys = new Set<string>(); // flow keys currently subscribed
  private flowTeardown = new Map<string, ReturnType<typeof setTimeout>>(); // grace timers

  // ── tick history (focus area chart) ──
  private tickHist = new Map<string, TickPoint[]>();
  private tickSnapshots = new Map<string, TickPoint[]>();
  private tickSubs = new Map<string, Set<() => void>>();
  private tickBackfilled = new Set<string>();

  // ── AI trader state ──
  private traderState: TraderState | null = null;
  private traderSubs = new Set<() => void>();
  private traderLive = false;
  /** v14: the deployment is password-locked and the viewer is anonymous — the
   *  server answers the trader room/REST with {locked:true} instead of state */
  private traderLocked = false;

  connect() {
    if (this.socket) return;
    const socket = io("/?XTransformPort=" + MT5_WS_PORT, {
      transports: ["websocket", "polling"],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });
    this.socket = socket;

    // ── v16.3 SYMBOLS SELF-HEAL (30s): change% base refresh, poisoned-quote
    //    repair, liveness. Created on EVERY "connect" and cleared on
    //    "disconnect" — the old code created it once and cleared it on the
    //    FIRST disconnect, so after any reconnect (network blip, service
    //    restart) the heal loop was dead for the rest of the session —
    //    exactly when stale quotes needed repairing.
    let symTimer: ReturnType<typeof setInterval> | null = null;
    const armSymbolHeal = () => {
      if (symTimer) return;
      symTimer = setInterval(() => {
        fetch(restUrl("/api/symbols"))
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.list) {
              for (const q of d.list) {
                // self-heal: the server list is authoritative (same quotes
                // map the ticks come from) — overwrite whenever the server
                // value is newer, so a poisoned one-sided quote (ask=0 from
                // the broker's pre-subscribe frames) can never stick.
                const local = this.ticks.get(q.name);
                const staleLocal = !local || !local.live || (q.ts ?? 0) >= (local.ts ?? 0);
                if (staleLocal) this.ticks.set(q.name, q);
                if (q.mid) this.basePrice.set(q.name, q.mid - q.change);
              }
              this.rebuildSymbols();
            }
          })
          .catch(() => {});
      }, 30_000);
    };

    // self-heal: after ANY reconnect the server rooms are fresh — re-join trader too
    socket.on("connect", () => {
      for (const key of this.liveBarRefCount.keys()) {
        const [symbol, tf] = key.split("|");
        socket.emit("sub", { symbol, tf });
      }
      for (const key of this.liveFlowKeys) {
        const [symbol, tf] = key.split("|");
        socket.emit("flowsub", { symbol, tf });
      }
      if (this.traderLive) socket.emit("tradersub");
      armSymbolHeal(); // v16.3: resurrect the 30s heal on every reconnect
    });

    socket.on("status", (s: FeedStatus) => {
      this.applyStatus(s);
    });
    socket.on("snapshot", (snap: { source: string; quotes: SymbolQuote[] }) => {
      this.ticks.clear();
      for (const q of snap.quotes ?? []) {
        this.ticks.set(q.name, q);
        if (q.changePct !== undefined && q.mid) {
          this.basePrice.set(q.name, q.mid - q.change);
        }
      }
      this.rebuildSymbols();
    });
    socket.on("tick", (t: { symbol: string; bid: number; ask: number; mid: number; ts: number }) => {
      // tick history ring (focus area chart) — every symbol, always
      let ring = this.tickHist.get(t.symbol);
      if (!ring) { ring = []; this.tickHist.set(t.symbol, ring); }
      const tp = { t: Date.now(), p: t.mid };
      ring.push(tp);
      ringTrim(ring);
      const snap = this.tickSnapshots.get(t.symbol);
      if (snap && snap !== ring) { snap.push(tp); ringTrim(snap); }
      this.tickSubs.get(t.symbol)?.forEach((fn) => fn());

      const prev = this.ticks.get(t.symbol);
      const base = this.basePrice.get(t.symbol) ?? prev?.mid ?? t.mid;
      this.ticks.set(t.symbol, {
        name: t.symbol,
        digits: prev?.digits ?? 2,
        bid: t.bid,
        ask: t.ask,
        mid: t.mid,
        change: base ? t.mid - base : 0,
        changePct: base ? ((t.mid - base) / base) * 100 : 0,
        spread: t.ask - t.bid,
        live: true,
        ts: t.ts,
      });
    });
    socket.on("bar", (e: { symbol: string; tf: string; ev: "open" | "update" | "close"; bar: Candle }) => {
      const key = `${e.symbol}|${e.tf}`;
      const arr = this.bars.get(key);
      if (!arr || !arr.length) return;
      const last = arr[arr.length - 1];
      let changed = true;
      if (e.ev === "open") {
        if (last.t < e.bar.t) {
          arr.push({ ...e.bar, f: 1 });
          if (arr.length > 3200) arr.shift();
        } else changed = false;
      } else {
        let idx = arr.length - 1;
        if (arr[idx].t !== e.bar.t) {
          idx = arr.findIndex((b) => b.t === e.bar.t);
          if (idx < 0) return;
        }
        arr[idx] = {
          t: e.bar.t,
          o: e.bar.o,
          h: Math.max(arr[idx].h, e.bar.h),
          l: Math.min(arr[idx].l, e.bar.l),
          c: e.bar.c,
          v: e.bar.v,
          f: e.ev === "update" ? 1 : undefined,
        };
      }
      if (changed) {
        this.barsSnapshot.set(key, arr.slice());
        this.barSubs.get(key)?.forEach((fn) => fn());
      }
    });

    // running-candle order-flow — high-frequency room-scoped stream (≤12.5 Hz)
    socket.on("flow", (p: FlowPayload) => {
      if (!p?.s || !p?.tf) return;
      const key = `${p.s}|${p.tf}`;
      // the cross-candle deep path rides the same stream but only ~every 2s —
      // hold the latest slice in its own map so it survives the emits that
      // don't carry it (the running tail always comes fresh from deltaHist)
      if (p.histDeep?.length) this.deepHist.set(key, p.histDeep);
      this.flowSnapshot.set(key, p);
      this.flowSubs.get(key)?.forEach((fn) => fn());
    });

    // AI trader state stream (room "trader")
    socket.on("trader", (s: TraderState) => {
      this.applyTrader(s);
    });

    // throttled flush → watchlist/header updates at 4 Hz
    this.flushTimer = setInterval(() => this.rebuildSymbols(), 250);
    socket.on("disconnect", () => {
      if (symTimer) { clearInterval(symTimer); symTimer = null; }
    });
  }

  private rebuildSymbols() {
    const next: SymbolQuote[] = [];
    for (const [name, q] of this.ticks) next.push(q);
    // v16.3 IDLE GATE: the 250ms flush used to fan out a notify unconditionally —
    // every useSymbolList consumer (incl. the 1800-line cockpit) re-rendered
    // 4×/s even on a dead-quiet tape. Ticks mutate the map between flushes; no
    // mutation → identical signature → skip. (getQuoteSnapshot still reads the
    // live map, so nothing goes stale — this only skips the no-op re-render.)
    let sig = "";
    for (const q of next) sig += `${q.name}:${q.mid ?? 0}:${q.changePct ?? 0}:${q.live ? 1 : 0}:${q.ts ?? 0};`;
    if (sig === this.symbolsSig) return;
    this.symbolsSig = sig;
    this.symbolsSnapshot = next;
    this.symbolSubs.forEach((fn) => fn());
    for (const name of this.ticks.keys()) {
      this.keySubs.get(`q:${name}`)?.forEach((fn) => fn());
    }
  }

  subscribeBars(symbol: string, tf: string) {
    const key = `${symbol}|${tf}`;
    const n = (this.liveBarRefCount.get(key) ?? 0) + 1;
    this.liveBarRefCount.set(key, n);
    if (n === 1) this.socket?.emit("sub", { symbol, tf }); // first holder joins the room
  }
  unsubscribeBars(symbol: string, tf: string) {
    const key = `${symbol}|${tf}`;
    const n = (this.liveBarRefCount.get(key) ?? 0) - 1;
    if (n > 0) {
      this.liveBarRefCount.set(key, n); // others still hold it — room stays live
      return;
    }
    this.liveBarRefCount.delete(key);
    if (n === 0) this.socket?.emit("unsub", { symbol, tf }); // last holder left
    // n < 0: never subscribed (defensive) — never emit a stray unsub
  }

  subscribeFlow(symbol: string, tf: string, cb: () => void): () => void {
    const key = `${symbol}|${tf}`;
    // React re-subscribe churn guard: if a teardown is pending for this key
    // (the listener set went empty a moment ago), a re-subscribe within the
    // grace window cancels it — the server tracker survives the churn.
    const pending = this.flowTeardown.get(key);
    if (pending) { clearTimeout(pending); this.flowTeardown.delete(key); }
    if (!this.flowSubs.has(key)) this.flowSubs.set(key, new Set());
    const set = this.flowSubs.get(key)!;
    set.add(cb);
    if (!this.liveFlowKeys.has(key)) {
      this.liveFlowKeys.add(key);
      this.socket?.emit("flowsub", { symbol, tf });
    }
    return () => {
      set.delete(cb);
      if (!set.size) {
        this.flowSubs.delete(key);
        this.liveFlowKeys.delete(key);
        // drop the cached payload — a future subscriber must see the honest
        // skeleton, not this stale candle from minutes ago
        this.flowSnapshot.delete(key);
        // GRACE: only release the server tracker if nobody re-subscribes
        // within 250ms. useSyncExternalStore tears down + re-subscribes on
        // every re-render when closures are unstable — without this grace
        // the tracker was deleted & recreated 4×/sec and the panel stayed on
        // its skeleton forever (the exact "data not updating" bug).
        this.flowTeardown.set(key, setTimeout(() => {
          this.flowTeardown.delete(key);
          if (!this.flowSubs.has(key)) {
            this.socket?.emit("flowunsub", { symbol, tf });
          }
        }, 250));
      }
    };
  }
  getFlowSnapshot(key: string): FlowPayload | null {
    return this.flowSnapshot.get(key) ?? null;
  }
  getFlowDeep(key: string): { t: number; d: number }[] {
    return this.deepHist.get(key) ?? EMPTY_DEEP;
  }

  // ── tick history (focus area chart): backfill once + live appends ──
  subscribeTicks(symbol: string, cb: () => void): () => void {
    if (!this.tickSubs.has(symbol)) this.tickSubs.set(symbol, new Set());
    this.tickSubs.get(symbol)!.add(cb);
    if (!this.tickBackfilled.has(symbol)) {
      this.tickBackfilled.add(symbol);
      fetch(restUrl(`/api/ticks?symbol=${symbol}&sec=1800`))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const remote: TickPoint[] = d?.ticks ?? [];
          if (!remote.length) return;
          const local = this.tickHist.get(symbol) ?? [];
          // merge: server ring is authoritative for the past; live local ticks win for the newest edge
          const byT = new Map<number, number>();
          for (const p of local) byT.set(p.t, p.p);
          const remoteLast = remote[remote.length - 1].t;
          for (const p of remote) if (!local.length || p.t <= local[0]?.t || !byT.has(p.t)) byT.set(p.t, p.p);
          // keep any local ticks newer than the backfill edge
          const merged = [...byT.entries()]
            .filter(([t]) => t <= remoteLast || local.some((l) => l.t === t))
            .map(([t, p]) => ({ t, p }))
            .sort((a, b) => a.t - b.t);
          const withLive = local.filter((l) => l.t > remoteLast);
          const next = [...merged, ...withLive];
          ringTrim(next);
          this.tickHist.set(symbol, next);
          this.tickSnapshots.set(symbol, next);
          this.tickSubs.get(symbol)?.forEach((fn) => fn());
        })
        .catch(() => {});
    }
    // seed a snapshot so the chart paints immediately with whatever exists
    if (!this.tickSnapshots.has(symbol)) {
      const ring = this.tickHist.get(symbol);
      if (ring) this.tickSnapshots.set(symbol, ring);
      else {
        // create the ring eagerly so every future getSnapshot returns the SAME array
        const fresh: TickPoint[] = [];
        this.tickHist.set(symbol, fresh);
        this.tickSnapshots.set(symbol, fresh);
      }
    }
    return () => {
      this.tickSubs.get(symbol)?.delete(cb);
    };
  }
  getTicksSnapshot(symbol: string): TickPoint[] {
    const ring = this.tickHist.get(symbol);
    if (ring && ring !== this.tickSnapshots.get(symbol)) {
      this.tickSnapshots.set(symbol, ring);
    }
    return this.tickSnapshots.get(symbol) ?? NO_TICKS;
  }

  // ── AI trader state ──
  /** v14 {locked:true} guard — a password-locked mt5-service answers anonymous
   *  subscribers with `{locked:true}` and NONE of the TraderState fields
   *  (rules/journal/positions are absent), which used to crash every consumer
   *  that touched state.rules. Normalize at the store boundary: locked →
   *  traderState null + traderLocked true (useTraderLocked); a real payload
   *  clears the lock. Both the socket stream and the REST seed go through here. */
  private applyTrader(s: unknown) {
    if (!s || typeof s !== "object") return;
    if ((s as { locked?: unknown }).locked === true) {
      this.traderLocked = true;
      this.traderState = null;
      this.traderSubs.forEach((fn) => fn());
      return;
    }
    // v16.3 SHAPE GATE: a half-shape payload (older service build, future stub
    // variant) must never reach the panels — state.positions.map / state.brain
    // derefs would crash the cockpit. Refuse it (panels keep their
    // "connecting" notice); a well-formed payload clears the lock as usual.
    const p = s as Partial<TraderState>;
    const wellFormed = Array.isArray(p.positions)
      && Array.isArray(p.journal)
      && Array.isArray(p.brain)
      && Array.isArray(p.rules)
      && Array.isArray(p.feelings)
      && p.today != null && typeof p.today === "object";
    if (!wellFormed) return;
    this.traderLocked = false;
    this.traderState = s as TraderState;
    this.traderSubs.forEach((fn) => fn());
  }

  subscribeTrader(fn: () => void): () => void {
    this.traderSubs.add(fn);
    if (!this.traderLive) {
      this.traderLive = true;
      this.socket?.emit("tradersub");
      // REST seed (socket emits only on change) — guarded by applyTrader so a
      // locked deployment's {locked:true} stub never enters the store
      fetch(restUrl("/api/trader"))
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (s) this.applyTrader(s);
        })
        .catch(() => {});
    } else if (this.traderState) fn();
    // v16: the trader stream stays LIVE for the whole app lifetime — never
    // traderunsub. The old cleanup (unsub when the last listener left) meant
    // switching to the Chart tab KILLED the account mirror: a trade closing
    // on MT5 while the user watched the chart went unseen, and returning to
    // Home showed a stale REST snapshot. The socket room costs nothing; the
    // reconnect handler re-emits tradersub because traderLive stays true.
    return () => {
      this.traderSubs.delete(fn);
    };
  }
  getTraderSnapshot(): TraderState | null { return this.traderState; }
  getTraderLocked(): boolean { return this.traderLocked; }

  async postTrader(path: string, body?: unknown): Promise<any> {
    const res = await fetch(restUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    // parse the body either way — a 400 from the trading brain carries the
    // human-readable rejection reason (e.g. "SL must be below bid 89.73")
    const j = await res.json().catch(() => ({} as any));
    return res.ok ? j : { ok: false, error: j?.error ?? `HTTP ${res.status}` };
  }

  async getCandles(symbol: string, tf: string, limit = 600): Promise<Candle[]> {
    const key = `${symbol}|${tf}`;
    const inflight = this.fetching.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const res = await fetch(restUrl(`/api/candles?symbol=${symbol}&tf=${tf}&limit=${limit}`));
      if (!res.ok) throw new Error(`candles fetch failed (${res.status})`);
      const data = await res.json();
      let bars: Candle[] = (data.bars ?? []).map((b: any) => ({
        t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ...(b.f ? { f: 1 } : {}),
      }));
      // ── CLIENT-SIDE MONOTONIC GUARD ──
      // The socket stream may already hold NEWER bars than this REST response
      // (fetch raced a service restart, or the response was cached upstream).
      // Never let a REST payload move the chart BACKWARDS: merge by timestamp,
      // keeping any live bars newer than the payload's last bar.
      const live = this.bars.get(key);
      if (live?.length && bars.length) {
        const payLast = bars[bars.length - 1].t;
        const liveLast = live[live.length - 1].t;
        if (payLast < liveLast) {
          const newer = live.filter((b) => b.t > payLast);
          bars = [...bars, ...newer];
        }
      }
      this.bars.set(key, bars);
      this.barsSnapshot.set(key, bars);
      this.barSubs.get(key)?.forEach((fn) => fn());
      return bars;
    })();
    this.fetching.set(key, p);
    try {
      return await p;
    } finally {
      this.fetching.delete(key);
    }
  }

  // ── snapshots (stable references for useSyncExternalStore) ──
  getStatus() { return this.status; }

  /** store a fresh FeedStatus — the single path the socket "status" handler
   *  and the one-shot REST pull (refreshFeedStatus) both go through. */
  applyStatus(s: FeedStatus) {
    if (!s || typeof s !== "object") return;
    this.status = s;
    this.statusSubs.forEach((fn) => fn());
  }
  getSymbols() { return this.symbolsSnapshot; }
  getBarsSnapshot(key: string) { return this.barsSnapshot.get(key) ?? EMPTY; }
  getQuoteSnapshot(name: string) { return this.ticks.get(name) ?? null; }

  // ── external-store plumbing ──
  subscribeStatus(fn: () => void) {
    this.statusSubs.add(fn);
    if (this.status) fn();
    return () => this.statusSubs.delete(fn);
  }
  subscribeSymbols(fn: () => void) {
    this.symbolSubs.add(fn);
    return () => this.symbolSubs.delete(fn);
  }
  subscribeQuote(name: string, fn: () => void) {
    const key = `q:${name}`;
    if (!this.keySubs.has(key)) this.keySubs.set(key, new Set());
    this.keySubs.get(key)!.add(fn);
    return () => {
      this.keySubs.get(key)?.delete(fn);
    };
  }
  subscribeBarsKey(key: string, fn: () => void) {
    if (!this.barSubs.has(key)) this.barSubs.set(key, new Set());
    this.barSubs.get(key)!.add(fn);
    return () => {
      this.barSubs.get(key)?.delete(fn);
    };
  }

  notifyQuote(name: string) {
    this.keySubs.get(`q:${name}`)?.forEach((fn) => fn());
  }
}

// singleton
const G = globalThis as unknown as { __aurumFeed?: FeedStore };
export const feed = G.__aurumFeed ?? new FeedStore();
G.__aurumFeed = feed;

export function useFeedBoot() {
  useEffect(() => {
    feed.connect();
  }, []);
}

/** One-shot REST status pull — used after MT5 connect/disconnect actions so
 *  the UI updates immediately instead of waiting for the next socket event. */
export function refreshFeedStatus() {
  fetch(restUrl("/api/status"), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((s: FeedStatus | null) => {
      if (s) feed.applyStatus(s);
    })
    .catch(() => {
      /* best effort — the socket stream remains the source of truth */
    });
}

export function useStatus(): FeedStatus | null {
  return useSyncExternalStore(
    (fn) => feed.subscribeStatus(fn),
    () => feed.getStatus(),
    () => null,
  );
}

export function useSymbolList(): SymbolQuote[] {
  return useSyncExternalStore(
    (fn) => feed.subscribeSymbols(fn),
    () => feed.getSymbols(),
    () => EMPTY_SYMBOLS,
  );
}

export function useQuote(symbol: string): SymbolQuote | null {
  return useSyncExternalStore(
    (fn) => feed.subscribeQuote(symbol, fn),
    () => feed.getQuoteSnapshot(symbol),
    () => null,
  );
}

export function useBars(symbol: string, tf: string): Candle[] {
  return useSyncExternalStore(
    (fn) => feed.subscribeBarsKey(`${symbol}|${tf}`, fn),
    () => feed.getBarsSnapshot(`${symbol}|${tf}`),
    () => EMPTY,
  );
}

/** Running-candle order-flow (X-ray) for the active symbol+timeframe.
 *  Subscribe callbacks are memoised so re-renders (live prices tick at 4Hz)
 *  do NOT churn the socket subscription — see subscribeFlow's grace note. */
export function useFlow(symbol: string, tf: string): FlowPayload | null {
  const key = `${symbol}|${tf}`;
  const subscribe = useCallback(
    (fn: () => void) => feed.subscribeFlow(symbol, tf, fn),
    [symbol, tf],
  );
  const getSnapshot = useCallback(() => feed.getFlowSnapshot(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Cross-candle cumulative-delta history for the delta-micro chart — the last
 *  ~2.3 candles, each candle restarting at 0 (updates ride the flow stream,
 *  refreshed ~every 2s by the server). Same subscription as useFlow. */
export function useFlowDeep(symbol: string, tf: string): { t: number; d: number }[] {
  const key = `${symbol}|${tf}`;
  const subscribe = useCallback(
    (fn: () => void) => feed.subscribeFlow(symbol, tf, fn),
    [symbol, tf],
  );
  const getSnapshot = useCallback(() => feed.getFlowDeep(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_DEEP);
}
const EMPTY_DEEP: { t: number; d: number }[] = [];

/** Tick history for the focus area chart (backfilled + live, ~5 min window). */
export function useTicks(symbol: string): TickPoint[] {
  const subscribe = useCallback(
    (fn: () => void) => feed.subscribeTicks(symbol, fn),
    [symbol],
  );
  const getSnapshot = useCallback(() => feed.getTicksSnapshot(symbol), [symbol]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_TICKS);
}
const EMPTY_TICKS: TickPoint[] = [];

/** AI auto-trader live state (socket room "trader" + REST seed). Null when
 *  disconnected OR when the deployment is password-locked ({locked:true}). */
export function useTrader(): TraderState | null {
  const subscribe = useCallback((fn: () => void) => feed.subscribeTrader(fn), []);
  return useSyncExternalStore(subscribe, () => feed.getTraderSnapshot(), () => null);
}

/** v14: true while the trader stream answers {locked:true} (password-locked
 *  deployment, anonymous viewer) — panels use this to show a "log in" notice
 *  instead of the cockpit / an eternal "connecting…" spinner. */
export function useTraderLocked(): boolean {
  const subscribe = useCallback((fn: () => void) => feed.subscribeTrader(fn), []);
  return useSyncExternalStore(subscribe, () => feed.getTraderLocked(), () => false);
}
