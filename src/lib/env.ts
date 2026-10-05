/**
 * env.ts (v16.9 → audit Phase 0) — environment validation + the
 * production AUTH GATE.
 *
 * The app used to read process.env.* in ~10 places with no single
 * chokepoint: a missing var failed at RUNTIME, deep in a route, with a
 * stack trace instead of a message. This module is that chokepoint:
 *   · validateEnv() — run once at server boot (instrumentation.ts).
 *     Hard-fails (process.exit(1)) only in PRODUCTION, and only for
 *     vars that are truly required (DATABASE_URL — without it nothing
 *     works at all). Development just warns loudly: the sandbox must
 *     never die on a missing OPTIONAL var.
 *   · assertProductionEnv() — audit Phase 0 FAIL-CLOSED auth gate: a
 *     production server boot with NEITHER APP_PASSWORD NOR a usable
 *     TRADER_API_KEY THROWS, aborting startup. An unlocked public deploy
 *     is the audit's worst finding, so “operator may want it open” is no
 *     longer an accepted default — the explicit escape hatch
 *     ALLOW_INSECURE_MISSING_SECRETS=1 (ephemeral demos) is the only way
 *     past, and it announces itself loudly in the logs.
 *   · envInfo — resolved, REDACTED view for diagnostics/status pages:
 *     booleans and URLs only. Never a secret's value — only whether it
 *     is set.
 *
 * Import-safe on the client: no node APIs at module top level — every
 * check is a plain process.env string read (the crypto-free twin of
 * mt5-service's auth.authConfigured).
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
 * (The auth gate is NOT soft-checked here anymore — assertProductionEnv()
 * below owns it, fail-closed, so the two policies can never diverge.)
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

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Audit Phase 0 — production fail-closed auth gate.
// Mirrors mt5-service's auth.authConfigured(): locked when APP_PASSWORD
// is set, or an explicit TRADER_API_KEY of ≥ 8 chars is present.
// ─────────────────────────────────────────────────────────────────────

/** True when at least one auth door is configured (public deploys must be). */
export function authConfigured(): boolean {
  return !!(
    process.env.APP_PASSWORD ||
    (process.env.TRADER_API_KEY && process.env.TRADER_API_KEY.length >= 8)
  );
}

/**
 * FAIL-CLOSED production gate — call from instrumentation register()
 * BEFORE any try/catch so the throw aborts server startup:
 *   · NODE_ENV !== "production"       → no-op (dev/test never fail)
 *   · NEXT_PHASE === phase-production-build → no-op: `next build` runs
 *     with NODE_ENV=production, and the CI/Docker BUILDS (which never
 *     see APP_PASSWORD) must not be held hostage by a runtime-only
 *     gate. Only a real server boot enforces it.
 *   · ALLOW_INSECURE_MISSING_SECRETS=1 → one loud structured warning,
 *     boot continues (explicit ephemeral-demo opt-in)
 *   · auth not configured              → THROW — the container dies at
 *     boot instead of quietly serving an unlocked public deploy
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  if (process.env.ALLOW_INSECURE_MISSING_SECRETS === "1") {
    console.warn(
      "[env] ⚠ auth is UNLOCKED in production (ALLOW_INSECURE_MISSING_SECRETS=1) — this deploy is not safe to expose",
    );
    return;
  }

  if (!authConfigured()) {
    throw new Error(
      "production started without APP_PASSWORD/TRADER_API_KEY — refusing to run unlocked " +
        "(set APP_PASSWORD, or ALLOW_INSECURE_MISSING_SECRETS=1 for an ephemeral demo)",
    );
  }
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
