/**
 * Next.js instrumentation — runs once when the server process boots.
 *
 * Boot responsibilities, in order:
 *   0. Production fail-closed auth gate (audit Phase 0, lib/env.ts
 *      assertProductionEnv) — a production boot with NEITHER
 *      APP_PASSWORD NOR TRADER_API_KEY THROWS here, aborting startup.
 *      Deliberately OUTSIDE any try/catch: the throw IS the feature.
 *      No-op in development and during `next build`
 *      (NEXT_PHASE=phase-production-build) so CI/Docker image builds
 *      never see APP_PASSWORD and still pass.
 *   1. Environment validation (audit §4.2, lib/env.ts) — a missing
 *      required var is reported HERE, at boot, with a clear message —
 *      not later as a stack trace inside some route. Production refuses
 *      to boot on a hard failure; development only warns (the sandbox
 *      must never die on a missing optional var).
 *   2. SQLite PRAGMA bootstrap (audit P3.1, lib/db.ts) — WAL +
 *      busy_timeout + synchronous=NORMAL, fire-and-forget so a PRAGMA
 *      can never block or crash startup.
 *   3. mt5-service sidecar (below) — started and kept alive unless it
 *      is already running standalone (sandbox boot script /
 *      start-railway.sh) or MT5_SKIP_SPAWN=1 (CI build, split compose).
 *
 * Why the sidecar is a child of this server: in the sandbox preview
 * environment, background processes started from agent shell commands
 * are reaped when the command ends — the Next.js server (booted at
 * container start, parented to init) is the only reliable parent.
 * The watchdog re-spawns the service if it ever dies mid-session.
 *
 * 24/7 hardening (user: the app must run around the clock in this chat):
 *   · watchdog probes BOTH service ports every 60 s and respawns on death
 *   · a 5-minute keepalive loop re-pings /api/mt5-ensure so the Next server
 *     itself stays warm and any healed state is re-verified forever
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ── 0. production fail-closed auth gate (audit Phase 0) ──
  // MUST run before any try/catch — a throw from assertProductionEnv()
  // propagates out of register() and aborts server startup (fail-closed).
  // NODE_ENV=development dev server: never reaches the throw (no-op).
  if (process.env.NODE_ENV === "production") {
    const { assertProductionEnv } = await import("./lib/env");
    assertProductionEnv();
  }

  // ── 1. environment validation (audit §4.2) ──
  try {
    const { validateEnv } = await import("./lib/env");
    const check = validateEnv();
    if (!check.ok) {
      const detail = check.issues.map((i) => `  · ${i}`).join("\n");
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[instrumentation] environment validation FAILED:\n${detail}\n` +
            "  Fix the variables above and redeploy — refusing to boot in production.",
        );
        // Node-only hard fail. Unreachable in Edge (the NEXT_RUNTIME
        // guard at the top of register() returns first), but Next ALSO
        // bundles instrumentation.ts for the Edge runtime (this app has
        // middleware) and its static scanner flags a LITERAL
        // `process.exit` as an unsupported Edge API. Call it through
        // globalThis so the edge bundle stays warning-free — the runtime
        // guard is what actually keeps this line node-only.
        (globalThis.process as NodeJS.Process).exit(1);
      }
      // development: loud warning, boot continues — the sandbox must never
      // die on a missing optional var (DATABASE_URL is in .env, so this
      // branch is theoretical today, but it keeps local misconfig visible).
      console.warn(
        `[instrumentation] ⚠ environment validation issues (development — continuing):\n${detail}`,
      );
    }
  } catch (e) {
    console.error("[instrumentation] env validation could not run:", (e as Error).message);
  }

  // ── 2. SQLite PRAGMA bootstrap (audit P3.1) — fire-and-forget ──
  // Runs BEFORE the MT5_SKIP_SPAWN early-return: skip-spawn modes (CI
  // build, split compose app container) still need env checks + pragmas.
  try {
    const { ensureSqlitePragmas } = await import("./lib/db");
    void ensureSqlitePragmas().catch(() => {
      /* never block or crash startup — db.ts already warned per-statement */
    });
  } catch {
    /* importing db.ts failed — the first request will surface it properly */
  }

  if (process.env.MT5_SKIP_SPAWN === "1") return;
  try {
    const { armMt5Watchdog, ensureMt5Service, mt5ServiceStatus } = await import("./lib/mt5-spawn");
    const res = await ensureMt5Service({ waitMs: 15000 });
    console.log(`[instrumentation] mt5-service: ${res.mode}${res.detail ? ` (${res.detail})` : ""}`);
    armMt5Watchdog();

    // 24/7 keepalive — every 5 minutes re-verify + heal the data path.
    // Idempotent and self-limiting: only heals when a port is actually down.
    const g = globalThis as unknown as { __aurumKeepalive?: NodeJS.Timeout };
    if (!g.__aurumKeepalive) {
      g.__aurumKeepalive = setInterval(async () => {
        try {
          const s = await mt5ServiceStatus();
          if (s.rest && s.io) return; // healthy — nothing to do
          console.warn("[instrumentation] keepalive: service down — healing…");
          const r = await ensureMt5Service({ waitMs: 20000 });
          console.log(`[instrumentation] keepalive heal: ${r.mode}${r.detail ? ` (${r.detail})` : ""}`);
        } catch {
          // never throw from the keepalive loop
        }
      }, 5 * 60_000);
      g.__aurumKeepalive.unref?.();
    }
  } catch (e) {
    // never break server boot because of the sidecar
    console.error("[instrumentation] mt5-service spawn failed:", (e as Error).message);
  }
}

