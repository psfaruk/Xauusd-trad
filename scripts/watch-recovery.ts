/**
 * watch-recovery.ts — single low-frequency probe loop.
 * One tiny SDK ping every 170s; on the first success it fires a real
 * keyless chat test through the app API and writes the result to
 * scripts/recovery-result.json, then exits.
 * Run: nohup bun scripts/watch-recovery.ts > scripts/recovery.log 2>&1 &
 */
import { writeFileSync } from "fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ping(): Promise<{ ok: boolean; err?: string }> {
  try {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    const zai = await ZAI.create();
    const c = (await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      thinking: { type: "disabled" },
    })) as { choices?: { message?: { content?: string } }[] };
    const content = c.choices?.[0]?.message?.content ?? "";
    return content.trim() ? { ok: true } : { ok: false, err: "empty" };
  } catch (e) {
    return { ok: false, err: (e as Error).message.slice(0, 120) };
  }
}

async function appChat(model: string): Promise<{ ok: boolean; body: string }> {
  try {
    const res = await fetch("http://localhost:3000/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread: "XAUUSDm",
        message: "Recovery check — one short line: is gold bullish or bearish?",
        model,
      }),
      signal: AbortSignal.timeout(80_000),
    });
    const body = (await res.text()).slice(0, 600);
    return { ok: res.ok, body };
  } catch (e) {
    return { ok: false, body: (e as Error).message };
  }
}

async function main() {
  const started = Date.now();
  for (let i = 1; i <= 40; i++) {
    const p = await ping();
    console.log(`[${new Date().toISOString()}] probe ${i}: ${p.ok ? "OK ✓" : p.err}`);
    if (p.ok) {
      console.log("engine recovered! running app chat tests…");
      const glmTest = await appChat("glm-4.6");
      console.log("glm-4.6:", glmTest.ok ? "PASS" : "FAIL", glmTest.body.slice(0, 200));
      await sleep(4_000);
      const dsTest = await appChat("deepseek-chat");
      console.log("deepseek-chat:", dsTest.ok ? "PASS" : "FAIL", dsTest.body.slice(0, 200));
      writeFileSync(
        "scripts/recovery-result.json",
        JSON.stringify({ recoveredAt: new Date().toISOString(), waitedMs: Date.now() - started, glmTest, dsTest }, null, 2),
      );
      console.log("result written to scripts/recovery-result.json — exiting");
      return;
    }
    await sleep(170_000);
  }
  console.log("no recovery after 40 probes — giving up");
  writeFileSync("scripts/recovery-result.json", JSON.stringify({ recoveredAt: null, gaveUpAt: new Date().toISOString() }, null, 2));
}

main();
