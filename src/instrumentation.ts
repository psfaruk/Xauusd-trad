/**
 * Next.js instrumentation — runs once when the server process boots.
 *
 * Starts (and keeps alive) the mt5-service market-data microservice
 * (mini-services/mt5-service) as a child of this server process, unless it
 * is already running standalone (sandbox boot script / start-railway.sh).
 *
 * Why: in the sandbox preview environment, background processes started from
 * agent shell commands are reaped when the command ends — the Next.js server
 * (booted at container start, parented to init) is the only reliable parent.
 * The watchdog re-spawns the service if it ever dies mid-session.
 *
 * 24/7 hardening (user: the app must run around the clock in this chat):
 *   · watchdog probes BOTH service ports every 60 s and respawns on death
 *   · a 5-minute keepalive loop re-pings /api/mt5-ensure so the Next server
 *     itself stays warm and any healed state is re-verified forever
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
