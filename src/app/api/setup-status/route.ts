import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mt5ServiceStatus } from "@/lib/mt5-spawn";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup-status — deployment verification helper.
 *
 * After a Railway deploy, hit this endpoint to confirm every piece of the
 * stack came up: env credentials, the mt5-service sidecar, and the SQLite
 * database. Returns booleans only — never secrets (login is masked).
 */
export async function GET() {
  const login = process.env.MT5_LOGIN ?? "";
  const masked = login
    ? login.length <= 4
      ? "*".repeat(login.length)
      : `${login.slice(0, 3)}***${login.slice(-3)}`
    : null;

  let service: { rest: boolean; io: boolean } = { rest: false, io: false };
  try {
    service = await mt5ServiceStatus();
  } catch {
    /* probe failure = both down */
  }

  let dbOk = false;
  try {
    await db.$queryRawUnsafe("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  let broker: { source: string; server: string; reason: string } | null = null;
  try {
    const r = await fetch(
      `${process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031"}/api/status`,
      { cache: "no-store", signal: AbortSignal.timeout(4000) },
    );
    if (r.ok) {
      const j = (await r.json()) as { source?: string; server?: string; reason?: string };
      broker = {
        source: j.source ?? "unknown",
        server: j.server ?? "unknown",
        reason: j.reason ?? "",
      };
    }
  } catch {
    broker = null;
  }

  return NextResponse.json({
    ok: dbOk && service.rest,
    app: { env: process.env.NODE_ENV ?? "development", gatewayPort: process.env.PORT ?? null },
    credentials: {
      mt5LoginSet: !!process.env.MT5_LOGIN,
      mt5PasswordSet: !!process.env.MT5_PASSWORD,
      mt5Server: process.env.MT5_SERVER ?? "Exness-MT5Trial6 (default)",
      loginMasked: masked,
      mode: process.env.MT5_LOGIN && process.env.MT5_PASSWORD ? "LIVE-ready" : "SIM (credentials missing)",
    },
    service: { ...service, url: process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031" },
    database: { ok: dbOk, url: process.env.DATABASE_URL ?? null },
    broker,
    hint:
      process.env.MT5_LOGIN && process.env.MT5_PASSWORD
        ? null
        : "Add MT5_LOGIN and MT5_PASSWORD in Railway → Variables, then redeploy for live broker data.",
  });
}
