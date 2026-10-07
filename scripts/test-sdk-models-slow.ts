/**
 * test-sdk-models-slow.ts — probe models one at a time with generous spacing
 * to avoid the burst rate limit. Run: bun scripts/test-sdk-models-slow.ts
 */
import ZAI from "z-ai-web-dev-sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["", "glm-4.6", "deepseek-chat", "qwen-plus", "kimi-k2-0711-preview"];

async function callOnce(zai: Awaited<ReturnType<typeof ZAI.create>>, model: string) {
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    thinking: { type: "disabled" },
  };
  if (model) body.model = model;
  const completion = (await zai.chat.completions.create(body as never)) as {
    choices?: { message?: { content?: string } }[];
  };
  return completion?.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const zai = await ZAI.create();
  for (const m of MODELS) {
    const label = m === "" ? "(default)" : m;
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      const started = Date.now();
      try {
        const content = await callOnce(zai, m);
        const ms = Date.now() - started;
        console.log(`✅ ${label.padEnd(24)} ${ms}ms  ${content.slice(0, 50).replace(/\n/g, " ")}`);
        done = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const ms = Date.now() - started;
        const is429 = /429/.test(msg);
        console.log(`${is429 ? "⏳" : "❌"} ${label.padEnd(24)} ${ms}ms attempt ${attempt} ${msg.slice(0, 90)}`);
        if (!is429) done = true; // real error, move on
        await sleep(6000 * attempt); // backoff for 429
      }
    }
    await sleep(4000);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
