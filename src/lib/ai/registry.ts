/**
 * registry.ts — the multi-provider AI model catalog (v22.0).
 *
 * User spec (বাংলা): the app must run FREE models from different companies —
 * DeepSeek, Alibaba (Qwen) and Moonshot (Kimi) — alongside the built-in GLM,
 * with per-agent assignment on the AI Board and a model picker on the AI Chat.
 *
 * All three external providers expose OpenAI-compatible chat endpoints, so one
 * small gateway (llm.ts) covers them all. Their API keys are FREE to create
 * (each company hands out free-tier keys) and are stored server-side only in
 * the AppSetting table — the client ever only sees a masked fingerprint.
 */

export type AiProviderId = "builtin" | "deepseek" | "qwen" | "moonshot";

export interface AiProvider {
  id: AiProviderId;
  /** display name */
  name: string;
  /** OpenAI-compatible base URL (null → the built-in z-ai GLM SDK) */
  baseUrl: string | null;
  /** AppSetting key the user's API key lives under */
  keySetting: string;
  /** where the user creates their free key */
  keyUrl: string;
  /** one-line hint shown in Settings */
  keyHint: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "builtin",
    name: "GLM (built-in)",
    baseUrl: null,
    keySetting: "",
    keyUrl: "",
    keyHint: "Always available — no key needed. The terminal's default brain.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keySetting: "ai.key.deepseek",
    keyUrl: "https://platform.deepseek.com",
    keyHint: "Free key from platform.deepseek.com → API Keys. deepseek-chat (V3) & deepseek-reasoner (R1).",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keySetting: "ai.key.qwen",
    keyUrl: "https://www.alibabacloud.com/help/en/model-studio/",
    keyHint: "Free key from Alibaba Cloud Model Studio (DashScope). qwen-flash / turbo / plus.",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    keySetting: "ai.key.moonshot",
    keyUrl: "https://platform.moonshot.ai",
    keyHint: "Free key from platform.moonshot.ai → API Keys. Kimi K2 & Moonshot v1.",
  },
];

export interface AiModel {
  /** our internal id (used in settings + chat) */
  id: string;
  /** the id sent to the provider API ("apiModel" for externals) */
  apiModel: string;
  provider: AiProviderId;
  /** short badge label (board agent cards, chat bubbles) */
  label: string;
  /** what this model is good at — helps the user assign agents */
  note: string;
}

export const AI_MODELS: AiModel[] = [
  {
    id: "glm-4.6",
    apiModel: "",
    provider: "builtin",
    label: "GLM-4.6",
    note: "Built-in · free · always on",
  },
  {
    id: "deepseek-chat",
    apiModel: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek V3",
    note: "Strong chart/market reasoning, cheap free tier",
  },
  {
    id: "deepseek-reasoner",
    apiModel: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek R1",
    note: "Deep reasoning — good for the Skeptic / CTO",
  },
  {
    id: "qwen-flash",
    apiModel: "qwen-flash",
    provider: "qwen",
    label: "Qwen Flash",
    note: "Fastest — good for the Trend & Volatility agents",
  },
  {
    id: "qwen-turbo",
    apiModel: "qwen-turbo",
    provider: "qwen",
    label: "Qwen Turbo",
    note: "Balanced speed / quality",
  },
  {
    id: "qwen-plus",
    apiModel: "qwen-plus",
    provider: "qwen",
    label: "Qwen Plus",
    note: "Qwen's strongest — good CTO material",
  },
  {
    id: "kimi-k2",
    apiModel: "kimi-k2-0711-preview",
    provider: "moonshot",
    label: "Kimi K2",
    note: "Long-context reasoning — good SMC / news reader",
  },
  {
    id: "moonshot-v1-8k",
    apiModel: "moonshot-v1-8k",
    provider: "moonshot",
    label: "Moonshot v1",
    note: "Stable classic Kimi model",
  },
];

export function modelById(id: string): AiModel | null {
  return AI_MODELS.find((m) => m.id === id) ?? null;
}

export function providerById(id: AiProviderId): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

/** the 6 board agents that can be assigned a model (board.ts personas) */
export const BOARD_AGENT_IDS = ["trend", "smc", "risk", "skeptic", "volatility", "cto"] as const;
export type BoardAgentIdLite = (typeof BOARD_AGENT_IDS)[number];

export const SETTING_BOARD_MODELS = "ai.board.models";
export const SETTING_CHAT_MODEL = "ai.chat.model";

/** default assignment — everything on the built-in GLM so the board works
 *  out of the box; the user re-assigns per agent in Settings. */
export const DEFAULT_BOARD_MODELS: Record<BoardAgentIdLite, string> = {
  trend: "glm-4.6",
  smc: "glm-4.6",
  risk: "glm-4.6",
  skeptic: "glm-4.6",
  volatility: "glm-4.6",
  cto: "glm-4.6",
};

export const DEFAULT_CHAT_MODEL = "glm-4.6";
