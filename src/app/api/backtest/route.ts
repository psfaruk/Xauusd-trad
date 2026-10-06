import { NextResponse } from "next/server";
import { seedSignals } from "@/lib/market/seed";
import { backtestCandles } from "@/lib/market/candlesticks";
import type { Candle } from "@/lib/market/types";
import { MT5_URL, svcHeaders, getBrokerOffsetSec, spreadFor } from "@/lib/svc";

/**
 * Engine backtest — walk-forward run of the LIVE engine over real MT5
 * history for the requested market+timeframe. No DB writes: this is a pure
 * verification endpoint so the trader can see W/L / totalR / expectancy
 * for the exact detectors that produce live signals.
 */

const CACHE_TTL = 60_000;

/** audit §7.4 (Phase 4) — adverse ENTRY slippage in price units, applied to
 *  the SIMULATED FILLS: every filled signal's entry fills SLIPPAGE units
 *  worse than its level (BUY +, SELL −). SL/TP are fixed price levels, so an
 *  outcome's class (won/lost/expired) never flips — only its R shifts, down
 *  by SLIPPAGE / |entry − sl|. Exits stay clean (entries only, as the audit
 *  asked); spread handling is untouched. BACKTEST_SLIPPAGE=0 disables. */
const BACKTEST_SLIPPAGE = Number(process.env.BACKTEST_SLIPPAGE ?? 0.5);
const cache = new Map<string, { at: number; data: any }>();

async function fetchCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(15_000), headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.bars ?? []) as Candle[];
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "XAUUSDm";
  const tf = url.searchParams.get("tf") ?? "M15";

  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "no-store" } });
  }

  // v16.3: spread now comes from the SHARED spreadFor() (live quote → last
  // known good → per-class default). The old `meta?.spread ?? 0` built a
  // zero-spread world whenever /api/symbols failed — the backtest then
  // admitted trades the LIVE engine (v14 spread fallback) would reject and
  // silently reported better stats than reality.
  const [bars, digits, spread, brokerOffsetSec] = await Promise.all([
    fetchCandles(symbol, tf, 900),
    fetch(`${MT5_URL}/api/symbols`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: svcHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.list?.find((s: any) => s.name === symbol)?.digits ?? 2)
      .catch(() => 2),
    spreadFor(symbol),
    getBrokerOffsetSec(),
  ]);

  const { signals, scanned } = seedSignals({ symbol, tf, digits, spread, bars, brokerOffsetSec });

  // v19.0 — the candlestick-pattern backtest on the SAME bars: every
  // 1–5 candle setup the live engine would print, filled at its trigger
  // close and resolved stop-first over the following 24 bars. Per-pattern
  // win rates + per-candle-count stats — the verification the pattern
  // panel's badges quote (nothing theoretical, all from this symbol+tf).
  const candles = backtestCandles(bars);

  // audit §7.4 (Phase 4): adverse entry slippage on the simulated fills —
  // applied IN PLACE before the stats below so W/L classes stay identical
  // (SL/TP are price levels) while every filled trade's R shifts down by
  // BACKTEST_SLIPPAGE / |entry − sl|. Unfilled (pending/active) and cancelled
  // signals never filled, so they keep their null R untouched.
  if (BACKTEST_SLIPPAGE > 0) {
    for (const s of signals) {
      if (s.status === "cancelled" || s.status === "pending" || s.status === "active") continue;
      if (s.resultR == null) continue;
      const risk = Math.abs(s.entry - s.sl) || 1e-9;
      s.resultR = Math.round((s.resultR - BACKTEST_SLIPPAGE / risk) * 100) / 100;
    }
  }

  const won = signals.filter((s) => s.status === "won").length;
  const lost = signals.filter((s) => s.status === "lost").length;
  const expired = signals.filter((s) => s.status === "expired").length;
  const cancelled = signals.filter((s) => s.status === "cancelled").length;
  const decided = won + lost;
  const totalR = signals.reduce((a, s) => a + (s.resultR ?? 0), 0);
  const avgRR = signals.length ? signals.reduce((a, s) => a + s.rr, 0) / signals.length : 0;
  const byTrigger: Record<string, { n: number; won: number; lost: number; totalR: number }> = {};
  for (const s of signals) {
    const t = (byTrigger[s.trigger] ??= { n: 0, won: 0, lost: 0, totalR: 0 });
    t.n++;
    if (s.status === "won") t.won++;
    if (s.status === "lost") t.lost++;
    t.totalR += s.resultR ?? 0;
  }

  const data = {
    symbol,
    tf,
    digits,
    /** audit §7.4: the adverse-entry slippage the stats already carry (price
     *  units; 0 = off) — surfaced so the UI can label the numbers honestly. */
    slippage: BACKTEST_SLIPPAGE,
    scanned,
    stats: {
      signals: signals.length,
      won,
      lost,
      expired,
      cancelled,
      winPct: decided ? Math.round((won / decided) * 100) : 0,
      totalR: Math.round(totalR * 10) / 10,
      expectancy: signals.length ? Math.round((totalR / signals.length) * 100) / 100 : 0,
      avgRR: Math.round(avgRR * 100) / 100,
      byTrigger,
    },
    candles,
    signals: signals.slice(-40).reverse(),
    generatedAt: Date.now(),
  };
  cache.set(key, { at: Date.now(), data });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
