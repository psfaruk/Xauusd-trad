/**
 * mt5-service auth layer (v12 — SECURITY HARDENING).
 *
 * Threat model (the audit): the Railway URL is PUBLIC. Before this module,
 * anyone who knew the URL could POST /api/trader/order and trade a REAL
 * Exness account, close every position, or read the full brain state
 * (positions, journal, balance). CORS was `*` and there was no rate limit.
 *
 * Three locks now:
 *
 *  1. TRADER_API_KEY (server-to-server) — a shared secret the Next.js
 *     server attaches as `x-trader-key` when proxying trading calls.
 *     Resolution order:
 *       · env TRADER_API_KEY (explicit)
 *       · derived from APP_PASSWORD  → HMAC-SHA256(APP_PASSWORD, "aurum-trader-api-key")
 *       · dev fallback "aurum-dev-trader-key" (ONLY safe because the sandbox
 *         gateway is private; start-railway.sh always exports a real random
 *         key in production so this branch never runs there).
 *
 *  2. Session cookie (browser → mt5-service through the same-origin gateway).
 *     When APP_PASSWORD is set, the owner logs in via the app's /api/auth
 *     route and receives `aurum_sess` = HMAC-SHA256(APP_PASSWORD,
 *     "aurum-session-v1") — both processes derive the same value, so the
 *     microservice can validate the cookie WITHOUT any shared database.
 *
 *  3. When NEITHER APP_PASSWORD NOR TRADER_API_KEY is configured, auth is
 *     "open" (local dev / sandbox preview only). start-railway.sh guarantees
 *     a key always exists in production, so the public deploy is never open.
 */

import crypto from "node:crypto";

const DEV_TRADER_KEY = "aurum-dev-trader-key";
export const SESSION_COOKIE = "aurum_sess";

function hmac(secret: string, label: string): string {
  return crypto.createHmac("sha256", secret).update(label).digest("hex");
}

/** Server-to-server trading key (see resolution order above). */
export function traderApiKey(): string {
  const explicit = process.env.TRADER_API_KEY;
  if (explicit && explicit.length >= 8) return explicit;
  const appPw = process.env.APP_PASSWORD;
  if (appPw) return hmac(appPw, "aurum-trader-api-key");
  return DEV_TRADER_KEY;
}

/** The token /api/auth hands to a logged-in browser. */
export function sessionToken(): string | null {
  const appPw = process.env.APP_PASSWORD;
  if (!appPw) return null;
  return hmac(appPw, "aurum-session-v1");
}

/** True when any lock is configured (public deploy must be locked). */
export function authConfigured(): boolean {
  return !!(process.env.APP_PASSWORD || (process.env.TRADER_API_KEY && process.env.TRADER_API_KEY.length >= 8));
}

/** Timing-safe string compare (no early-exit oracle). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still do a comparison to keep timing flat
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
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

export interface AuthCheck {
  ok: boolean;
  /** "key" | "session" | "open" | "none" — for the journal/audit trail */
  via: "key" | "session" | "open" | "none";
}

/**
 * Authorize a trading / private request.
 *  · `x-trader-key` header matching the derived key → ok (server proxy)
 *  · valid session cookie → ok (logged-in owner in the browser)
 *  · no lock configured → ok (dev only — start-railway.sh prevents this in prod)
 */
export function authorizeTradingReq(req: any): AuthCheck {
  if (!authConfigured()) return { ok: true, via: "open" };
  const hdrKey = String(req?.headers?.["x-trader-key"] ?? "");
  if (hdrKey && safeEqual(hdrKey, traderApiKey())) return { ok: true, via: "key" };
  const cookies = parseCookies(req?.headers?.cookie);
  const sess = cookies[SESSION_COOKIE] ?? "";
  const want = sessionToken();
  if (sess && want && safeEqual(sess, want)) return { ok: true, via: "session" };
  return { ok: false, via: "none" };
}

/** Same check for a socket.io handshake (headers live on handshake.headers). */
export function authorizeHandshake(headers: Record<string, string | string[] | undefined>): boolean {
  if (!authConfigured()) return true;
  const cookieHeader = Array.isArray(headers?.cookie) ? headers.cookie.join("; ") : headers?.cookie;
  const cookies = parseCookies(cookieHeader);
  const sess = cookies[SESSION_COOKIE] ?? "";
  const want = sessionToken();
  return !!(sess && want && safeEqual(sess, want));
}

// ───────────────────────── rate limiting ─────────────────────────
// Simple fixed-window limiter, per client IP. Trading POSTs are precious:
// 30/min bursts are plenty for a human and starve brute-forcers.

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  if (b.count > max) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client IP from gateway-forwarded headers. */
export function clientIp(req: any): string {
  const xff = req?.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req?.socket?.remoteAddress ?? "unknown";
}

// periodic scrub so the limiter map can't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();
