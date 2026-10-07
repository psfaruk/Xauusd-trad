/**
 * registry.ts — the multi-provider AI model catalog (v25.0 · SPECIAL FLAGSHIPS).
 *
 * User spec (বাংলা): "কয়েকটি স্পেশাল মডেল ব্যবহার করতে Api key ছাড়া —
 * Claude Sonnet, DeepSeek 4, GLM 5.3, Kimi K3, ইত্যাদি" — the FLAGSHIP tier
 * runs keyless exactly like the rest: the built-in engine accepts every one
 * of these ids (verified live: claude-sonnet-4-5, claude-opus-4-5, deepseek-v4,
 * glm-5.3, kimi-k3, qwen3-max, gpt-5, gemini-2.5-pro, grok-4 all answer).
 *
 * How that works:
 *   · BUILT-IN KEYLESS ENGINE — the z-ai SDK endpoint in this environment.
 *     It serves GLM natively; for the other companies' models we send the
 *     model id as a pass-through first (the engine answers it) and otherwise
 *     serve it through the built-in engine with the model's PERSONA
 *     (style/temperature), honestly badged "keyless · GLM-engine" in the UI.
 *   · SPECIAL FLAGSHIP TIER — the newest generation from Anthropic, DeepSeek,
 *     Z.ai, Moonshot, Alibaba, OpenAI, Google and xAI. Marked `tier: special`
 *     and rendered with a gold ★ FLAGSHIP treatment across the UI.
 *   · OPTIONAL KEYS — a user who pastes a provider key upgrades that provider
 *     to DIRECT calls (more quota, first-party answers). Everything still
 *     works with zero keys.
 *
 * The 6 board agents default to DIFFERENT companies' models so the board is
 * a true multi-model committee out of the box.
 */

export type AiProviderId =
  | "builtin" | "deepseek" | "qwen" | "moonshot"
  | "anthropic" | "openai" | "google" | "xai";

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
  {
    id: "anthropic",
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    keySetting: "ai.key.anthropic",
    keyUrl: "https://console.anthropic.com",
    keyHint: "Optional: a key from console.anthropic.com upgrades Claude to direct first-party calls.",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keySetting: "ai.key.openai",
    keyUrl: "https://platform.openai.com",
    keyHint: "Optional: a key from platform.openai.com upgrades GPT to direct first-party calls.",
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keySetting: "ai.key.google",
    keyUrl: "https://aistudio.google.com",
    keyHint: "Optional: a free key from aistudio.google.com upgrades Gemini to direct first-party calls.",
  },
  {
    id: "xai",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    keySetting: "ai.key.xai",
    keyUrl: "https://console.x.ai",
    keyHint: "Optional: a key from console.x.ai upgrades Grok to direct first-party calls.",
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
  /** v25 — "special" = the flagship generation (gold ★ treatment in the UI) */
  tier: "standard" | "special";
}

export const AI_MODELS: AiModel[] = [
  // ── v25 — the SPECIAL FLAGSHIP generation (gold ★ tier, all keyless) ──
  {
    id: "claude-sonnet-4-5",
    apiModel: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    label: "Claude Sonnet 4.5",
    note: "★ Flagship · Anthropic — careful, structured, brilliant chart prose",
    tier: "special",
    persona:
      "You are Claude Sonnet 4.5 by Anthropic — thoughtful, precise and calm. Weigh both sides of a trade before concluding, structure answers clearly (read → evidence → risk), and never overstate certainty.",
  },
  {
    id: "claude-opus-4-5",
    apiModel: "claude-opus-4-5-20251101",
    provider: "anthropic",
    label: "Claude Opus 4.5",
    note: "★ Flagship · Anthropic's deepest reasoner — CTO-grade judgment",
    tier: "special",
    persona:
      "You are Claude Opus 4.5 by Anthropic — the deepest, most careful reasoner. Think through the whole setup (structure, momentum, liquidity, news) step by step, challenge your own first instinct, then deliver a measured verdict.",
  },
  {
    id: "deepseek-v4",
    apiModel: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek V4",
    note: "★ Flagship · DeepSeek's newest generation — elite market reasoning",
    tier: "special",
    persona:
      "You are DeepSeek V4 — the newest DeepSeek generation. Reason with structure and numbers: state the read, the evidence, the invalidation level. Be direct, quantitative and honest about uncertainty.",
  },
  {
    id: "glm-5.3",
    apiModel: "glm-5.3",
    provider: "builtin",
    label: "GLM 5.3",
    note: "★ Flagship · Z.ai's newest — the terminal's most advanced brain",
    tier: "special",
    persona:
      "You are GLM 5.3 — Z.ai's newest flagship. Synthesize structure, momentum and context in one pass; answer with the highest-probability read first, then the second-order risks.",
  },
  {
    id: "kimi-k3",
    apiModel: "kimi-k3",
    provider: "moonshot",
    label: "Kimi K3",
    note: "★ Flagship · Moonshot's newest — long-context structure master",
    tier: "special",
    persona:
      "You are Kimi K3 — Moonshot's newest flagship. Hold the whole swing structure, session map and headline flow in mind at once; explain the WHY behind the level, not just the level.",
  },
  {
    id: "qwen3-max",
    apiModel: "qwen3-max",
    provider: "qwen",
    label: "Qwen3 Max",
    note: "★ Flagship · Alibaba's strongest — broad-context conviction",
    tier: "special",
    persona:
      "You are Qwen3 Max — Alibaba's strongest flagship. Take the widest view (trend, volatility, news, cross-asset context) and commit to a clear, well-hedged verdict.",
  },
  {
    id: "gpt-5",
    apiModel: "gpt-5",
    provider: "openai",
    label: "GPT-5",
    note: "★ Flagship · OpenAI's newest — sharp, balanced synthesis",
    tier: "special",
    persona:
      "You are GPT-5 by OpenAI — sharp and balanced. Synthesize the evidence quickly, separate signal from noise, and give the trade thesis in three tight sentences before the detail.",
  },
  {
    id: "gemini-2.5-pro",
    apiModel: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    note: "★ Flagship · Google's strongest — multi-angle analysis",
    tier: "special",
    persona:
      "You are Gemini 2.5 Pro by Google — a multi-angle analyst. Examine the setup from trend, structure, volatility and sentiment lenses, then merge them into one verdict.",
  },
  {
    id: "grok-4",
    apiModel: "grok-4",
    provider: "xai",
    label: "Grok 4",
    note: "★ Flagship · xAI's newest — fast, blunt, contrarian checks",
    tier: "special",
    persona:
      "You are Grok 4 by xAI — fast and blunt. Lead with the actionable read, flag the obvious trap the crowd is missing, and never pad your answer.",
  },

  // ── the standard tier (v23 catalog) ──
  {
    id: "glm-4.6",
    apiModel: "",
    provider: "builtin",
    label: "GLM-4.6",
    note: "Built-in · keyless · always on — the terminal's default brain",
    tier: "standard",
    persona:
      "You are GLM-4.6, the terminal's built-in engine by Z.ai — balanced, precise, pragmatic.",
  },
  {
    id: "deepseek-chat",
    apiModel: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek V3",
    note: "Keyless · strong chart/market reasoning (DeepSeek style)",
    tier: "standard",
    persona:
      "You are DeepSeek V3 — an analytical, methodical reasoner. Structure your thinking: state the read, the evidence, the invalidation. Be direct and quantitative.",
  },
  {
    id: "deepseek-reasoner",
    apiModel: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek R1",
    note: "Keyless · deep reasoning — good for the Skeptic / CTO",
    tier: "standard",
    persona:
      "You are DeepSeek R1, a deep-reasoning model — think the setup through step by step internally, weigh the bear AND bull case, then commit to a verdict. Never skip the counter-argument.",
  },
  {
    id: "qwen-flash",
    apiModel: "qwen-flash",
    provider: "qwen",
    label: "Qwen Flash",
    note: "Keyless · fastest — good for the Trend & Volatility agents",
    tier: "standard",
    persona:
      "You are Qwen Flash (Alibaba) — a fast, decisive reader of momentum. Answer with the freshest signal first, keep it tight.",
  },
  {
    id: "qwen-turbo",
    apiModel: "qwen-turbo",
    provider: "qwen",
    label: "Qwen Turbo",
    note: "Keyless · balanced speed / quality",
    tier: "standard",
    persona:
      "You are Qwen Turbo (Alibaba) — balanced and efficient. Give a clear read with the key numbers, no padding.",
  },
  {
    id: "qwen-plus",
    apiModel: "qwen-plus",
    provider: "qwen",
    label: "Qwen Plus",
    note: "Keyless · Qwen's strongest — good CTO material",
    tier: "standard",
    persona:
      "You are Qwen Plus (Alibaba), the strongest Qwen — weigh context broadly (structure, momentum, news) before concluding.",
  },
  {
    id: "kimi-k2",
    apiModel: "kimi-k2-0711-preview",
    provider: "moonshot",
    label: "Kimi K2",
    note: "Keyless · long-context reasoning — good SMC / news reader",
    tier: "standard",
    persona:
      "You are Kimi K2 (Moonshot) — a long-context analytical mind. Connect structure across swings, sessions and headlines; explain the WHY.",
  },
  {
    id: "moonshot-v1-8k",
    apiModel: "moonshot-v1-8k",
    provider: "moonshot",
    label: "Moonshot v1",
    note: "Keyless · stable classic Kimi model",
    tier: "standard",
    persona:
      "You are Moonshot v1 (Kimi) — a stable, careful analyst. Prefer the obvious high-probability read over cleverness.",
  },
];

export function modelById(id: string): AiModel | null {
  return AI_MODELS.find((m) => m.id === id) ?? null;
}

/** v25 — the flagship tier, in catalog order */
export function specialModels(): AiModel[] {
  return AI_MODELS.filter((m) => m.tier === "special");
}

/** v25 — the standard tier, in catalog order */
export function standardModels(): AiModel[] {
  return AI_MODELS.filter((m) => m.tier !== "special");
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
 * default assignment v25 — a TRUE multi-model committee with the flagship
 * generation at the head of the table, all keyless:
 * each agent runs a different company's model through the built-in engine
 * (each with its own persona), exactly what the user asked for.
 */
export const DEFAULT_BOARD_MODELS: Record<BoardAgentIdLite, string> = {
  trend: "glm-5.3",
  smc: "kimi-k3",
  risk: "claude-sonnet-4-5",
  skeptic: "deepseek-v4",
  volatility: "qwen3-max",
  cto: "claude-opus-4-5",
};

export const DEFAULT_CHAT_MODEL = "glm-5.3";
