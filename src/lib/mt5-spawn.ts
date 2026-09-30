/**
 * mt5-service supervisor — ensures the MT5 market-data microservice is
 * running, spawning it as a child of the CURRENT (Next.js server) process.
 *
 * Why this exists: in the sandbox preview environment, background processes
 * started from agent shell commands are reaped when the command ends. The
 * Next.js dev server (started at container boot, parented to init) is the
 * only long-lived process we control, so the data service must be its child.
 *
 * Idempotent: checks the REST/socket.io ports first; skips if already up
 * (e.g. on Railway, where start-railway.sh launches the service standalone).
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const IO_PORT = 3030;
const REST_PORT = 3031;

const G = globalThis as unknown as {
  __mt5Spawned?: boolean;
  __mt5Child?: ChildProcess;
  __mt5Watchdog?: NodeJS.Timeout;
};

function portOpen(port: number, host = "127.0.0.1", timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

/** Locate the mt5-service directory across dev / standalone / Railway layouts. */
function findServiceDir(): string | null {
  const candidates = [
    process.env.MT5_SERVICE_DIR,
    path.join(process.cwd(), "mini-services", "mt5-service"),
    path.join(process.cwd(), "..", "mini-services", "mt5-service"),
    path.join(process.cwd(), "..", "..", "mini-services", "mt5-service"), // standalone build
    "/home/z/my-project/mini-services/mt5-service",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return c;
  }
  return null;
}

export async function ensureMt5Service(
  opts: { waitMs?: number } = {},
): Promise<{ ok: boolean; mode: "already-running" | "spawned" | "no-dir" | "failed"; detail?: string }> {
  // Already up? (standalone service from boot script / Railway)
  if (await portOpen(REST_PORT)) {
    G.__mt5Spawned = true;
    return { ok: true, mode: "already-running" };
  }
  if (G.__mt5Child && !G.__mt5Child.killed) {
    // recently spawned — give it a moment
    if (await portOpen(REST_PORT)) return { ok: true, mode: "spawned" };
  }
  if (G.__mt5Spawned) {
    // We spawned once but it died; allow a respawn attempt.
  }

  const svcDir = findServiceDir();
  if (!svcDir) return { ok: false, mode: "no-dir", detail: "mt5-service directory not found" };

  const logPath = path.resolve(svcDir, "..", "..", "mt5-service.log");
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(logPath, "a");
  } catch {
    logFd = undefined;
  }

  try {
    const child = spawn("bun", ["run", "dev"], {
      cwd: svcDir,
      detached: true, // survives if the Next server restarts
      stdio: logFd !== undefined ? ["ignore", logFd, logFd] : "ignore",
      env: { ...process.env },
    });
    child.unref();
    G.__mt5Child = child;
    G.__mt5Spawned = true;

    // wait for the REST port to accept connections
    const deadline = Date.now() + (opts.waitMs ?? 25000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      if (await portOpen(REST_PORT)) {
        return { ok: true, mode: "spawned", detail: `pid=${child.pid}` };
      }
      if (child.exitCode !== null) {
        // lost a start race (EADDRINUSE) but the service is up → success
        if (await portOpen(REST_PORT)) return { ok: true, mode: "already-running" };
        return { ok: false, mode: "failed", detail: `service exited with code ${child.exitCode}` };
      }
    }
    // final grace check
    if (await portOpen(REST_PORT)) return { ok: true, mode: "spawned" };
    return { ok: false, mode: "failed", detail: "service did not open REST port in time" };
  } catch (e) {
    return { ok: false, mode: "failed", detail: (e as Error).message };
  }
}

/** Quick liveness probe used by the API route. */
export async function mt5ServiceStatus() {
  const [rest, io] = await Promise.all([portOpen(REST_PORT), portOpen(IO_PORT)]);
  return { rest, io, spawnedHere: !!G.__mt5Spawned, childAlive: !!G.__mt5Child && !G.__mt5Child.killed };
}

/**
 * Self-healing watchdog — if the service ever dies, respawn it (checked
 * once a minute). Idempotent; safe to call from instrumentation and the
 * API route alike.
 */
export function armMt5Watchdog(intervalMs = 60_000) {
  if (G.__mt5Watchdog) return;
  let healing = false;
  G.__mt5Watchdog = setInterval(async () => {
    if (healing) return;
    try {
      const s = await mt5ServiceStatus();
      if (s.rest && s.io) return;
      healing = true;
      console.warn("[mt5-spawn] service down — respawning…");
      const r = await ensureMt5Service({ waitMs: 20000 });
      console.log(`[mt5-spawn] respawn: ${r.mode}${r.detail ? ` (${r.detail})` : ""}`);
    } catch {
      // watchdog must never throw
    } finally {
      healing = false;
    }
  }, intervalMs);
  G.__mt5Watchdog.unref?.();
}
