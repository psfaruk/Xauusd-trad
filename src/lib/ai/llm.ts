/**
 * llm.ts — the multi-provider LLM gateway (v22.0).
 *
 * ONE call interface for every model in the registry:
 *   · builtin  → z-ai-web-dev-sdk (GLM, always available, no key)
 *   · external → OpenAI-compatible REST (DeepSeek / Qwen / Kimi) with the
 *                user's free API key stored in AppSetting (server-side only)
 *
 * Callers: the AI Board agents, the AI Chat, the key tester. Errors are
 * classified (NO_KEY / INVALID_KEY / RATE_LIMITED / …) so the UI can tell the
 * user exactly what to fix instead of a generic "failed".
 */

import { db } from "@/lib/db";
import {
  AI_PROVIDERS,
  AI_MODELS,
  DEFAULT_BOARD_MODELS,
  DEFAULT_CHAT_MODEL,
  SETTING_BOARD_MODELS,
  SETTING_CHAT_MODEL,
  modelById,
  providerById,
  type AiProviderId,
} from "./registry";

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

  let boardModels: Record<string, string> = { ...DEFAULT_BOARD_MODELS };
  try {
    const raw = rows.find((r) => r.key === SETTING_BOARD_MODELS)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && modelById(v)) boardModels[k] = v;
      }
    }
  } catch { /* defaults survive */ }

  const chatRaw = rows.find((r) => r.key === SETTING_CHAT_MODEL)?.value;
  const chatModel = chatRaw && modelById(chatRaw) ? chatRaw : DEFAULT_CHAT_MODEL;

  const value: AiSettings = { keys, boardModels, chatModel };
  settingsCache = { at: Date.now(), value };
  return value;
}

/** is a model usable right now? (builtin always; external needs its key) */
export function modelAvailable(modelId: string, s: AiSettings): boolean {
  const m = modelById(modelId);
  if (!m) return false;
  if (m.provider === "builtin") return true;
  return Boolean(s.keys[m.provider]);
}

// ── the gateway ─────────────────────────────────────────────────────────────

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmErrorCode =
  | "NO_KEY" | "INVALID_KEY" | "RATE_LIMITED" | "QUOTA" | "TIMEOUT"
  | "PROVIDER_ERROR" | "EMPTY" | "UNKNOWN_MODEL";

export interface LlmResult {
  ok: boolean;
  content: string;
  /** the model label that actually answered (for badges) */
  modelLabel: string;
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
}): Promise<LlmResult> {
  const model = modelById(opts.modelId);
  if (!model) {
    return { ok: false, content: "", modelLabel: opts.modelId, code: "UNKNOWN_MODEL", error: `unknown model "${opts.modelId}"` };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 900;

  // ── builtin GLM via the z-ai SDK ──
  if (model.provider === "builtin") {
    try {
      const ZAI = (await import("z-ai-web-dev-sdk")).default;
      const zai = await ZAI.create();
      const call = zai.chat.completions.create({
        messages: opts.messages,
        thinking: { type: "disabled" },
      });
      const completion = (await Promise.race([
        call,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("llm timeout")), timeoutMs),
        ),
      ])) as { choices?: { message?: { content?: string } }[] };
      const content = completion.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        return { ok: false, content: "", modelLabel: model.label, code: "EMPTY", error: "empty response" };
      }
      return { ok: true, content, modelLabel: model.label };
    } catch (e) {
      return {
        ok: false, content: "", modelLabel: model.label, code: "PROVIDER_ERROR",
        error: e instanceof Error ? e.message : "GLM call failed",
      };
    }
  }

  // ── external OpenAI-compatible provider ──
  const provider = providerById(model.provider);
  const settings = opts.settings ?? (await getAiSettings());
  const key = settings.keys[model.provider];
  if (!key) {
    return {
      ok: false, content: "", modelLabel: model.label, code: "NO_KEY",
      error: `${provider.name} API key missing — add it in Settings → AI Models (free from ${provider.keyUrl})`,
    };
  }

  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model.apiModel,
        messages: opts.messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false, content: "", modelLabel: model.label, code: "INVALID_KEY",
        error: `${provider.name} rejected the API key (${res.status}) — check it in Settings → AI Models`,
      };
    }
    if (res.status === 429) {
      return {
        ok: false, content: "", modelLabel: model.label, code: "RATE_LIMITED",
        error: `${provider.name} rate limit — retry in a moment`,
      };
    }
    if (res.status === 402) {
      return {
        ok: false, content: "", modelLabel: model.label, code: "QUOTA",
        error: `${provider.name} free quota exhausted — top up or switch model`,
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false, content: "", modelLabel: model.label, code: "PROVIDER_ERROR",
        error: `${provider.name} error ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return { ok: false, content: "", modelLabel: model.label, code: "EMPTY", error: "empty response" };
    }
    return { ok: true, content, modelLabel: model.label };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|abort/i.test(msg);
    return {
      ok: false, content: "", modelLabel: model.label,
      code: isTimeout ? "TIMEOUT" : "PROVIDER_ERROR",
      error: isTimeout ? `${provider.name} timed out` : msg,
    };
  }
}

// ── key testing (Settings → Test button) ────────────────────────────────────

export async function testProviderKey(
  providerId: AiProviderId,
  keyOverride?: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string; modelLabel?: string }> {
  const started = Date.now();
  if (providerId === "builtin") {
    // the built-in is always testable via a tiny GLM ping
    const r = await chatComplete({
      modelId: "glm-4.6",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      timeoutMs: 15_000,
      maxTokens: 8,
    });
    return { ok: r.ok, latencyMs: Date.now() - started, error: r.error, modelLabel: r.modelLabel };
  }
  const provider = providerById(providerId);
  const firstModel = AI_MODELS.find((m) => m.provider === providerId);
  if (!firstModel) return { ok: false, latencyMs: 0, error: "no models for provider" };

  const key = keyOverride ?? (await getAiSettings()).keys[providerId];
  if (!key) {
    return { ok: false, latencyMs: 0, error: `${provider.name} API key missing` };
  }
  // direct tiny call with the override key (never persisted unless saved)
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: firstModel.apiModel,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) return { ok: false, latencyMs, error: "key rejected (401/403)" };
    if (res.status === 429) return { ok: false, latencyMs, error: "rate limited — key is valid, try later" };
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    if (!data.choices?.[0]?.message?.content) return { ok: false, latencyMs, error: "empty response" };
    return { ok: true, latencyMs, modelLabel: firstModel.label };
  } catch (e) {
    return {
      ok: false, latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** masked fingerprint for the UI — never the raw key */
export function maskKey(key: string): string {
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
