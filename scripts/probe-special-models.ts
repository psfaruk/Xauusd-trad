/**
 * probe-special-models.ts — does the keyless engine serve SPECIAL model ids?
 * User wants: Claude Sonnet, DeepSeek 4, GLM 5.3, Kimi K3 — all keyless.
 * We ask each id "which model are you" to see if routing differs.
 * Run: bun run scripts/probe-special-models.ts
 */
import ZAI from "z-ai-web-dev-sdk";

const MODELS = [
  // defaults / known
  "(default)",
  "glm-4.6",
  // ── user's SPECIAL wants ──
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-4-sonnet",
  "claude-3-7-sonnet-latest",
  "anthropic/claude-sonnet-4",
  "deepseek-v4",
  "deepseek-chat-v4",
  "deepseek-4",
  "glm-5.3",
  "glm-5",
  "glm-4.7",
  "kimi-k3",
  "kimi-k3.5",
  "kimi-k2.5",
  "moonshot-v1-auto",
  "qwen3-max",
  "gpt-5",
  "gpt-4o",
  "gemini-2.5-pro",
  "grok-4",
];

async function main() {
  const zai = await ZAI.create();
  for (const m of MODELS) {
    const started = Date.now();
    try {
      const body: Record<string, unknown> = {
        messages: [
          {
            role: "user",
            content:
              "Which model are you? Reply with ONLY your exact model name/ID, nothing else.",
          },
        ],
        thinking: { type: "disabled" },
        max_tokens: 30,
      };
      if (m !== "(default)") body.model = m;
      const completion = (await zai.chat.completions.create(body as never)) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = completion?.choices?.[0]?.message?.content ?? "";
      const ms = Date.now() - started;
      console.log(
        `${content.trim() ? "OK " : "?  "}${m.padEnd(28)} ${String(ms).padStart(5)}ms  ${content.trim().slice(0, 60).replace(/\n/g, " ")}`,
      );
    } catch (e) {
      const ms = Date.now() - started;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`ERR ${m.padEnd(28)} ${String(ms).padStart(5)}ms  ${msg.slice(0, 110)}`);
    }
    await new Promise((r) => setTimeout(r, 1300));
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
