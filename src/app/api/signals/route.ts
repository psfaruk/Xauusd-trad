import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Signal history for a symbol (+optional timeframe). */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const timeframe = url.searchParams.get("tf");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const rows = await db.signalRecord.findMany({
    where: {
      ...(symbol ? { symbol } : {}),
      ...(timeframe ? { timeframe } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const won = rows.filter((r) => r.status === "won").length;
  const lost = rows.filter((r) => r.status === "lost").length;
  const totalR = rows.reduce((a, r) => a + (r.resultR ?? 0), 0);
  return NextResponse.json({
    signals: rows.map((h) => {
      let trace: Record<string, unknown> = {};
      try {
        trace = JSON.parse(h.trace || "{}") as Record<string, unknown>;
      } catch {
        trace = {}; // malformed legacy row → empty trace, never a 500
      }
      return {
        id: h.id,
        symbol: h.symbol,
        timeframe: h.timeframe,
        direction: h.direction,
        trigger: h.trigger,
        entryType: h.entryType,
        entry: h.entry,
        sl: h.sl,
        tp: h.tp,
        rr: h.rr,
        confidence: h.confidence,
        status: h.status,
        resultR: h.resultR,
        barTime: h.barTime,
        factors: trace.factors ?? [],
        checks: trace.checks ?? [],
        createdAt: h.createdAt.toISOString(),
      };
    }),
    stats: {
      total: rows.length,
      won,
      lost,
      winRate: won + lost > 0 ? won / (won + lost) : null,
      totalR: Math.round(totalR * 100) / 100,
    },
  });
}
