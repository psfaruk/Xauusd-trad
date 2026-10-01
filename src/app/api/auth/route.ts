import { NextResponse } from "next/server";
import {
  authRequired,
  clearCookieHeader,
  hasValidSession,
  rateLimit,
  sessionCookieHeader,
  sessionToken,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth — login status for the frontend gate.
 *   { authRequired: boolean, authenticated: boolean }
 *   · authRequired=false → deployment is open (sandbox/local), no gate.
 *   · authRequired=true & !authenticated → frontend shows the login overlay.
 */
export async function GET(req: Request) {
  const authed = hasValidSession(req.headers.get("cookie"));
  return NextResponse.json(
    { authRequired: authRequired(), authenticated: authRequired() ? authed : true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/auth { password } — verify (timing-safe) and issue the
 * `aurum_sess` HttpOnly cookie. 10 attempts/min/IP.
 */
export async function POST(req: Request) {
  if (!authRequired()) {
    return NextResponse.json({ ok: true, open: true }); // nothing to log into
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!rateLimit(`login:${ip}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts — try again in a minute." },
      { status: 429 },
    );
  }
  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    /* fallthrough → wrong-password path */
  }
  if (!password || !verifyPassword(password)) {
    return NextResponse.json({ ok: false, error: "Wrong password" }, { status: 401 });
  }
  const token = sessionToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Auth misconfigured" }, { status: 500 });
  }
  return NextResponse.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookieHeader(token), "Cache-Control": "no-store" } },
  );
}

/** DELETE /api/auth — log out (clear the cookie). */
export async function DELETE() {
  return NextResponse.json(
    { ok: true },
    { headers: { "Set-Cookie": clearCookieHeader(), "Cache-Control": "no-store" } },
  );
}
