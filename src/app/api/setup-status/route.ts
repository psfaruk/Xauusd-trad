import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mt5ServiceStatus } from "@/lib/mt5-spawn";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup-status — deployment verification helper (PUBLIC, unauthed).
 *
 * After a Railway deploy, hit this endpoint to confirm every piece of the
 * stack came up. v12.1 SECURITY: this route is reachable WITHOUT login
 * (Railway probes + the owner checks the deploy before logging in), so it
 * must leak NOTHING:
 *   · never the DATABASE_URL string (the old response included the full
 *     connection string — path, filename and all)
 *   · never a re-identifiable login mask (the old `abc***xyz` revealed 6 of
 *     an 8-digit MT5 login — only the first 2 digits survive now, and only
 *     so the owner can tell WHICH account is wired up)
 *   · booleans and names only.
 */
export async function GET() {
  const login = process.env.MT5_LOGIN ?? "";
  // first 2 digits max — enough to recognise the account, useless to an attacker
  const masked = login ? `${login.slice(0, 2)}${"*".repeat(Math.max(4, login.length - 2))}` : null;

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
      // v13: MT5 credentials can now be set IN-APP (Settings → MT5 Account,
      // AES-encrypted on disk) — env vars are just one of two ways in.
      mode: process.env.MT5_LOGIN && process.env.MT5_PASSWORD
        ? "LIVE-ready (env credentials)"
        : "MT5 not connected — set it up in Settings → MT5 Account (or set MT5_LOGIN/MT5_PASSWORD env)",
    },
    // v12.1: database presence as a BOOLEAN + volume hint — the actual
    // DATABASE_URL connection string never leaves the process.
    database: { ok: dbOk, persistent: (process.env.DATABASE_URL ?? "").includes("/data/") },
    authLocked: !!(process.env.APP_PASSWORD || process.env.TRADER_API_KEY),
    service: { ...service, url: process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031" },
    broker,
    hint: process.env.MT5_LOGIN && process.env.MT5_PASSWORD
      ? null
      : "Add MT5_LOGIN and MT5_PASSWORD in Railway → Variables, then redeploy for live broker data.",
  });
}
