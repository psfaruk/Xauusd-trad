/**
 * test-sdk-models.ts — probe which model ids the z-ai endpoint accepts.
 * Run: bunx tsx scripts/test-sdk-models.ts  (or bun run scripts/test-sdk-models.ts)
 */
import ZAI from "z-ai-web-dev-sdk";

const MODELS = [
  "",                      // default (no model field)
  "glm-4.6",
  "glm-4.5",
  "glm-4-plus",
  "glm-4-flash",
  "glm-4",
  "deepseek-chat",
  "deepseek-reasoner",
  "qwen-flash",
  "qwen-turbo",
  "qwen-plus",
  "kimi-k2-0711-preview",
  "moonshot-v1-8k",
];

async function main() {
  const zai = await ZAI.create();
  for (const m of MODELS) {
    const label = m === "" ? "(default)" : m;
    const started = Date.now();
    try {
      const body: Record<string, unknown> = {
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        thinking: { type: "disabled" },
      };
      if (m) body.model = m;
      const completion = (await zai.chat.completions.create(
        body as never,
      )) as { choices?: { message?: { content?: string } }[]; error?: unknown; message?: string };
      const content = completion?.choices?.[0]?.message?.content ?? "";
      const ms = Date.now() - started;
      console.log(
        `✅ ${label.padEnd(24)} ${ms}ms  ${content.slice(0, 40).replace(/\n/g, " ")}`,
      );
    } catch (e) {
      const ms = Date.now() - started;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ ${label.padEnd(24)} ${ms}ms  ${msg.slice(0, 120)}`);
    }
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
