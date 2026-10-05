/**
 * env.ts (v16.9) — environment validation (audit §4.2).
 *
 * The app used to read process.env.* in ~10 places with no single
 * chokepoint: a missing var failed at RUNTIME, deep in a route, with a
 * stack trace instead of a message. This module is that chokepoint:
 *   · validateEnv() — run once at server boot (instrumentation.ts).
 *     Hard-fails (process.exit(1)) only in PRODUCTION, and only for
 *     vars that are truly required (DATABASE_URL — without it nothing
 *     works at all). Development just warns loudly: the sandbox must
 *     never die on a missing OPTIONAL var.
 *   · envInfo — resolved, REDACTED view for diagnostics/status pages:
 *     booleans and URLs only. Never a secret's value — only whether it
 *     is set.
 *
 * Optional-with-warning policy: APP_PASSWORD missing in production is
 * the "both auth doors inert" deploy — worth a loud warning, but the
 * operator may genuinely want an open instance, so it never blocks boot.
 */
import { z } from "zod";

const envSchema = z.object({
  /** Prisma datasource (prisma/schema.prisma → env("DATABASE_URL")). Required. */
  DATABASE_URL: z.string().min(1, "must be a non-empty string (Prisma datasource URL)"),
  /** Where the Next server reaches the mt5-service REST API. Optional. */
  MT5_SERVICE_URL: z.string().min(1).default("http://127.0.0.1:3031"),
  /** Login password; also derives the trader API key (lib/auth.ts). Optional. */
  APP_PASSWORD: z.string().optional(),
  /** "1" = never spawn the mt5-service sidecar from this process (CI builds, split compose). */
  MT5_SKIP_SPAWN: z.string().optional(),
});

export type EnvSchema = z.infer<typeof envSchema>;

/**
 * Validate the environment. Returns `{ ok: true }` or
 * `{ ok: false, issues: ["DATABASE_URL: must be …"] }`.
 * Soft checks (APP_PASSWORD in production) only console.warn — they
 * never turn the result false.
 */
export function validateEnv(): { ok: true } | { ok: false; issues: string[] } {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }

  // ── soft checks (warn-only, never fail boot) ──
  if (!parsed.data.APP_PASSWORD && process.env.NODE_ENV === "production") {
    console.warn(
      "[env] APP_PASSWORD is not set — this deploy runs with BOTH auth doors " +
        "open (login + market REST). Set APP_PASSWORD if this instance is reachable " +
        "by anyone but you.",
    );
  }

  return { ok: true };
}

/**
 * Resolved, REDACTED environment view — safe to print or embed in a
 * status endpoint. Contains booleans and the (non-secret) service URL;
 * never a secret value, never the DATABASE_URL connection string.
 * Reserved for future consumers (status page / diagnostics); exported now.
 */
export const envInfo = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrlSet: Boolean(process.env.DATABASE_URL), // set / not-set only
  mt5ServiceUrl: process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031",
  appPasswordSet: Boolean(process.env.APP_PASSWORD), // set / not-set only
  mt5SkipSpawn: process.env.MT5_SKIP_SPAWN === "1",
} as const;
