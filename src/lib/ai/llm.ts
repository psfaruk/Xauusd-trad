/**
 * llm.ts — the multi-provider LLM gateway (v23.0 · KEYLESS-FIRST).
 *
 * ONE call interface for every model in the registry:
 *   · direct   → the user pasted a provider key → real OpenAI-compatible
 *                REST call to that company (DeepSeek / Qwen / Kimi)
 *   · keyless  → NO key needed: the call goes through the built-in engine
 *                (z-ai SDK) via the GATE. The model id is passed through
 *                first; if the engine doesn't serve it natively we retry
 *                with the model's PERSONA prepended — the answer is honestly
 *                badged "GLM-engine" in the UI.
 *
 * Every keyless call is serialized + spaced + 429-retried by the gate, so a
 * rate limit never again becomes an instant "API problem" for the user.
 */

import { db } from "@/lib/db";
import {
  AI_MODELS,
  AI_PROVIDERS,
  DEFAULT_BOARD_MODELS,
  DEFAULT_CHAT_MODEL,
  SETTING_BOARD_MODELS,
  SETTING_CHAT_MODEL,
  modelById,
  providerById,
  type AiProviderId,
} from "./registry";
import { sdkChatComplete, sdkPing, gateHealth, type SdkChatResult } from "./gate";
import type { ChatMsg } from "./llm-types";

/** v26 — one-shot marker for the v25 settings migration (see getAiSettings) */
const SETTING_MIGRATED_V25 = "ai.migrated.v25";

// ── settings (cached 30s; invalidated on PUT /api/ai/models) ────────────────

export interface AiSettings {
  keys: Partial<Record<AiProviderId, string>>;
  boardModels: Record<string, string>;
  chatModel: string;
}

let settingsCache: { at: number; value: AiSettings } | null = null;
const SETTINGS_TTL = 30_000;

export function invalidateAiSettings(): void {
  settingsCache = null;
}

export async function getAiSettings(force = false): Promise<AiSettings> {
  if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) {
    return settingsCache.value;
  }
  const rows = await db.appSetting
    .findMany({ where: { key: { startsWith: "ai." } } })
    .catch(() => [] as { key: string; value: string }[]);

  const keys: Partial<Record<AiProviderId, string>> = {};
  for (const p of AI_PROVIDERS) {
    if (!p.keySetting) continue;
    const row = rows.find((r) => r.key === p.keySetting);
    if (row?.value) keys[p.id] = row.value;
  }

  // v26 — ONE-SHOT, PERSISTED migration. The v25 code re-transformed the
  // saved values on EVERY read and never wrote them back, so (a) a
  // deliberate glm-4.6 chat choice (or a deliberately re-selected v23
  // committee) was silently clobbered on every GET and could never be saved,
  // and (b) the transform ran forever. Now: the first read without the flag
  // row transforms once, PERSISTS the result, and plants the flag — from
  // then on raw saved values are returned untouched, so every later
  // deliberate choice survives.
  const migrated = rows.some((r) => r.key === SETTING_MIGRATED_V25 && r.value === "1");

  let boardModels: Record<string, string> = { ...DEFAULT_BOARD_MODELS };
  try {
    const raw = rows.find((r) => r.key === SETTING_BOARD_MODELS)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const saved: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && modelById(v)) saved[k] = v;
      }
      if (!migrated) {
        // last transform: an exactly-untouched v23 default committee upgrades
        // to the flagship committee; anything else is deliberate → kept as-is
        const V23_DEFAULTS: Record<string, string> = {
          trend: "qwen-flash", smc: "kimi-k2", risk: "glm-4.6",
          skeptic: "deepseek-reasoner", volatility: "qwen-turbo", cto: "glm-4.6",
        };
        const isUntouchedV23 =
          Object.keys(saved).length === Object.keys(V23_DEFAULTS).length &&
          Object.entries(V23_DEFAULTS).every(([k, v]) => saved[k] === v);
        boardModels = isUntouchedV23 ? { ...DEFAULT_BOARD_MODELS } : { ...boardModels, ...saved };
      } else {
        boardModels = { ...boardModels, ...saved };
      }
    }
  } catch { /* defaults survive */ }

  const chatRaw = rows.find((r) => r.key === SETTING_CHAT_MODEL)?.value;
  let chatModel: string;
  if (!migrated) {
    // last transform: a saved chat model survives UNLESS it is the untouched
    // old default (glm-4.6), which upgrades to the new flagship default
    chatModel = chatRaw && modelById(chatRaw) && chatRaw !== "glm-4.6" ? chatRaw : DEFAULT_CHAT_MODEL;
  } else {
    // raw saved value rules — the user's deliberate choice is final
    chatModel = chatRaw && modelById(chatRaw) ? chatRaw : DEFAULT_CHAT_MODEL;
  }

  // persist the one-shot migration (best-effort — a failed write retries on
  // the next read because the flag row is only planted after both writes)
  if (!migrated) {
    await db.appSetting.upsert({
      where: { key: SETTING_BOARD_MODELS },
      create: { key: SETTING_BOARD_MODELS, value: JSON.stringify(boardModels) },
      update: { value: JSON.stringify(boardModels) },
    }).catch(() => {});
    await db.appSetting.upsert({
      where: { key: SETTING_CHAT_MODEL },
      create: { key: SETTING_CHAT_MODEL, value: chatModel },
      update: { value: chatModel },
    }).catch(() => {});
    await db.appSetting.upsert({
      where: { key: SETTING_MIGRATED_V25 },
      create: { key: SETTING_MIGRATED_V25, value: "1" },
      update: { value: "1" },
    }).catch(() => {});
  }

  const value: AiSettings = { keys, boardModels, chatModel };
  settingsCache = { at: Date.now(), value };
  return value;
}

/**
 * v23 — every model is usable: keyless through the built-in engine, or
 * direct when the provider key exists. This never returns false anymore.
 */
export function modelAvailable(_modelId: string, _s: AiSettings): boolean {
  return true;
}

/** does this provider have a direct key (upgrade path)? */
export function providerHasKey(providerId: AiProviderId, s: AiSettings): boolean {
  return Boolean(s.keys[providerId]);
}

// ── pass-through memory (HMR-safe) ──────────────────────────────────────────
// which model ids the built-in engine serves NATIVELY. unknown → try once;
// failed → remembered, future calls go straight to the persona route.

const ptKey = "__aurumPtCache" as const;
type PtCache = Map<string, boolean>;
function ptCache(): PtCache {
  const glob = globalThis as Record<string, unknown>;
  if (!glob[ptKey]) glob[ptKey] = new Map<string, boolean>();
  return glob[ptKey] as PtCache;
}

// ── the gateway ─────────────────────────────────────────────────────────────

export type LlmErrorCode =
  | "NO_KEY" | "INVALID_KEY" | "RATE_LIMITED" | "QUOTA" | "TIMEOUT"
  | "PROVIDER_ERROR" | "EMPTY" | "UNKNOWN_MODEL";

/** which engine actually produced the answer — for honest UI badges */
export type LlmEngine = "native" | "glm-engine" | "direct";

export interface LlmResult {
  ok: boolean;
  content: string;
  /** the model label that actually answered (for badges) */
  modelLabel: string;
  engine?: LlmEngine;
  /** label + engine combined, e.g. "DeepSeek V3 · GLM-engine" */
  engineLabel?: string;
  error?: string;
  code?: LlmErrorCode;
}

export async function chatComplete(opts: {
  modelId: string;
  messages: ChatMsg[];
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  settings?: AiSettings;
  /** v23 — "chat" waits out engine cooldowns (user is watching); "board"
   *  fails fast so the meeting degrades to local mode */
  kind?: "chat" | "board";
}): Promise<LlmResult> {
  const model = modelById(opts.modelId);
  if (!model) {
    return { ok: false, content: "", modelLabel: opts.modelId, code: "UNKNOWN_MODEL", error: `unknown model "${opts.modelId}"` };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 900;

  // ── DIRECT: the provider has a key → first-party REST call ──
  if (model.provider !== "builtin") {
    const provider = providerById(model.provider);
    const settings = opts.settings ?? (await getAiSettings());
    const key = settings.keys[model.provider];
    if (key) {
      const r = await directCall(provider, model.apiModel, key, opts.messages, temperature, maxTokens, timeoutMs);
      return { ...r, engine: "direct", engineLabel: `${model.label} · direct` };
    }
  }

  // ── KEYLESS: through the built-in engine + the gate ──
  return keylessCall(model, opts.messages, temperature, maxTokens, timeoutMs, opts.kind ?? "chat");
}

/** the keyless route: pass-through first, persona fallback second */
async function keylessCall(
  model: ReturnType<typeof modelById> & {},
  messages: ChatMsg[],
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
  kind: "chat" | "board" = "chat",
): Promise<LlmResult> {
  const isBuiltin = model.provider === "builtin";
  const cache = ptCache();

  // builtin GLM: glm-4.6 rides the engine default; the flagship GLM 5.3 sends
  // its own id as a pass-through (verified served), falling back to the
  // engine default + persona if the id is ever rejected.
  // v26 — the builtin branch now also consults the known-bad cache: a
  // pass-through id that was already rejected (cache = false) goes straight
  // to the persona route instead of burning a doomed call every time.
  if (isBuiltin) {
    if (model.apiModel && cache.get(model.id) !== false) {
      const r = await sdkChatComplete({
        messages, model: model.apiModel, temperature, maxTokens, timeoutMs, kind,
      });
      if (r.ok) return finish(r, model, "native");
      if (r.code === "PROVIDER_ERROR" || r.code === "EMPTY") {
        // id not served → remember and fall through to the persona route
        cache.set(model.id, false);
      } else {
        return finish(r, model, "glm-engine");
      }
    } else {
      const r = await sdkChatComplete({
        messages, model: null, temperature, maxTokens, timeoutMs, kind,
      });
      return finish(r, model, "native");
    }
  }

  // other companies: try the model id pass-through once (unless known-bad)
  if (cache.get(model.id) !== false) {
    const r = await sdkChatComplete({
      messages, model: model.id, temperature, maxTokens, timeoutMs, kind,
    });
    if (r.ok) {
      cache.set(model.id, true);
      return finish(r, model, "native");
    }
    // a MODEL-level provider error (not rate limit / timeout) → the engine
    // doesn't serve this id natively — remember and fall to the persona route
    if (r.code === "PROVIDER_ERROR" || r.code === "EMPTY") {
      cache.set(model.id, false);
    } else {
      // rate limit / timeout — do NOT mark the model bad; surface as-is
      return finish(r, model, "glm-engine");
    }
  }

  // persona route: the built-in engine serves the call with this model's voice
  const personaMessages: ChatMsg[] = messages.map((m, i) =>
    i === 0 && m.role === "system"
      ? { role: "system" as const, content: `${model.persona}\n\n${m.content}` }
      : m,
  );
  const r2 = await sdkChatComplete({
    messages: personaMessages.length && personaMessages[0].role === "system"
      ? personaMessages
      : [{ role: "system", content: model.persona }, ...messages],
    model: null,
    temperature,
    maxTokens,
    timeoutMs,
    kind,
  });
  return finish(r2, model, "glm-engine");
}

function finish(r: SdkChatResult, model: { label: string }, engine: LlmEngine): LlmResult {
  return {
    ok: r.ok,
    content: r.content,
    modelLabel: model.label,
    engine,
    engineLabel: engine === "glm-engine" ? `${model.label} · GLM-engine` : model.label,
    code: r.code,
    error: r.error,
  };
}

/** direct OpenAI-compatible call (the optional-key upgrade path) */
async function directCall(
  provider: ReturnType<typeof providerById>,
  apiModel: string,
  key: string,
  messages: ChatMsg[],
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
): Promise<Omit<LlmResult, "engine" | "engineLabel">> {
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: apiModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false, content: "", modelLabel: apiModel, code: "INVALID_KEY",
        error: `${provider.name} rejected the API key (${res.status}) — remove it in Settings → AI Models to fall back to keyless`,
      };
    }
    if (res.status === 429) {
      return {
        ok: false, content: "", modelLabel: apiModel, code: "RATE_LIMITED",
        error: `${provider.name} rate limit — retry in a moment (keyless fallback: remove the key)`,
      };
    }
    if (res.status === 402) {
      return {
        ok: false, content: "", modelLabel: apiModel, code: "QUOTA",
        error: `${provider.name} free quota exhausted — remove the key in Settings to run keyless`,
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false, content: "", modelLabel: apiModel, code: "PROVIDER_ERROR",
        error: `${provider.name} error ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return { ok: false, content: "", modelLabel: apiModel, code: "EMPTY", error: "empty response" };
    }
    return { ok: true, content, modelLabel: apiModel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|abort/i.test(msg);
    return {
      ok: false, content: "", modelLabel: apiModel,
      code: isTimeout ? "TIMEOUT" : "PROVIDER_ERROR",
      error: isTimeout ? `${provider.name} timed out` : msg,
    };
  }
}

// ── key testing (Settings → Test button) ────────────────────────────────────

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  modelLabel?: string;
  /** which route answered — keyless or direct */
  route?: "keyless" | "direct" | "builtin";
}

export async function testProviderKey(
  providerId: AiProviderId,
  keyOverride?: string,
): Promise<ProviderTestResult> {
  const started = Date.now();

  // builtin → a tiny ping through the gate
  if (providerId === "builtin") {
    const r = await sdkPing();
    return {
      ok: r.ok, latencyMs: Date.now() - started, error: r.error,
      modelLabel: "GLM-4.6", route: "builtin",
    };
  }

  const provider = providerById(providerId);
  const firstModel = AI_MODELS.find((m) => m.provider === providerId);
  if (!firstModel) return { ok: false, latencyMs: 0, error: "no models for provider" };

  const key = keyOverride ?? (await getAiSettings()).keys[providerId];

  // key present (or being tested) → direct route
  if (key) {
    const r = await directCall(provider, firstModel.apiModel, key, [{ role: "user", content: "Reply with exactly: OK" }], 0.1, 8, 15_000);
    return {
      ok: r.ok, latencyMs: Date.now() - started, error: r.error,
      modelLabel: firstModel.label, route: "direct",
    };
  }

  // no key → keyless route (this is the default experience now)
  const r = await sdkChatComplete({
    messages: [
      { role: "system", content: firstModel.persona },
      { role: "user", content: "Reply with exactly: OK" },
    ],
    model: null,
    temperature: 0.1,
    maxTokens: 8,
    timeoutMs: 20_000,
    kind: "probe",
  });
  return {
    ok: r.ok, latencyMs: Date.now() - started, error: r.error,
    modelLabel: firstModel.label, route: "keyless",
  };
}

/** the gate's health, re-exported for the API layer */
export { gateHealth };

/** masked fingerprint for the UI — never the raw key */
export function maskKey(key: string): string {
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
