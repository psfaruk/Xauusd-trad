/**
 * gate.ts — THE KEYLESS ENGINE GATE (v23.0).
 *
 * Backtest finding: the built-in z-ai engine endpoint rate-limits (HTTP 429
 * "Too many requests") when too many calls arrive at once — one AI Board
 * meeting alone fires 6, and the old code turned a single 429 into an
 * instant user-facing "API problem". This gate fixes both directions:
 *
 *   · SERIALIZED  — every SDK call in the process goes through ONE queue with
 *                   a minimum spacing between call starts (no more parallel
 *                   bursts of 6)
 *   · RETRIED     — 429s are retried with exponential backoff inside the
 *                   caller's timeout budget before anyone sees an error
 *   · BREAKER     — after repeated 429s the circuit opens for a cooldown
 *                   window; calls fail fast (board degrades to local mode,
 *                   chat shows "engine cooling down") instead of hammering
 *   · HEALTH      — one object (queue depth, last error, cooldown-remaining)
 *                   so the Settings card and the API can show the truth
 *
 * Singleton across HMR via globalThis.
 */

import type { ChatMessage } from "./llm-types";

// ── tunables ────────────────────────────────────────────────────────────────

const MIN_SPACING_MS = 2_200;       // min gap between two SDK call starts
const BACKOFF_STEPS = [1_600, 3_200, 6_400, 12_000]; // 429 backoff ladder
const BREAKER_THRESHOLD = 4;        // consecutive 429s that open the breaker
const BREAKER_COOLDOWN_MS = 25_000; // how long the breaker stays open

// ── state (per process, HMR-safe) ───────────────────────────────────────────

interface GateState {
  queue: Promise<void>;
  lastCallStart: number;
  consec429: number;
  breakerUntil: number;
  /** stats for the health card */
  totalCalls: number;
  total429: number;
  lastErrorAt: number | null;
  lastError: string | null;
  lastOkAt: number | null;
}

const g: GateState = (() => {
  const key = "__aurumAiGate" as const;
  const glob = globalThis as Record<string, unknown>;
  if (!glob[key]) {
    glob[key] = {
      queue: Promise.resolve(),
      lastCallStart: 0,
      consec429: 0,
      breakerUntil: 0,
      totalCalls: 0,
      total429: 0,
      lastErrorAt: null,
      lastError: null,
      lastOkAt: null,
    } satisfies GateState;
  }
  return glob[key] as GateState;
})();

export interface GateHealth {
  /** breaker open → engine is cooling down; calls fail fast with RATE_LIMITED */
  coolingDown: boolean;
  cooldownRemainingMs: number;
  queuedBehind: number;
  minSpacingMs: number;
  stats: { totalCalls: number; total429: number; lastError: string | null; lastErrorAt: number | null; lastOkAt: number | null };
}

export function gateHealth(): GateHealth {
  return {
    coolingDown: Date.now() < g.breakerUntil,
    cooldownRemainingMs: Math.max(0, g.breakerUntil - Date.now()),
    queuedBehind: queueLength,
    minSpacingMs: MIN_SPACING_MS,
    stats: {
      totalCalls: g.totalCalls,
      total429: g.total429,
      lastError: g.lastError,
      lastErrorAt: g.lastErrorAt,
      lastOkAt: g.lastOkAt,
    },
  };
}

// ── the queue ───────────────────────────────────────────────────────────────

let queueLength = 0;

/** chain a job onto the global queue (serialized + spaced) */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = g.queue.then(async () => {
    // spacing: never start sooner than MIN_SPACING after the previous start
    const wait = g.lastCallStart + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    g.lastCallStart = Date.now();
    try {
      return await job();
    } finally {
      queueLength = Math.max(0, queueLength - 1);
    }
  });
  g.queue = run.then(
    () => undefined,
    () => undefined, // never let one rejection break the chain
  );
  queueLength += 1;
  return run;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── SDK body types (mirror z-ai-web-dev-sdk) ────────────────────────────────

export interface SdkChatOptions {
  messages: ChatMessage[];
  /** model id pass-through — null = the endpoint's default GLM */
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  /** total budget INCLUDING retries (the caller's patience) */
  timeoutMs: number;
  /** priority: "chat" waits through cooldowns, "probe" is the breaker test */
  kind?: "chat" | "board" | "probe";
}

export interface SdkChatResult {
  ok: boolean;
  content: string;
  /** what actually served the answer — for the UI badge */
  servedModel: string | null;
  code?: "RATE_LIMITED" | "TIMEOUT" | "PROVIDER_ERROR" | "EMPTY";
  error?: string;
  attempts: number;
}

function classifyError(msg: string): { is429: boolean; isTimeout: boolean } {
  return {
    is429: /status 429|too many requests/i.test(msg),
    isTimeout: /timeout|abort/i.test(msg),
  };
}

/**
 * ONE chat completion through the keyless engine, with the full retry +
 * breaker treatment. Never throws — always returns a classified result.
 */
export function sdkChatComplete(opts: SdkChatOptions): Promise<SdkChatResult> {
  return enqueue(async () => {
    const deadline = Date.now() + opts.timeoutMs;
    let attempt = 0;

    while (true) {
      // breaker check — probes go through; CHAT waits out the cooldown
      // (the user is watching a spinner, a 10-20s patience is fine); board
      // calls fail fast so the meeting degrades to local mode immediately.
      const breakerOpen = Date.now() < g.breakerUntil;
      if (breakerOpen && opts.kind !== "probe") {
        const waitMs = g.breakerUntil - Date.now() + 500;
        if (opts.kind === "chat" && Date.now() + waitMs + 3_000 < deadline) {
          await sleep(waitMs);
          continue; // breaker should be closed now
        }
        return {
          ok: false, content: "", servedModel: null, attempts: Math.max(0, attempt - 1),
          code: "RATE_LIMITED",
          error: `engine cooling down (${Math.ceil((g.breakerUntil - Date.now()) / 1000)}s) — try again shortly`,
        };
      }

      attempt += 1;
      g.totalCalls += 1;

      try {
        const ZAI = (await import("z-ai-web-dev-sdk")).default;
        const zai = await ZAI.create();
        const body: Record<string, unknown> = {
          messages: opts.messages,
          thinking: { type: "disabled" },
        };
        if (opts.model) body.model = opts.model;
        if (typeof opts.temperature === "number") body.temperature = opts.temperature;
        if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;

        const remaining = Math.max(3_000, deadline - Date.now());
        const completion = (await Promise.race([
          zai.chat.completions.create(body as never),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("llm timeout")), remaining),
          ),
        ])) as {
          choices?: { message?: { content?: string } }[];
          model?: string;
        };
        const content = completion.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) {
          g.lastErrorAt = Date.now();
          g.lastError = "empty response";
          return { ok: false, content: "", servedModel: null, code: "EMPTY", error: "empty response", attempts: attempt };
        }
        // success — reset the breaker
        g.consec429 = 0;
        g.breakerUntil = 0;
        g.lastOkAt = Date.now();
        g.lastError = null;
        return {
          ok: true, content, attempts: attempt,
          servedModel: (completion.model as string) || opts.model || null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        g.lastErrorAt = Date.now();
        g.lastError = msg;
        const { is429, isTimeout } = classifyError(msg);

        if (is429) {
          g.total429 += 1;
          g.consec429 += 1;
          if (g.consec429 >= BREAKER_THRESHOLD) {
            g.breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
            g.consec429 = 0;
          }
          // backoff if budget allows
          const backoff = BACKOFF_STEPS[Math.min(attempt - 1, BACKOFF_STEPS.length - 1)];
          if (Date.now() + backoff + 3_000 < deadline) {
            await sleep(backoff);
            continue;
          }
          return {
            ok: false, content: "", servedModel: null, attempts: attempt,
            code: "RATE_LIMITED",
            error: "engine rate limit — it will recover in a moment (the AI Board switched to local mode meanwhile)",
          };
        }

        if (isTimeout) {
          return {
            ok: false, content: "", servedModel: null, attempts: attempt,
            code: "TIMEOUT", error: "engine timed out",
          };
        }

        // a real provider error (bad model id, etc.) — report it
        return {
          ok: false, content: "", servedModel: null, attempts: attempt,
          code: "PROVIDER_ERROR", error: msg.slice(0, 200),
        };
      }
    }
  });
}

/** tiny ping used by the key tester + breaker probe */
export function sdkPing(timeoutMs = 15_000): Promise<SdkChatResult> {
  return sdkChatComplete({
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    timeoutMs,
    kind: "probe",
    maxTokens: 8,
  });
}
