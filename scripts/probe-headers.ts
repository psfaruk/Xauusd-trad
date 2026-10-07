/**
 * probe-headers.ts — probe the internal endpoint with full SDK-style headers,
 * trying different chatId values to isolate the rate limit, and different
 * model ids to see which pass through. One call per variant, spaced out.
 * Run: bun scripts/probe-headers.ts
 */
import { readFileSync } from "fs";

const cfg = JSON.parse(readFileSync("/etc/.z-ai-config", "utf-8")) as {
  baseUrl: string; apiKey: string; chatId?: string; userId?: string; token?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(chatId: string, model: string | null, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    "X-Z-AI-From": "Z",
  };
  if (chatId) headers["X-Chat-Id"] = chatId;
  if (cfg.userId) headers["X-User-Id"] = cfg.userId;
  if (token ?? cfg.token) headers["X-Token"] = token ?? cfg.token ?? "";
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    thinking: { type: "disabled" },
  };
  if (model) body.model = model;
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const ms = Date.now() - started;
  const text = await res.text();
  let preview = text.slice(0, 150).replace(/\n/g, " ");
  try {
    const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    if (j.choices?.[0]?.message?.content) preview = "content: " + j.choices[0].message!.content!.slice(0, 40);
  } catch { /* keep raw preview */ }
  return { status: res.status, ms, preview };
}

async function main() {
  const variants: { label: string; chatId: string | null; model: string | null }[] = [
    { label: "orig-chat default-model", chatId: cfg.chatId ?? null, model: null },
    { label: "orig-chat glm-4.6", chatId: cfg.chatId ?? null, model: "glm-4.6" },
    { label: "alt-chat default-model", chatId: "chat-5c40031a-8f22-4c99-ab56-bb7ee055e9ca-app", model: null },
    { label: "alt-chat deepseek", chatId: "chat-5c40031a-8f22-4c99-ab56-bb7ee055e9ca-app", model: "deepseek-chat" },
    { label: "no-chat glm-4.6", chatId: null, model: "glm-4.6" },
    { label: "no-chat deepseek", chatId: null, model: "deepseek-chat" },
    { label: "no-chat qwen-plus", chatId: null, model: "qwen-plus" },
    { label: "no-chat kimi", chatId: null, model: "kimi-k2-0711-preview" },
  ];
  for (const v of variants) {
    try {
      const r = await call(v.chatId, v.model);
      console.log(`${r.status === 200 ? "✅" : "❌"} ${v.label.padEnd(28)} HTTP ${r.status} ${r.ms}ms  ${r.preview}`);
    } catch (e) {
      console.log(`💥 ${v.label.padEnd(28)} ${(e as Error).message.slice(0, 80)}`);
    }
    await sleep(8000);
  }
}

main();
