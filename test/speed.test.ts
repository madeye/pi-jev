import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jevExtension from "../src/index.ts";
import { JevClient } from "../src/jev.ts";
import { chooseSpeed, fastPayload, supportsSpeedControl } from "../src/speed.ts";

const model = { id: "qwen3.8-27b", api: "openai-completions", baseUrl: "http://localhost:8080/v1" };
const response = (choice = "fast", confidence = 0.95) => ({
  model: "jev-1.13.0",
  usage: {},
  answers: {
    execution: {
      type: "choice",
      choice,
      confidence,
      probabilities: {
        fast: choice === "fast" ? 0.99 : 0.01,
        preserve: choice === "preserve" ? 0.99 : 0.01,
      },
    },
  },
});

test("speed routing targets only supported Qwen-style local endpoints", () => {
  for (const baseUrl of [
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
    "https://worker.local/v1",
    "http://10.1.2.3/v1",
    "http://172.16.1.2/v1",
    "http://192.168.1.2/v1",
  ])
    assert.ok(supportsSpeedControl({ ...model, baseUrl }));
  for (const baseUrl of [
    "https://api.example.com/v1",
    "https://localhost.evil.example/v1",
    "http://172.32.1.2/v1",
    "ftp://localhost/v1",
    "broken",
  ])
    assert.equal(supportsSpeedControl({ ...model, baseUrl }), false);
  assert.equal(supportsSpeedControl({ ...model, api: "anthropic-messages" }), false);
  assert.equal(supportsSpeedControl({ ...model, id: "qwen3-coder" }), false);
  assert.equal(supportsSpeedControl({ ...model, id: "deepseek-r1" }), false);
  assert.equal(supportsSpeedControl(undefined), false);
});

test("fast request preserves every existing payload field and does not override explicit reasoning", () => {
  const payload = {
    model: model.id,
    messages: [{ role: "user", content: "Implement sum" }],
    tools: [{ type: "function" }],
    temperature: 0.7,
    chat_template_kwargs: { preserve_thinking: true },
  };
  const before = structuredClone(payload);
  const result = fastPayload(payload);
  assert.deepEqual(result, {
    ...payload,
    chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
  });
  assert.deepEqual(payload, before);
  assert.equal(result?.messages, payload.messages);
  for (const explicit of [
    { reasoning_effort: "high" },
    { reasoning: {} },
    { enable_thinking: true },
    { chat_template_kwargs: { enable_thinking: true } },
    { chat_template_kwargs: { enable_thinking: false } },
    { chat_template_kwargs: "invalid" },
  ])
    assert.equal(fastPayload({ ...payload, ...explicit }), undefined);
  assert.equal(fastPayload({ input: [] }), undefined);
});

test("only a confident fast judgment selects non-thinking mode", async () => {
  for (const [value, expected] of [
    [response(), true],
    [response("preserve"), false],
    [response("fast", 0.4), false],
    [{}, false],
  ] as const) {
    const client = new JevClient({ apiKey: "test", fetch: async () => Response.json(value) });
    assert.equal((await chooseSpeed(client, "Implement a simple sum function")).fast, expected);
  }
  const client = new JevClient({
    apiKey: "test",
    fetch: async () => assert.fail("unexpected request"),
  });
  assert.equal((await chooseSpeed(client, "x".repeat(8001))).fast, false);
  assert.equal((await chooseSpeed(client, " ")).fast, false);
});

test("adaptive mode changes actual provider payload only for the selected turn and model", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const flags: Record<string, boolean> = { jev: true, "jev-speed": true, "jev-skills": false };
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI;
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test";
  try {
    jevExtension(
      pi,
      new JevClient({
        apiKey: "test",
        fetch: async (_url, options) =>
          Response.json(
            response(
              JSON.parse(String(options?.body)).state.request.includes("complex")
                ? "preserve"
                : "fast",
            ),
          ),
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
  const before = handlers.get("before_agent_start");
  const provider = handlers.get("before_provider_request");
  assert.ok(before && provider);
  const ctx = { model };
  const event = {
    prompt: "Implement sum",
    systemPrompt: "instructions",
    systemPromptOptions: { skills: [] },
  };
  const payload = { messages: [] };
  await before(event, ctx);
  assert.deepEqual(provider({ payload }, ctx), {
    messages: [],
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.equal(provider({ payload }, { model: { ...model, id: "qwen3.5-9b" } }), undefined);
  await before({ ...event, prompt: "Solve a complex architecture problem" }, ctx);
  assert.equal(provider({ payload }, ctx), undefined);
  await before(event, ctx);
  handlers.get("agent_end")?.();
  assert.equal(provider({ payload }, ctx), undefined);
  await before(event, ctx);
  handlers.get("model_select")?.();
  assert.equal(provider({ payload }, ctx), undefined);
  await before(event, ctx);
  handlers.get("session_shutdown")?.();
  assert.equal(provider({ payload }, ctx), undefined);
  flags["jev-speed"] = false;
  await before(event, ctx);
  assert.equal(provider({ payload }, ctx), undefined);
});
