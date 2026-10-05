import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

/** Signal history for a symbol (+optional timeframe).
 *  v16.9 (audit §2.2): query params are validated with a Zod schema —
 *  invalid input gets a 400 with the issue spelled out, never a Prisma
 *  500; and trace.factors / trace.checks are Array.isArray-guarded (a
 *  corrupt legacy row used to reach SignalsPanel's .map as a truthy
 *  non-array and crash it). */

const QUERY_SCHEMA = z.object({
  symbol: z
    .string()
    .regex(/^[A-Za-z0-9_/+.-]{1,24}$/, "invalid symbol")
    .optional(),
  tf: z
    .string()
    .regex(/^(M1|M5|M15|M30|H1|H4)$/, "unsupported timeframe")
    .optional(),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be ≥ 1")
    .max(200, "limit must be ≤ 200")
    .default(50),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = QUERY_SCHEMA.safeParse({
    symbol: url.searchParams.get("symbol") ?? undefined,
    tf: url.searchParams.get("tf") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid query parameters",
        code: "INVALID_QUERY",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }
  const { symbol, tf: timeframe, limit } = parsed.data;
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
        tp2: typeof trace.tp2 === "number" ? trace.tp2 : undefined,
        rr: h.rr,
        confidence: h.confidence,
        status: h.status,
        resultR: h.resultR,
        barTime: h.barTime,
        // v16.9 (§2.2): shape-guarded — corrupt rows degrade to [], never crash
        factors: Array.isArray(trace.factors) ? trace.factors : [],
        checks: Array.isArray(trace.checks) ? trace.checks : [],
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
