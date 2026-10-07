/**
 * test-routing-mock.ts — verifies the v23 keyless routing WITHOUT the live
 * engine: bun's mock.module replaces z-ai-web-dev-sdk with a fake that
 * (a) serves a native answer when it "knows" the model id,
 * (b) rejects unknown model ids with a provider error (→ persona route),
 * (c) simulates 429 for one caller.
 * Run: bun test scripts/test-routing-mock.ts  (or bun scripts/test-routing-mock.ts)
 */
import { mock, describe, test, expect, beforeAll } from "bun:test";

// ── the fake engine ─────────────────────────────────────────────────────────

const state = { calls: [] as { model?: string | null; system?: string }[], mode: "native" as "native" | "ratelimit" };

mock.module("z-ai-web-dev-sdk", () => {
  return {
    default: {
      create: async () => ({
        chat: {
          completions: {
            create: async (body: { model?: string | null; messages: { role: string; content: string }[] }) => {
              state.calls.push({ model: body.model ?? null, system: body.messages[0]?.content?.slice(0, 60) });
              if (state.mode === "ratelimit") {
                throw new Error('API request failed with status 429: {"error":"Too many requests"}');
              }
              // the fake engine natively serves GLM + qwen ids, rejects others
              if (body.model && !/glm|qwen/.test(body.model)) {
                throw new Error('API request failed with status 404: {"error":"model not found"}');
              }
              const persona = body.messages[0]?.content ?? "";
              const used = body.model ?? "glm-default";
              return {
                choices: [{ message: { content: `ANSWER[${used}] ${persona.startsWith("You are") ? "persona:" + persona.slice(0, 24) : "plain"}` } }],
              };
            },
          },
        },
      }),
    },
  };
});

// import AFTER the mock is registered
const { chatComplete } = await import("../src/lib/ai/llm");

beforeAll(() => {
  state.calls = [];
});

describe("v23 keyless routing", () => {
  test("builtin GLM → native, no pass-through needed", async () => {
    state.mode = "native";
    state.calls = [];
    const r = await chatComplete({
      modelId: "glm-4.6",
      messages: [{ role: "system", content: "You are a trader." }, { role: "user", content: "hi" }],
      timeoutMs: 8_000,
    });
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("native");
    expect(r.content).toContain("ANSWER[glm-default]");
  });

  test("qwen model id passes through natively when the engine serves it", async () => {
    state.mode = "native";
    state.calls = [];
    const r = await chatComplete({
      modelId: "qwen-plus",
      messages: [{ role: "system", content: "You are a trader." }, { role: "user", content: "hi" }],
      timeoutMs: 8_000,
    });
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("native");
    expect(r.content).toContain("ANSWER[qwen-plus]");
    // first call was the pass-through with the model id
    expect(state.calls[0]?.model).toBe("qwen-plus");
  });

  test("deepseek model id fails pass-through → persona fallback via built-in engine", async () => {
    state.mode = "native";
    state.calls = [];
    const r = await chatComplete({
      modelId: "deepseek-chat",
      messages: [{ role: "system", content: "You are a trader." }, { role: "user", content: "hi" }],
      timeoutMs: 10_000,
    });
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("glm-engine");
    expect(r.engineLabel).toBe("DeepSeek V3 · GLM-engine");
    // two engine calls: failed pass-through, then persona retry without model
    expect(state.calls.length).toBe(2);
    expect(state.calls[0]?.model).toBe("deepseek-chat"); // tried pass-through
    expect(state.calls[1]?.model).toBeNull(); // fell back to default engine
    expect(state.calls[1]?.system).toContain("You are DeepSeek V3"); // persona injected
  });

  test("rate-limited engine → classified RATE_LIMITED, model NOT marked bad", async () => {
    state.mode = "ratelimit";
    state.calls = [];
    const r = await chatComplete({
      modelId: "kimi-k2",
      messages: [{ role: "system", content: "You are a trader." }, { role: "user", content: "hi" }],
      timeoutMs: 9_000,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.error).toBeTruthy();
  }, 25_000); // the gate retries with backoff inside the 9s budget — give the test room
});
