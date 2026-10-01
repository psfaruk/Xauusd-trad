/**
 * svc.ts (v14) — server-to-mt5-service helpers.
 *
 * The mt5-service REST endpoints now require auth (the audit's dual-door
 * finding: market REST behind Caddy was open). Every Next.js server-side
 * call into 127.0.0.1:3031 must carry the derived trader key — same
 * derivation as the service side (src/lib/auth.ts), so it validates.
 *
 * Also carries the broker UTC offset (manager.offsetSec) so consumers can
 * thread it into the engine (PDH/PDL day cut = server-local midnight =
 * NY 17:00), cached for 60s.
 */
import { traderApiKey } from "@/lib/auth";

export const MT5_URL = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";

/** Headers every server→service call must attach (open mode: no-op). */
export function svcHeaders(): Record<string, string> {
  const k = traderApiKey();
  return k ? { "x-trader-key": k } : {};
}

let offsetCache: { at: number; value: number } | null = null;

// ── v16.3 SPREAD FALLBACK (shared: analysis + backtest routes) ──
// The v14 audit: fetchSpread failing returned 0 → the spread gate silently
// PASSED and geometry built too-tight SLs. The analysis route got a fallback
// (last known good per symbol → per-class default); the BACKTEST route never
// did — a dead quote fetch made the backtest run in a zero-spread world,
// reporting better stats than the live engine can produce. One shared helper
// now backs both, so they can never diverge again.
const lastGoodSpread = new Map<string, number>();
const DEFAULT_SPREADS: Record<string, number> = {
  XAUUSD: 0.30, XAGUSD: 0.04, BTCUSD: 40, ETHUSD: 2.5,
  USOIL: 0.06, UKOIL: 0.06, USTEC: 3, US500: 0.9, US30: 2,
  EURUSD: 0.00016, GBPUSD: 0.00018, AUDUSD: 0.00018, NZDUSD: 0.00020,
  USDCAD: 0.0002, USDCHF: 0.0002, EURJPY: 0.02, GBPJPY: 0.03, USDJPY: 0.015,
};
function defaultSpread(symbol: string): number {
  if (/XAU/i.test(symbol)) return DEFAULT_SPREADS.XAUUSD;
  if (/XAG/i.test(symbol)) return DEFAULT_SPREADS.XAGUSD;
  if (/BTC/i.test(symbol)) return DEFAULT_SPREADS.BTCUSD;
  if (/ETH/i.test(symbol)) return DEFAULT_SPREADS.ETHUSD;
  if (/OIL/i.test(symbol)) return DEFAULT_SPREADS.USOIL;
  if (/USTEC|US500|US30|NAS|SPX|DJ/i.test(symbol)) {
    if (/USTEC|NAS/i.test(symbol)) return DEFAULT_SPREADS.USTEC;
    if (/US30|DJ/i.test(symbol)) return DEFAULT_SPREADS.US30;
    return DEFAULT_SPREADS.US500;
  }
  if (/JPY/i.test(symbol)) return DEFAULT_SPREADS.EURJPY;
  if (/EUR|GBP|AUD|NZD|CAD|CHF/i.test(symbol)) return DEFAULT_SPREADS.EURUSD;
  return 0.25; // unknown symbol class — conservative flat default
}

/** Live spread for a symbol — NEVER 0 by accident: live quote → last known
 *  good → per-class default. Cache-free callers get the same guarantees the
 *  live engine has. */
export async function spreadFor(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${MT5_URL}/api/quote?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: svcHeaders(),
    });
    if (res.ok) {
      const q = await res.json();
      const sp = q.spread ?? 0;
      if (sp > 0) {
        lastGoodSpread.set(symbol, sp);
        return sp;
      }
    }
  } catch {
    /* fall through to the fallbacks */
  }
  return lastGoodSpread.get(symbol) ?? defaultSpread(symbol);
}

/**
 * Broker server clock − UTC, 30-min quantized (Exness GMT+2/+3 → 7200/10800).
 * Used for the forex-day cut (server-local midnight = NY 17:00) in PDH/PDL
 * grouping. Falls back to the last known value; 0 when never known.
 */
export async function getBrokerOffsetSec(): Promise<number> {
  if (offsetCache && Date.now() - offsetCache.at < 60_000) return offsetCache.value;
  try {
    const res = await fetch(`${MT5_URL}/api/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      headers: svcHeaders(),
    });
    if (res.ok) {
      const j = (await res.json()) as { offsetSec?: number };
      const v = Number(j.offsetSec ?? 0);
      if (Number.isFinite(v)) {
        offsetCache = { at: Date.now(), value: v };
        return v;
      }
    }
  } catch {
    /* fall through to last known */
  }
  return offsetCache?.value ?? 0;
}

// v16.3 cache-bust: Turbopack HMR invalidates on content hash, not mtime.

