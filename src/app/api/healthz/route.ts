import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MT5_URL, svcHeaders } from "@/lib/svc";

export const dynamic = "force-dynamic";

/**
 * GET /api/healthz — aggregate deployment healthcheck (PUBLIC, unauthed —
 * added to PUBLIC_PATHS in middleware.ts so Docker HEALTHCHECK / Railway /
 * uptime probes can reach it without a session).
 *
 * Three independent checks, run in PARALLEL with individual timeouts so one
 * wedged dependency can never stall the probe itself:
 *
 *   app       — always true; this route answering IS the proof the Next
 *               server process lives.
 *   database  — `SELECT 1` through Prisma, hard 3s ceiling (SQLite's
 *               busy_timeout is 5s — a writer-wedged DB gets cut off here
 *               before Prisma would give up on its own).
 *   mt5       — GET {MT5_URL}/healthz (the sidecar's standard probe path,
 *               unauthenticated JSON), 2.5s timeout. svcHeaders() attached
 *               in case that endpoint ever grows a guard.
 *
 * Status semantics (the honest-restart matrix):
 *   ok       — app + database + mt5 all pass                  → 200
 *   degraded — database passes, mt5 fails                     → 200
 *              The APP is healthy: a broker/MT5 outage is not fixed by
 *              restarting the container, so report it honestly instead of
 *              inviting a restart loop. Operators who WANT restarts on MT5
 *              death add `?strict=1` → 503 on this state.
 *   down     — database fails (regardless of mt5)             → 503
 *              Nothing the container serves is usable without the DB —
 *              this is the one state a restart can actually fix.
 *
 * Payload is secret-free by construction (booleans, uptime, timestamp) —
 * safe to expose unauthenticated.
 */

const DB_TIMEOUT_MS = 3000;
const MT5_TIMEOUT_MS = 2500;

/** Reject after `ms` without leaving stray timers on the success path. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function checkDatabase(): Promise<boolean> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, "database check");
    return true;
  } catch {
    return false;
  }
}

async function checkMt5(): Promise<boolean> {
  try {
    const res = await fetch(`${MT5_URL}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(MT5_TIMEOUT_MS),
      headers: svcHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const strict = new URL(req.url).searchParams.get("strict") === "1";

  const [database, mt5] = await Promise.all([checkDatabase(), checkMt5()]);
  const app = true; // the route answering proves the server lives

  const status: "ok" | "degraded" | "down" = !database
    ? "down"
    : mt5
      ? "ok"
      : "degraded";

  const httpStatus = status === "down" || (strict && status === "degraded") ? 503 : 200;

  return NextResponse.json(
    {
      status,
      checks: { app, database, mt5 },
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}
