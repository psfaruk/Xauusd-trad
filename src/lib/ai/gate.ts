/**
 * gate.ts — THE KEYLESS ENGINE GATE (v24.0 · PRIORITY + ADAPTIVE).
 *
 * Backtest findings (why the user saw "limit exhausted"):
 *   · the built-in engine endpoint rate-limits (429) under burst load — one
 *     AI Board meeting alone fires 6 calls, and with auto-run on M1/M5 the
 *     gate was busy almost continuously, so the user's CHAT kept failing;
 *   · every model id is served by the same engine underneath (the endpoint
 *     answers any `model` with glm-4-plus), so ALL models share ONE budget.
 *
 * v24 fixes, in order of impact:
 *   · PRIORITY QUEUE — user-facing calls (chat · vision · probes) JUMP AHEAD
 *     of background board calls. The user's message is never stuck behind a
 *     6-agent meeting. (This is what makes chat feel UNLIMITED.)
 *   · ADAPTIVE PACING — the min gap between call starts breathes: tightens
 *     (1.2s) on a success streak, widens (up to 6s) after 429s — like TCP
 *     congestion control, so the engine rarely 429s at all.
 *   · PATIENT CHAT — chat/vision calls WAIT OUT cooldowns inside their own
 *     deadline (the user sees "queued…", then the answer) instead of an
 *     instant error; board calls still fail fast to local mode.
 *   · VISION — sdkVisionComplete() runs chart screenshots through the VLM
 *     (createVision) on the same queue with top priority.
 *
 * Singleton across HMR via globalThis.
 */

import type { ChatMessage } from "./llm-types";

// ── tunables ────────────────────────────────────────────────────────────────

const SPACING_MIN = 1_200;          // fastest allowed gap between call starts
const SPACING_MAX = 6_000;          // widest backoff gap
const SPACING_START = 1_500;        // opening gap
const SPACING_GROW = 1.5;           // × this after a 429
const SPACING_DECAY = 150;          // −ms per success (down to SPACING_MIN)
const BACKOFF_STEPS = [1_200, 2_400, 4_800, 9_600]; // 429 retry ladder
const BREAKER_THRESHOLD = 5;        // consecutive 429s that open the breaker
const BREAKER_COOLDOWN_MS = 18_000; // breaker open window

/** priority classes — LOWER runs first; user-facing traffic always wins */
const PRIO = { probe: 0, vision: 1, chat: 1, board: 3 } as const;

// ── state (per process, HMR-safe) ───────────────────────────────────────────

interface GateState {
  /** sorted pending jobs — pumped one at a time, highest priority first */
  pending: { prio: number; thunk: () => Promise<void> }[];
  pumping: boolean;
  lastCallStart: number;
  spacingMs: number;
  consec429: number;
  breakerUntil: number;
  totalCalls: number;
  total429: number;
  /** per-class counters for the health card */
  servedChat: number;
  servedVision: number;
  servedBoard: number;
  lastErrorAt: number | null;
  lastError: string | null;
  lastOkAt: number | null;
}

const g: GateState = (() => {
  const key = "__aurumAiGate" as const;
  const glob = globalThis as Record<string, unknown>;
  const existing = glob[key] as Partial<GateState> | undefined;
  // HMR guard: an older module version's singleton (e.g. v23's promise-chain
  // queue) may live here without `pending` — replace it wholesale. A fresh
  // process always takes the defaults path.
  if (!existing || !Array.isArray(existing.pending) || typeof existing.pumping !== "boolean") {
    glob[key] = {
      pending: [],
      pumping: false,
      lastCallStart: 0,
      spacingMs: SPACING_START,
      consec429: 0,
      breakerUntil: 0,
      totalCalls: 0,
      total429: 0,
      servedChat: 0,
      servedVision: 0,
      servedBoard: 0,
      lastErrorAt: null,
      lastError: null,
      lastOkAt: null,
    } satisfies GateState;
  }
  return glob[key] as GateState;
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── the priority pump ───────────────────────────────────────────────────────

function submit<T>(prio: number, job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    g.pending.push({
      prio,
      thunk: async () => {
        try {
          resolve(await job());
        } catch (e) {
          reject(e);
        }
      },
    });
    // stable priority order — earlier submissions win ties (FIFO within class)
    g.pending.sort((a, b) => a.prio - b.prio);
    void pump();
  });
}

async function pump(): Promise<void> {
  if (g.pumping) return;
  g.pumping = true;
  try {
    while (g.pending.length) {
      // spacing: adaptive gap between two call starts
      const wait = g.lastCallStart + g.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      const next = g.pending.shift();
      if (!next) continue;
      g.lastCallStart = Date.now();
      await next.thunk();
    }
  } finally {
    g.pumping = false;
    // jobs may have arrived while the last one finished
    if (g.pending.length) void pump();
  }
}

// ── health (for the Settings card + the chat UX) ────────────────────────────

export interface GateHealth {
  coolingDown: boolean;
  cooldownRemainingMs: number;
  queuedBehind: number;
  /** v24 — how many of the queued jobs are user-facing (chat/vision) */
  queuedUser: number;
  /** v24 — current adaptive gap between engine calls */
  spacingMs: number;
  minSpacingMs: number;
  stats: {
    totalCalls: number;
    total429: number;
    servedChat: number;
    servedVision: number;
    servedBoard: number;
    lastError: string | null;
    lastErrorAt: number | null;
    lastOkAt: number | null;
  };
}

export function gateHealth(): GateHealth {
  return {
    coolingDown: Date.now() < g.breakerUntil,
    cooldownRemainingMs: Math.max(0, g.breakerUntil - Date.now()),
    queuedBehind: g.pending.length,
    queuedUser: g.pending.filter((j) => j.prio <= PRIO.chat).length,
    spacingMs: g.spacingMs,
    minSpacingMs: SPACING_MIN,
    stats: {
      totalCalls: g.totalCalls,
      total429: g.total429,
      servedChat: g.servedChat,
      servedVision: g.servedVision,
      servedBoard: g.servedBoard,
      lastError: g.lastError,
      lastErrorAt: g.lastErrorAt,
      lastOkAt: g.lastOkAt,
    },
  };
}

// ── shared engine plumbing ──────────────────────────────────────────────────

export interface SdkChatOptions {
  messages: ChatMessage[];
  /** model id pass-through — null = the endpoint's default GLM */
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  /** total budget INCLUDING retries (the caller's patience) */
  timeoutMs: number;
  /** v24 — user-facing classes get priority + cooldown patience */
  kind?: "chat" | "board" | "probe" | "vision";
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

async function importZai() {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  return ZAI.create();
}

/** shared 429 bookkeeping — spacing grows, breaker may open */
function note429(): void {
  g.total429 += 1;
  g.consec429 += 1;
  g.spacingMs = Math.min(SPACING_MAX, Math.round(g.spacingMs * SPACING_GROW));
  if (g.consec429 >= BREAKER_THRESHOLD) {
    g.breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    g.consec429 = 0;
  }
}

/** shared success bookkeeping — spacing relaxes, breaker resets */
function noteOk(): void {
  g.consec429 = 0;
  g.breakerUntil = 0;
  g.spacingMs = Math.max(SPACING_MIN, g.spacingMs - SPACING_DECAY);
  g.lastOkAt = Date.now();
  g.lastError = null;
}

/** wait out an open breaker if the caller is patient (user-facing classes) */
async function waitOutBreaker(kind: string, deadline: number): Promise<boolean> {
  while (Date.now() < g.breakerUntil) {
    const waitMs = g.breakerUntil - Date.now() + 400;
    if (kind === "board") return false; // fail fast → local mode
    if (Date.now() + waitMs + 2_500 >= deadline) return false;
    await sleep(waitMs);
  }
  return true;
}

// ── text chat through the engine ────────────────────────────────────────────

export function sdkChatComplete(opts: SdkChatOptions): Promise<SdkChatResult> {
  const kind = opts.kind ?? "chat";
  const prio = PRIO[(kind === "probe" ? "probe" : kind === "vision" ? "vision" : kind) as keyof typeof PRIO] ?? PRIO.chat;
  return submit(prio, async () => {
    const deadline = Date.now() + opts.timeoutMs;
    let attempt = 0;

    while (true) {
      // breaker — patient classes wait it out, board fails fast
      if (Date.now() < g.breakerUntil) {
        const survived = await waitOutBreaker(kind, deadline);
        if (!survived) {
          return {
            ok: false, content: "", servedModel: null, attempts: Math.max(0, attempt - 1),
            code: "RATE_LIMITED",
            error: `engine cooling down (${Math.ceil((g.breakerUntil - Date.now()) / 1000)}s) — try again shortly`,
          };
        }
        continue;
      }

      attempt += 1;
      g.totalCalls += 1;

      try {
        const zai = await importZai();
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
        noteOk();
        if (kind === "chat") g.servedChat += 1;
        else if (kind === "board") g.servedBoard += 1;
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
          note429();
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

        return {
          ok: false, content: "", servedModel: null, attempts: attempt,
          code: "PROVIDER_ERROR", error: msg.slice(0, 200),
        };
      }
    }
  });
}

// ── VISION — the AI's eyes (chart screenshots → VLM) ────────────────────────

export interface SdkVisionOptions {
  /** base64 data-URL of the screenshot (data:image/jpeg;base64,…) */
  imageDataUrl: string;
  /** what to look for */
  prompt: string;
  timeoutMs: number;
}

export interface SdkVisionResult {
  ok: boolean;
  /** the VLM's description of the image */
  content: string;
  code?: "RATE_LIMITED" | "TIMEOUT" | "PROVIDER_ERROR" | "EMPTY" | "BAD_IMAGE";
  error?: string;
  attempts: number;
}

/**
 * ONE vision call through the same priority queue (class "vision" — top
 * priority alongside chat). Retries 429s inside the budget like chat does.
 */
export function sdkVisionComplete(opts: SdkVisionOptions): Promise<SdkVisionResult> {
  return submit(PRIO.vision, async () => {
    const deadline = Date.now() + opts.timeoutMs;
    let attempt = 0;

    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(opts.imageDataUrl)) {
      return { ok: false, content: "", code: "BAD_IMAGE", error: "not a base64 image data-URL", attempts: 0 };
    }

    while (true) {
      if (Date.now() < g.breakerUntil) {
        const survived = await waitOutBreaker("vision", deadline);
        if (!survived) {
          return {
            ok: false, content: "", attempts: Math.max(0, attempt - 1), code: "RATE_LIMITED",
            error: "vision engine cooling down",
          };
        }
        continue;
      }

      attempt += 1;
      g.totalCalls += 1;
      try {
        const zai = await importZai();
        const remaining = Math.max(4_000, deadline - Date.now());
        const completion = (await Promise.race([
          zai.chat.completions.createVision({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: opts.prompt },
                  { type: "image_url", image_url: { url: opts.imageDataUrl } },
                ],
              },
            ],
            thinking: { type: "disabled" },
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("vision timeout")), remaining),
          ),
        ])) as {
          choices?: { message?: { content?: string } }[];
          model?: string;
        };
        const content = completion.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) {
          g.lastErrorAt = Date.now();
          g.lastError = "vision empty response";
          return { ok: false, content: "", code: "EMPTY", error: "empty vision response", attempts: attempt };
        }
        noteOk();
        g.servedVision += 1;
        return { ok: true, content, attempts: attempt };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        g.lastErrorAt = Date.now();
        g.lastError = msg;
        const { is429, isTimeout } = classifyError(msg);

        if (is429) {
          note429();
          const backoff = BACKOFF_STEPS[Math.min(attempt - 1, BACKOFF_STEPS.length - 1)];
          if (Date.now() + backoff + 3_000 < deadline) {
            await sleep(backoff);
            continue;
          }
          return { ok: false, content: "", attempts: attempt, code: "RATE_LIMITED", error: "vision rate limit" };
        }
        if (isTimeout) {
          return { ok: false, content: "", attempts: attempt, code: "TIMEOUT", error: "vision timed out" };
        }
        return { ok: false, content: "", attempts: attempt, code: "PROVIDER_ERROR", error: msg.slice(0, 200) };
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
