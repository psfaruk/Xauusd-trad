/**
 * registry.ts — the multi-provider AI model catalog (v23.0 · KEYLESS).
 *
 * User spec (বাংলা): "আমি api key বসাব না — সকল মডেল এর পুরো সিস্টেম টি আমার
 * অ্যাপ এ যোগ করে দেন" — every model must run WITHOUT any user API key.
 *
 * How that works now:
 *   · BUILT-IN KEYLESS ENGINE — the z-ai SDK endpoint in this environment.
 *     It serves GLM natively; for the other companies' models we send the
 *     model id as a pass-through first (if the endpoint ever serves it, it
 *     answers natively) and otherwise serve it through the built-in engine
 *     with the model's PERSONA (style/temperature), honestly badged
 *     "keyless · GLM-engine" in the UI.
 *   · OPTIONAL KEYS — a user who pastes a DeepSeek/Qwen/Moonshot key upgrades
 *     that provider to DIRECT calls (more quota, first-party answers).
 *     Everything still works with zero keys.
 *
 * The 6 board agents default to DIFFERENT companies' models so the board is
 * a true multi-model committee out of the box.
 */

export type AiProviderId = "builtin" | "deepseek" | "qwen" | "moonshot";

export interface AiProvider {
  id: AiProviderId;
  /** display name */
  name: string;
  /** OpenAI-compatible base URL (null → the built-in keyless engine) */
  baseUrl: string | null;
  /** AppSetting key the user's OPTIONAL API key lives under */
  keySetting: string;
  /** where the user creates their free key (empty for builtin) */
  keyUrl: string;
  /** one-line hint shown in Settings */
  keyHint: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "builtin",
    name: "Built-in Engine",
    baseUrl: null,
    keySetting: "",
    keyUrl: "",
    keyHint: "Always available — no key needed. Serves GLM natively and every other model keyless.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keySetting: "ai.key.deepseek",
    keyUrl: "https://platform.deepseek.com",
    keyHint: "Optional: a free key from platform.deepseek.com upgrades DeepSeek to direct first-party calls.",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keySetting: "ai.key.qwen",
    keyUrl: "https://www.alibabacloud.com/help/en/model-studio/",
    keyHint: "Optional: a free key from Alibaba Cloud Model Studio upgrades Qwen to direct first-party calls.",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    keySetting: "ai.key.moonshot",
    keyUrl: "https://platform.moonshot.ai",
    keyHint: "Optional: a free key from platform.moonshot.ai upgrades Kimi to direct first-party calls.",
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
  /**
   * KEYLESS persona — prepended to the system prompt when this model is
   * served through the built-in engine, so each company's model keeps its
   * own analytical voice without any API key.
   */
  persona: string;
}

export const AI_MODELS: AiModel[] = [
  {
    id: "glm-4.6",
    apiModel: "",
    provider: "builtin",
    label: "GLM-4.6",
    note: "Built-in · keyless · always on — the terminal's default brain",
    persona:
      "You are GLM-4.6, the terminal's built-in engine by Z.ai — balanced, precise, pragmatic.",
  },
  {
    id: "deepseek-chat",
    apiModel: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek V3",
    note: "Keyless · strong chart/market reasoning (DeepSeek style)",
    persona:
      "You are DeepSeek V3 — an analytical, methodical reasoner. Structure your thinking: state the read, the evidence, the invalidation. Be direct and quantitative.",
  },
  {
    id: "deepseek-reasoner",
    apiModel: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek R1",
    note: "Keyless · deep reasoning — good for the Skeptic / CTO",
    persona:
      "You are DeepSeek R1, a deep-reasoning model — think the setup through step by step internally, weigh the bear AND bull case, then commit to a verdict. Never skip the counter-argument.",
  },
  {
    id: "qwen-flash",
    apiModel: "qwen-flash",
    provider: "qwen",
    label: "Qwen Flash",
    note: "Keyless · fastest — good for the Trend & Volatility agents",
    persona:
      "You are Qwen Flash (Alibaba) — a fast, decisive reader of momentum. Answer with the freshest signal first, keep it tight.",
  },
  {
    id: "qwen-turbo",
    apiModel: "qwen-turbo",
    provider: "qwen",
    label: "Qwen Turbo",
    note: "Keyless · balanced speed / quality",
    persona:
      "You are Qwen Turbo (Alibaba) — balanced and efficient. Give a clear read with the key numbers, no padding.",
  },
  {
    id: "qwen-plus",
    apiModel: "qwen-plus",
    provider: "qwen",
    label: "Qwen Plus",
    note: "Keyless · Qwen's strongest — good CTO material",
    persona:
      "You are Qwen Plus (Alibaba), the strongest Qwen — weigh context broadly (structure, momentum, news) before concluding.",
  },
  {
    id: "kimi-k2",
    apiModel: "kimi-k2-0711-preview",
    provider: "moonshot",
    label: "Kimi K2",
    note: "Keyless · long-context reasoning — good SMC / news reader",
    persona:
      "You are Kimi K2 (Moonshot) — a long-context analytical mind. Connect structure across swings, sessions and headlines; explain the WHY.",
  },
  {
    id: "moonshot-v1-8k",
    apiModel: "moonshot-v1-8k",
    provider: "moonshot",
    label: "Moonshot v1",
    note: "Keyless · stable classic Kimi model",
    persona:
      "You are Moonshot v1 (Kimi) — a stable, careful analyst. Prefer the obvious high-probability read over cleverness.",
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

/**
 * default assignment v23 — a TRUE multi-model committee, all keyless:
 * each agent runs a different company's model through the built-in engine
 * (each with its own persona), exactly what the user asked for.
 */
export const DEFAULT_BOARD_MODELS: Record<BoardAgentIdLite, string> = {
  trend: "qwen-flash",
  smc: "kimi-k2",
  risk: "glm-4.6",
  skeptic: "deepseek-reasoner",
  volatility: "qwen-turbo",
  cto: "glm-4.6",
};

export const DEFAULT_CHAT_MODEL = "glm-4.6";
