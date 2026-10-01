/**
 * Next.js-side auth core (v12.1 — the audit's Critical #1 completion).
 *
 * The mt5-service got its own auth layer in v12, but the Next.js routes
 * stayed open: anyone hitting the PUBLIC Railway URL could PUT
 * /api/settings (rewriting the trader's risk config through our proxy,
 * which attaches the x-trader-key server-side), wipe /api/drawings, or
 * fire /api/ai-brain. This module closes that door with the SAME
 * mechanism the microservice already uses:
 *
 *   APP_PASSWORD set  →  locked. Owner logs in at /api/auth and gets
 *                        `aurum_sess` = HMAC-SHA256(APP_PASSWORD,
 *                        "aurum-session-v1") — HttpOnly, SameSite=Lax.
 *                        mt5-service derives the identical value from
 *                        the identical env var, so one login unlocks
 *                        both processes with zero shared state.
 *   APP_PASSWORD unset →  open (sandbox / local dev only; the Railway
 *                        boot script now ALWAYS exports one).
 */

import crypto from "node:crypto";

export const SESSION_COOKIE = "aurum_sess";
export const TRADER_KEY_LABEL = "aurum-trader-api-key";
export const SESSION_LABEL = "aurum-session-v1";

function hmac(secret: string, label: string): string {
  return crypto.createHmac("sha256", secret).update(label).digest("hex");
}

/** True when this deployment is locked (public deploys must be). */
export function authRequired(): boolean {
  return !!process.env.APP_PASSWORD;
}

/** The token /api/auth hands to a logged-in browser (null when open). */
export function sessionToken(): string | null {
  const pw = process.env.APP_PASSWORD;
  return pw ? hmac(pw, SESSION_LABEL) : null;
}

/** Server-to-server key for mt5-service calls (same derivation as auth.ts). */
export function traderApiKey(): string | null {
  const explicit = process.env.TRADER_API_KEY;
  if (explicit && explicit.length >= 8) return explicit;
  const pw = process.env.APP_PASSWORD;
  return pw ? hmac(pw, TRADER_KEY_LABEL) : null;
}

/** Timing-safe string compare (no early-exit oracle). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Timing-safe password verification (hash first → length-independent). */
export function verifyPassword(candidate: string): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return false; // locked deployments always have a password
  const h1 = crypto.createHmac("sha256", SESSION_LABEL).update(pw).digest();
  const h2 = crypto.createHmac("sha256", SESSION_LABEL).update(candidate).digest();
  return crypto.timingSafeEqual(h1, h2);
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
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

/** Valid session cookie present on this request? */
export function hasValidSession(cookieHeader: string | null | undefined): boolean {
  if (!authRequired()) return true; // open deployment
  const want = sessionToken();
  if (!want) return true;
  const got = parseCookies(cookieHeader)[SESSION_COOKIE] ?? "";
  return !!got && safeEqual(got, want);
}

/** Serialize the Set-Cookie header for a fresh login. */
export function sessionCookieHeader(token: string, maxAgeSec = 12 * 3600): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Logout clears the cookie. */
export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ─────────────────────── login rate limiting ───────────────────────
// 10 attempts / minute / IP — starves brute-force while a human owner
// retries a typo without ever noticing the limit.

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();
