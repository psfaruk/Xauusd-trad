import { NextResponse } from "next/server";
import { seedSignals } from "@/lib/market/seed";
import type { Candle } from "@/lib/market/types";

/**
 * Engine backtest — walk-forward run of the LIVE engine over real MT5
 * history for the requested market+timeframe. No DB writes: this is a pure
 * verification endpoint so the trader can see W/L / totalR / expectancy
 * for the exact detectors that produce live signals.
 */

const MT5_URL = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";
const CACHE_TTL = 60_000;
const cache = new Map<string, { at: number; data: any }>();

async function fetchCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  try {
    const res = await fetch(
      `${MT5_URL}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(15_000) },
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
    return NextResponse.json(hit.data);
  }

  const [bars, symbolsRes] = await Promise.all([
    fetchCandles(symbol, tf, 900),
    fetch(`${MT5_URL}/api/symbols`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const meta = symbolsRes?.list?.find((s: any) => s.name === symbol);
  const digits = meta?.digits ?? 2;
  const spread = meta?.spread ?? 0;

  const { signals, scanned } = seedSignals({ symbol, tf, digits, spread, bars });

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
    signals: signals.slice(-40).reverse(),
    generatedAt: Date.now(),
  };
  cache.set(key, { at: Date.now(), data });
  return NextResponse.json(data);
}
