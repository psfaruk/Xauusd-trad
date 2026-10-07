import { NextResponse } from "next/server";
import { towerScan } from "@/lib/ai/tower";

/**
 * /api/ai/tower — the Control Tower (v22.0).
 *
 *   GET ?symbol&tf → one supervisor scan: open-decision follow-ups (live
 *   price vs TP/SL), the MTF confluence grid (M5…H4), the news radar, system
 *   health and the agents' rolling activity feed.
 *
 * The scan is cheap by design (candles + DB + a 10-min-cached web search —
 * no LLM calls) and server-cached for 8s, so a 15s client poll is safe.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const TOWER_TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "XAUUSDm").trim().slice(0, 24);
  const tf = url.searchParams.get("tf") ?? "M15";
  if (!/^[A-Za-z0-9_/+.-]{1,24}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  if (!TOWER_TFS.includes(tf)) {
    return NextResponse.json({ error: `unsupported timeframe "${tf}"` }, { status: 400 });
  }
  try {
    const state = await towerScan(symbol, tf);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[ai-tower] scan failed:", e);
    return NextResponse.json({ error: "tower scan failed" }, { status: 503 });
  }
}
