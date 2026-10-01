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
