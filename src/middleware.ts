import { NextResponse } from "next/server";

/**
 * v12.1 API gate (the audit's Critical #1, Next.js side).
 *
 * When APP_PASSWORD is set (Railway always sets it — see
 * start-railway.sh), every /api/* route except the three public ones
 * requires a valid `aurum_sess` session cookie:
 *
 *   PUBLIC  /api/auth          — the login endpoint itself
 *   PUBLIC  /api/setup-status  — deployment healthcheck (secret-free)
 *   PUBLIC  /api/healthz       — aggregate healthcheck (booleans only;
 *                                Docker HEALTHCHECK + Railway probe it
 *                                without a session, audit Phase 0)
 *   GUARDED everything else    — settings, drawings, ai-brain, analysis,
 *                                signals, backtest, mt5-ensure …
 *
 * The page shell `/` stays open on purpose: Railway's healthcheck hits
 * it, and the browser needs to load the app before the owner can log
 * in. The shell carries zero data — every data call 401s until login,
 * and the frontend then shows the login overlay.
 *
 * Unlocked deployments (no APP_PASSWORD — sandbox preview, local dev)
 * pass straight through.
 *
 * HMAC derivation uses Web Crypto (crypto.subtle) so this runs in any
 * middleware runtime and produces the IDENTICAL token to lib/auth.ts
 * and the mt5-service's auth.ts (all: HMAC-SHA256(APP_PASSWORD,
 * "aurum-session-v1")).
 */

const SESSION_COOKIE = "aurum_sess";
const SESSION_LABEL = "aurum-session-v1";
const PUBLIC_PATHS = new Set(["/api/auth", "/api/setup-status", "/api/healthz"]);

async function hmacHex(secret: string, label: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(label));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function middleware(req: Request) {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) return NextResponse.next(); // open deployment (sandbox/dev)

  const url = new URL(req.url);
  if (PUBLIC_PATHS.has(url.pathname)) return NextResponse.next();

  const want = await hmacHex(appPassword, SESSION_LABEL);
  const got = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ?? "";
  if (got && timingSafeEqualHex(got, want)) return NextResponse.next();

  return NextResponse.json(
    { error: "Not authenticated" },
    { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Cookie" } },
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
