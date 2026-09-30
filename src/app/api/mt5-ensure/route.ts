import { NextResponse } from "next/server";
import { armMt5Watchdog, ensureMt5Service, mt5ServiceStatus } from "@/lib/mt5-spawn";

export const dynamic = "force-dynamic";

/**
 * GET /api/mt5-ensure
 * Ensures the mt5-service (ports 3030/3031) is running; spawns it from the
 * Next.js server process if needed, and arms the self-healing watchdog.
 * Safe to call repeatedly.
 */
export async function GET() {
  armMt5Watchdog();
  const before = await mt5ServiceStatus();
  if (before.rest && before.io) {
    return NextResponse.json({ ok: true, mode: "already-running", status: before });
  }
  const result = await ensureMt5Service();
  const after = await mt5ServiceStatus();
  return NextResponse.json({ ...result, before, after });
}
