import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  AI_PROVIDERS,
  AI_MODELS,
  BOARD_AGENT_IDS,
  SETTING_BOARD_MODELS,
  SETTING_CHAT_MODEL,
  providerById,
  type AiProviderId,
} from "@/lib/ai/registry";
import {
  getAiSettings,
  gateHealth,
  invalidateAiSettings,
  maskKey,
  modelAvailable,
  testProviderKey,
} from "@/lib/ai/llm";

/**
 * /api/ai/models — the multi-provider model hub (v22.0).
 *
 *   GET              → catalog + key status (masked) + board assignments + chat model
 *   PUT              → { setKey?{provider,key} · clearKey?provider ·
 *                       boardModels?{agentId:modelId} · chatModel?modelId }
 *   POST             → { provider, key? } — test connectivity with one tiny call
 *
 * Keys live ONLY in the AppSetting table server-side; the client ever sees a
 * masked fingerprint (sk-12…abcd).
 */

export const runtime = "nodejs";

const PROVIDER_IDS = AI_PROVIDERS.map((p) => p.id) as AiProviderId[];

export async function GET() {
  const s = await getAiSettings();
  return NextResponse.json(
    {
      providers: AI_PROVIDERS.filter((p) => p.id !== "builtin").map((p) => {
        const key = s.keys[p.id];
        return {
          id: p.id,
          name: p.name,
          keyUrl: p.keyUrl,
          keyHint: p.keyHint,
          hasKey: Boolean(key),
          keyMasked: key ? maskKey(key) : null,
        };
      }),
      models: AI_MODELS.map((m) => ({
        id: m.id,
        provider: m.provider,
        label: m.label,
        note: m.note,
        /** v23 — every model runs keyless; `direct` marks the optional key upgrade */
        available: modelAvailable(m.id, s),
        direct: m.provider !== "builtin" && Boolean(s.keys[m.provider]),
      })),
      boardAgents: BOARD_AGENT_IDS,
      boardModels: s.boardModels,
      chatModel: s.chatModel,
      engine: gateHealth(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const b = body as {
    setKey?: { provider?: string; key?: string };
    clearKey?: string;
    boardModels?: Record<string, string>;
    chatModel?: string;
  };

  // ── set / clear a provider key ──
  if (b.setKey) {
    const providerId = b.setKey.provider as AiProviderId;
    const key = (b.setKey.key ?? "").trim();
    if (!PROVIDER_IDS.includes(providerId) || providerId === "builtin") {
      return NextResponse.json({ error: "unknown provider" }, { status: 400 });
    }
    if (key.length < 16 || key.length > 256 || /\s/.test(key)) {
      return NextResponse.json({ error: "that does not look like an API key" }, { status: 400 });
    }
    await db.appSetting.upsert({
      where: { key: providerById(providerId).keySetting },
      create: { key: providerById(providerId).keySetting, value: key },
      update: { value: key },
    });
  }
  if (b.clearKey) {
    const providerId = b.clearKey as AiProviderId;
    if (!PROVIDER_IDS.includes(providerId) || providerId === "builtin") {
      return NextResponse.json({ error: "unknown provider" }, { status: 400 });
    }
    await db.appSetting.deleteMany({ where: { key: providerById(providerId).keySetting } }).catch(() => {});
  }

  // ── board per-agent model assignment ──
  if (b.boardModels && typeof b.boardModels === "object") {
    const clean: Record<string, string> = {};
    for (const agent of BOARD_AGENT_IDS) {
      const v = b.boardModels[agent];
      if (typeof v === "string" && AI_MODELS.some((m) => m.id === v)) clean[agent] = v;
    }
    if (!Object.keys(clean).length) {
      return NextResponse.json({ error: "no valid agent assignments" }, { status: 400 });
    }
    await db.appSetting.upsert({
      where: { key: SETTING_BOARD_MODELS },
      create: { key: SETTING_BOARD_MODELS, value: JSON.stringify(clean) },
      update: { value: JSON.stringify(clean) },
    });
  }

  // ── default chat model ──
  if (b.chatModel && AI_MODELS.some((m) => m.id === b.chatModel)) {
    await db.appSetting.upsert({
      where: { key: SETTING_CHAT_MODEL },
      create: { key: SETTING_CHAT_MODEL, value: b.chatModel },
      update: { value: b.chatModel },
    });
  }

  invalidateAiSettings();
  const s = await getAiSettings(true);
  return NextResponse.json({ ok: true, boardModels: s.boardModels, chatModel: s.chatModel });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const providerId = (body?.provider ?? "") as AiProviderId;
  if (!PROVIDER_IDS.includes(providerId)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  const keyOverride = typeof body?.key === "string" && body.key.trim().length >= 16 ? body.key.trim() : undefined;
  const result = await testProviderKey(providerId, keyOverride);
  return NextResponse.json(result);
}
