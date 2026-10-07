/**
 * tower.ts — THE CONTROL TOWER (v22.0).
 *
 * User spec (বাংলা): প্রত্যেকটি এজেন্ট রিয়েল টাইমে পুরো অ্যাপটিকে কন্ট্রোল ও
 * ফলোআপ রাখবে — every agent follows the whole app in real time. The Tower is
 * that supervisor: one scan answers "what is the market doing to our open
 * decisions, what do all timeframes agree on, is news dangerous, is the
 * system healthy".
 *
 *   · follow-ups  — every OPEN board decision tracked against the LIVE price:
 *                   distance to TP/SL in price + ATR units, progress meter,
 *                   near_tp / near_sl warnings
 *   · MTF grid    — bias for M5…H4: the freshest AI Board meeting when there
 *                   is one, the board's deterministic local brain otherwise —
 *                   the confluence verdict is what "the app + AI agree on"
 *   · news radar  — real web headlines (z-ai web_search, 10 min cache) + a
 *                   high-impact window flag (CPI / NFP / FOMC / Fed …)
 *   · health      — feed up/down, board W/L record
 *   · events      — a rolling activity feed of what the agents noticed
 *
 * Cheap by design: one scan is candle fetches + one DB read + (at most one
 * web search per 10 min) — NO LLM calls. The LLMs debate on the Board; the
 * Tower watches between meetings.
 */

import { db } from "@/lib/db";
import { MT5_URL, svcHeaders, spreadFor } from "@/lib/svc";
import { buildBoardContext, localBoardRead } from "@/lib/market/board";
import type { Candle } from "@/lib/market/types";

// ── mt5-service helpers (small local copies — the tower never blocks) ───────

async function twFetchCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000), headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.bars ?? []) as Candle[];
  } catch {
    return [];
  }
}

async function twFetchQuote(symbol: string): Promise<{ bid: number | null; ask: number | null } | null> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/quote?symbol=${encodeURIComponent(symbol)}`,
      { cache: "no-store", signal: AbortSignal.timeout(4_000), headers: svcHeaders() },
    );
    if (!res.ok) return null;
    const q = await res.json();
    return {
      bid: Number.isFinite(Number(q.bid)) ? Number(q.bid) : null,
      ask: Number.isFinite(Number(q.ask)) ? Number(q.ask) : null,
    };
  } catch {
    return null;
  }
}

async function twFeedOk(): Promise<boolean> {
  try {
    const res = await fetch(`${MT5_URL}/api/status`, {
      cache: "no-store", signal: AbortSignal.timeout(3_000), headers: svcHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function twDigits(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${MT5_URL}/api/symbols`, {
      cache: "no-store", signal: AbortSignal.timeout(4_000), headers: svcHeaders(),
    });
    if (!res.ok) return 2;
    const j = await res.json();
    return j?.list?.find((s: { name: string }) => s.name === symbol)?.digits ?? 2;
  } catch {
    return 2;
  }
}

// ── news radar (real web search, cached 10 min) ─────────────────────────────

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  date: string;
}

interface NewsCache {
  at: number;
  items: NewsItem[];
  error: string | null;
}

let newsCache: NewsCache | null = null;
const NEWS_TTL = 10 * 60_000;

const HIGH_IMPACT_RE =
  /\b(cpi|nfp|non-?farm|fomc|federal reserve|the fed|rate (cut|hike|decision|hold)|powell|inflation|jobs report|pce|gdp|war|strike|escalation)\b/i;

export interface NewsRadar {
  items: NewsItem[];
  fetchedAt: number | null;
  error: string | null;
  /** true when a high-impact headline is live — the board's news veto context */
  riskWindow: boolean;
  /** compact headline list injected into the board's market snapshot */
  headlines: string[];
}

export async function getNewsRadar(symbol: string, force = false): Promise<NewsRadar> {
  if (!force && newsCache && Date.now() - newsCache.at < NEWS_TTL) {
    return decorateNews(newsCache);
  }
  let items: NewsItem[] = [];
  let error: string | null = null;
  try {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    const zai = await ZAI.create();
    const results = (await zai.functions.invoke("web_search", {
      query: `${/XAU/i.test(symbol) ? "gold XAUUSD price" : `${symbol} forex`} news today Fed CPI NFP FOMC rates`,
      num: 8,
      recency_days: 2,
    })) as unknown;

    if (Array.isArray(results)) {
      items = results
        .slice(0, 8)
        .map((r) => {
          const it = r as { name?: unknown; host_name?: unknown; url?: unknown; date?: unknown };
          return {
            title: String(it.name ?? "").trim().slice(0, 200),
            source: String(it.host_name ?? "").replace(/^www\./, ""),
            url: String(it.url ?? ""),
            date: String(it.date ?? ""),
          };
        })
        .filter((i) => i.title.length > 8);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "news search unavailable";
  }
  newsCache = { at: Date.now(), items, error };
  return decorateNews(newsCache);
}

function decorateNews(c: NewsCache): NewsRadar {
  const riskWindow = c.items.some((i) => HIGH_IMPACT_RE.test(i.title));
  const headlines = c.items.slice(0, 6).map((i) => i.title);
  return {
    items: c.items,
    fetchedAt: c.at,
    error: c.error,
    riskWindow,
    headlines,
  };
}

// ── the tower state ─────────────────────────────────────────────────────────

export interface TowerFollowUp {
  id: string;
  tf: string;
  action: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  createdAt: string;
  /** 0 at entry, +100 at TP, −100 at SL (clamped) */
  progressPct: number | null;
  distTp: number | null;
  distSl: number | null;
  distTpAtr: number | null;
  distSlAtr: number | null;
  state: "profit" | "loss" | "near_tp" | "near_sl" | "waiting";
}

export interface TowerEvent {
  at: string;
  agent: string;
  text: string;
  tone: "info" | "up" | "down" | "warn";
}

export interface TowerMtfCell {
  tf: string;
  bias: "BUY" | "SELL" | "HOLD";
  source: "ai" | "local";
  ageBars: number;
  consensus: number;
}

export interface TowerState {
  symbol: string;
  tf: string;
  price: number | null;
  updatedAt: string;
  health: {
    feed: "ok" | "down";
    winPct: number;
    total: number;
    openCount: number;
    boardDegraded: boolean;
  };
  followUps: TowerFollowUp[];
  mtf: TowerMtfCell[];
  confluence: { buy: number; sell: number; hold: number; verdictBn: string };
  news: { items: NewsItem[]; riskWindow: boolean; fetchedAt: string | null; error: string | null };
  events: TowerEvent[];
}

const MTF_TFS = ["M5", "M15", "M30", "H1", "H4"] as const;
const TF_SEC: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400,
};

// rolling activity feed (in-process) + per-key dedupe so a 15s poll never
// spams the same warning twice
const events: TowerEvent[] = [];
const eventKeys = new Map<string, number>();
const EVENT_TTL = 30 * 60_000;

function pushEvent(key: string, ev: Omit<TowerEvent, "at">, dedupeMs = 5 * 60_000): void {
  const now = Date.now();
  const last = eventKeys.get(key) ?? 0;
  if (now - last < dedupeMs) return;
  eventKeys.set(key, now);
  events.unshift({ ...ev, at: new Date(now).toISOString() });
  if (events.length > 40) events.length = 40;
  // prune old dedupe keys
  for (const [k, t] of eventKeys) if (now - t > EVENT_TTL) eventKeys.delete(k);
}

// MTF deterministic reads cached per closed bar (cheap — never refetched mid-bar)
const mtfCache = new Map<string, { at: number; cell: TowerMtfCell }>();

// whole-scan cache: the client polls every 15s; identical scans inside 8s
// return the previous state instead of re-fetching everything
let scanCache: { key: string; at: number; state: TowerState } | null = null;

export async function towerScan(symbol: string, tf: string): Promise<TowerState> {
  const key = `${symbol}|${tf}`;
  if (scanCache && scanCache.key === key && Date.now() - scanCache.at < 8_000) {
    return scanCache.state;
  }

  // ── parallel fan-out: quote + digits + spread + news + feed + open rows ──
  const [quote, digits, spread, news, feedOk, openRows] = await Promise.all([
    twFetchQuote(symbol),
    twDigits(symbol),
    spreadFor(symbol),
    getNewsRadar(symbol),
    twFeedOk(),
    db.boardSession.findMany({
      where: { symbol, status: "open", action: { not: "HOLD" } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }).catch(() => []),
  ]);

  const price = quote?.bid ?? null;

  // ── follow-ups: every open decision vs the live price ──
  const atrByTf = new Map<string, number>();
  async function atrFor(t: string): Promise<number> {
    if (atrByTf.has(t)) return atrByTf.get(t)!;
    const bars = await twFetchCandles(symbol, t, 120);
    const win = bars.filter((b) => !b.f).slice(-80);
    // ATR(14) by hand (indicators.atr needs the lib import — keep the tower light)
    let atr = 0;
    if (win.length >= 15) {
      const trs: number[] = [];
      for (let i = 1; i < win.length; i++) {
        const b = win[i];
        const p = win[i - 1];
        trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
      }
      const r = trs.slice(-14);
      atr = r.reduce((a, v) => a + v, 0) / Math.max(1, r.length);
    }
    atrByTf.set(t, atr);
    return atr;
  }

  const followUps: TowerFollowUp[] = [];
  for (const row of openRows) {
    const a = await atrFor(row.timeframe);
    const buy = row.action === "BUY";
    const prog =
      price == null || !row.entry || !row.tp
        ? null
        : Math.max(-100, Math.min(100, ((price - row.entry) / (row.tp - row.entry)) * (buy ? 100 : -100)));
    const distTp = price != null && row.tp ? Math.abs(row.tp - price) : null;
    const distSl = price != null && row.sl ? Math.abs(row.sl - price) : null;
    let state: TowerFollowUp["state"] = "waiting";
    if (prog != null) {
      if (prog >= 80) state = "near_tp";
      else if (prog <= -60) state = "near_sl";
      else if (prog > 0) state = "profit";
      else state = "loss";
    }
    followUps.push({
      id: row.id,
      tf: row.timeframe,
      action: row.action as "BUY" | "SELL",
      entry: row.entry ?? 0,
      sl: row.sl ?? 0,
      tp: row.tp ?? 0,
      createdAt: row.createdAt.toISOString(),
      progressPct: prog == null ? null : Number(prog.toFixed(1)),
      distTp: distTp == null ? null : Number(distTp.toFixed(digits)),
      distSl: distSl == null ? null : Number(distSl.toFixed(digits)),
      distTpAtr: distTp != null && a > 0 ? Number((distTp / a).toFixed(2)) : null,
      distSlAtr: distSl != null && a > 0 ? Number((distSl / a).toFixed(2)) : null,
      state,
    });

    if (state === "near_tp") {
      pushEvent(`${row.id}:near_tp`, {
        agent: "Follow-up",
        text: `${row.timeframe} ${row.action} ট্রেড TP-এর ${distTp != null ? distTp.toFixed(digits) : "?"} দূরে — টার্গেট ছুঁই ছুঁই।`,
        tone: "up",
      });
    } else if (state === "near_sl") {
      pushEvent(`${row.id}:near_sl`, {
        agent: "Follow-up",
        text: `${row.timeframe} ${row.action} ট্রেড SL-এর ${distSl != null ? distSl.toFixed(digits) : "?"} দূরে — রিস্ক ম্যানেজমেন্ট দরকার।`,
        tone: "warn",
      });
    }
  }

  // ── MTF confluence grid ──
  const mtf: TowerMtfCell[] = [];
  for (const t of MTF_TFS) {
    const tfSec = TF_SEC[t] ?? 900;
    const latest = await db.boardSession.findFirst({
      where: { symbol, timeframe: t },
      orderBy: { createdAt: "desc" },
    }).catch(() => null);

    if (latest && latest.barTime) {
      const bars = await twFetchCandles(symbol, t, 2);
      const lastT = bars[bars.length - 1]?.t ?? 0;
      const ageBars = lastT ? Math.max(0, Math.round((lastT - latest.barTime) / tfSec)) : 99;
      // fresh AI meeting (≤ 3 bars old) wins; else the deterministic brain
      if (ageBars <= 3 && latest.action !== "HOLD") {
        mtf.push({
          tf: t,
          bias: latest.action as "BUY" | "SELL",
          source: "ai",
          ageBars,
          consensus: latest.consensus,
        });
        continue;
      }
      if (ageBars <= 1) {
        // the AI itself said HOLD one bar ago — respect it
        mtf.push({ tf: t, bias: "HOLD", source: "ai", ageBars, consensus: latest.consensus });
        continue;
      }
    }

    // deterministic read, cached per closed bar
    const cacheKey = `${symbol}|${t}`;
    const barsNow = await twFetchCandles(symbol, t, 260);
    const closed = barsNow.filter((b) => !b.f);
    const barT = closed[closed.length - 1]?.t ?? 0;
    const hit = mtfCache.get(`${cacheKey}|${barT}`);
    if (hit) {
      mtf.push(hit.cell);
      continue;
    }
    let cell: TowerMtfCell;
    if (closed.length >= 60) {
      const ctx = buildBoardContext(symbol, t, { [t]: closed }, spread, digits, {
        balance: null, engineSignal: null, recentBoard: [],
      });
      const r = localBoardRead(ctx);
      cell = { tf: t, bias: r.bias, source: "local", ageBars: 0, consensus: r.consensus };
    } else {
      cell = { tf: t, bias: "HOLD", source: "local", ageBars: 0, consensus: 0 };
    }
    mtfCache.set(`${cacheKey}|${barT}`, { at: Date.now(), cell });
    if (mtfCache.size > 60) {
      // prune: entries older than 2 hours
      const cut = Date.now() - 2 * 3_600_000;
      for (const [k, v] of mtfCache) if (v.at < cut) mtfCache.delete(k);
    }
    mtf.push(cell);
  }

  const buy = mtf.filter((c) => c.bias === "BUY").length;
  const sell = mtf.filter((c) => c.bias === "SELL").length;
  const hold = mtf.length - buy - sell;
  const verdictBn =
    buy >= 4 ? `বহু টাইমফ্রেম বুলিশ কনফ্লুয়েন্স (${buy}/${mtf.length}) — আপট্রেন্ড অগ্রাধিকার।`
    : sell >= 4 ? `বহু টাইমফ্রেম বেয়ারিশ কনফ্লুয়েন্স (${sell}/${mtf.length}) — ডাউনট্রেন্ড অগ্রাধিকার।`
    : buy > sell ? `হালকা বুলিশ ঝোঁক (${buy}↑ / ${sell}↓) — কনফার্মেশনের অপেক্ষা।`
    : sell > buy ? `হালকা বেয়ারিশ ঝোঁক (${sell}↓ / ${buy}↑) — কনফার্মেশনের অপেক্ষা।`
    : `টাইমফ্রেমগুলো দিশাহীন (${hold} HOLD) — রেঞ্জ, ধৈর্যই ভালো।`;

  // ── news + health events ──
  if (news.riskWindow) {
    pushEvent(`news:risk:${news.fetchedAt ?? 0}`, {
      agent: "News Radar",
      text: "হাই-ইমপ্যাক্ট নিউজ উইন্ডো সক্রিয় (Fed/CPI/NFP) — এন্ট্রির আগে দুবার ভাবুন।",
      tone: "warn",
    }, 30 * 60_000);
  }
  if (!feedOk) {
    pushEvent("feed:down", {
      agent: "System",
      text: "MT5 ফিড ডাউন — টাওয়ার শেষ জানা দামে ফলোআপ চালিয়ে যাচ্ছে।",
      tone: "down",
    }, 5 * 60_000);
  }

  // ── board record ──
  const statsRows = await db.boardSession.findMany({
    where: { symbol, action: { not: "HOLD" }, status: { in: ["won", "lost"] } },
    orderBy: { createdAt: "desc" },
    take: 40,
  }).catch(() => []);
  const won = statsRows.filter((r) => r.status === "won").length;
  const lost = statsRows.length - won;
  const latestAny = await db.boardSession.findFirst({
    where: { symbol },
    orderBy: { createdAt: "desc" },
  }).catch(() => null);

  const state: TowerState = {
    symbol,
    tf,
    price,
    updatedAt: new Date().toISOString(),
    health: {
      feed: feedOk ? "ok" : "down",
      winPct: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
      total: won + lost,
      openCount: followUps.length,
      boardDegraded: Boolean(latestAny?.degraded),
    },
    followUps,
    mtf,
    confluence: { buy, sell, hold, verdictBn },
    news: {
      items: news.items,
      riskWindow: news.riskWindow,
      fetchedAt: news.fetchedAt ? new Date(news.fetchedAt).toISOString() : null,
      error: news.error,
    },
    events: [...events],
  };

  scanCache = { key, at: Date.now(), state };
  return state;
}
