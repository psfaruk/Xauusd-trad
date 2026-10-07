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

import type { ChatMsg } from "./llm-types";

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

interface PendingJob {
  prio: number;
  /** earliest start (v26) — a requeued job parks here until this instant */
  notBefore: number;
  thunk: () => Promise<void>;
  /** v26 — settles the caller's promise if an HMR replace drops the job */
  fail: (e: Error) => void;
}

interface GateState {
  /** sorted pending jobs — pumped one at a time, highest priority first */
  pending: PendingJob[];
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
  // process always takes the defaults path. v26: jobs dropped by a replace
  // are now REJECTED (their callers surface "retry" instead of hanging).
  if (!existing || !Array.isArray(existing.pending) || typeof existing.pumping !== "boolean") {
    if (existing && Array.isArray(existing.pending)) {
      for (const j of existing.pending as PendingJob[]) {
        try { j.fail?.(new Error("gate replaced (HMR) — please retry")); } catch { /* settled already */ }
      }
    }
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

// ── v26 — requeue signal ────────────────────────────────────────────────────
// A patient job that must wait out a breaker/backoff for MORE than this
// releases the pump for other traffic (it re-enters the queue at its own
// priority with notBefore = now + delay). Waits ≤ this sleep inline.
const REQUEUE_AFTER_MS = 1_500;

class RequeueSignal {
  constructor(public delayMs: number) {}
}

// ── the priority pump (v26 — preemption) ────────────────────────────────────

function submit<T>(prio: number, job: (entry: PendingJob) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: PendingJob = {
      prio,
      notBefore: 0,
      fail: reject,
      thunk: async () => {
        try {
          resolve(await job(entry));
        } catch (e) {
          if (e instanceof RequeueSignal) {
            // v26 — put MYSELF back at my priority instead of holding the
            // pump through a long cooldown; other traffic runs meanwhile.
            entry.notBefore = Date.now() + e.delayMs;
            g.pending.push(entry);
            g.pending.sort((a, b) => a.prio - b.prio);
            return;
          }
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    };
    g.pending.push(entry);
    // stable priority order — earlier submissions win ties (FIFO within class)
    g.pending.sort((a, b) => a.prio - b.prio);
    void pump();
  });
}

async function pump(): Promise<void> {
  if (g.pumping) return;
  g.pumping = true;
  try {
    for (;;) {
      if (!g.pending.length) break;
      const now = Date.now();
      // earliest eligible job in priority order — jobs parked for later
      // (notBefore in the future, v26) are skipped so they never block anyone.
      // `?? 0`: a pre-v26 HMR leftover entry lacks notBefore and must stay
      // eligible, not park the pump forever (undefined <= now is false!).
      let idx = -1;
      for (let i = 0; i < g.pending.length; i++) {
        if ((g.pending[i].notBefore ?? 0) <= now) { idx = i; break; }
      }
      if (idx === -1) {
        // everything is parked — sleep toward the earliest wake-up, but never
        // longer than 2s so a brand-new high-priority job is picked up fast
        const nextAt = Math.min(...g.pending.map((j) => j.notBefore ?? 0));
        await sleep(Math.max(30, Math.min(nextAt - Date.now(), 2_000)));
        continue;
      }
      // spacing: adaptive gap between two call starts. v26 measures it from
      // when a call actually STARTS (a requeued/parked job never counted), so
      // a released pump never injects phantom gaps.
      const wait = g.lastCallStart + g.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      const next = g.pending.splice(idx, 1)[0];
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
  messages: ChatMsg[];
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

/** wait out an open breaker if the caller is patient (user-facing classes).
 *  v26 — a wait longer than REQUEUE_AFTER_MS throws RequeueSignal so the job
 *  releases the pump (other traffic proceeds meanwhile); the job re-enters at
 *  its own priority and its closure state (attempts, deadline) survives. */
async function waitOutBreaker(kind: string, deadline: number): Promise<boolean> {
  while (Date.now() < g.breakerUntil) {
    const waitMs = g.breakerUntil - Date.now() + 400;
    if (kind === "board") return false; // fail fast → local mode
    if (Date.now() + waitMs + 2_500 >= deadline) return false;
    if (waitMs > REQUEUE_AFTER_MS) throw new RequeueSignal(waitMs);
    await sleep(waitMs);
  }
  return true;
}

/** v26 — race a promise against a timeout and CLEAR the timer on settle (the
 *  old Promise.race sites leaked up-to-70s timers after a fast completion and
 *  left the losing SDK call consuming engine budget invisibly). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    timeout,
  ]) as Promise<T>;
}

/** v26 — the 429 backoff sleep: short ones wait inline, long ones requeue */
async function backoffSleep(backoff: number, deadline: number): Promise<boolean> {
  if (Date.now() + backoff + 3_000 >= deadline) return false;
  if (backoff > REQUEUE_AFTER_MS) throw new RequeueSignal(backoff);
  await sleep(backoff);
  return true;
}

// ── text chat through the engine ────────────────────────────────────────────

export function sdkChatComplete(opts: SdkChatOptions): Promise<SdkChatResult> {
  const kind = opts.kind ?? "chat";
  const prio = PRIO[(kind === "probe" ? "probe" : kind === "vision" ? "vision" : kind) as keyof typeof PRIO] ?? PRIO.chat;
  // v26 — the deadline lives OUTSIDE the job closure: a requeued job re-enters
  // the queue (releasing the pump for other traffic) but its budget never
  // resets — recomputing it inside the job would silently extend the caller's
  // patience by every requeue.
  const deadline = Date.now() + opts.timeoutMs;
  return submit(prio, async () => {
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
      // v26 — a call START is measured here (not when the job was picked), so
      // adaptive spacing stays honest across requeues
      g.lastCallStart = Date.now();

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
        const completion = await withTimeout(
          zai.chat.completions.create(body as never),
          remaining,
          "llm timeout",
        ) as {
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
          const survived = await backoffSleep(backoff, deadline);
          if (survived) continue;
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
  // v26 — deadline outside the job closure (survives requeues; see chat)
  const deadline = Date.now() + opts.timeoutMs;
  return submit(PRIO.vision, async () => {
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
      g.lastCallStart = Date.now(); // v26 — call-start measured here (see chat)
      try {
        const zai = await importZai();
        const remaining = Math.max(4_000, deadline - Date.now());
        const completion = await withTimeout(
          zai.chat.completions.createVision({
            model: "glm-4.6v",
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
          remaining,
          "vision timeout",
        ) as {
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
          const survived = await backoffSleep(backoff, deadline);
          if (survived) continue;
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
