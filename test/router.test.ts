import assert from "node:assert/strict";
import test from "node:test";
import { JevClient } from "../src/jev.ts";
import { createRouterState, routeModel, type RouteTarget } from "../src/router.ts";

const TARGETS: RouteTarget[] = [
  {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek Flash",
    description: "fast cheap",
    costRank: 1,
  },
  {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    label: "GLM Flash",
    description: "balanced",
    costRank: 2,
  },
  {
    provider: "openrouter",
    model: "moonshotai/kimi-k2.7-code",
    label: "Kimi Code",
    description: "heavy",
    costRank: 3,
  },
  {
    provider: "llama.cpp",
    model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
    label: "Local Qwen",
    description: "offline fallback",
    costRank: 4,
  },
];

const choice = (selected: string, confidence = 0.95) => {
  const keys = ["m0", "m1", "m2", "m3", "local"] as const;
  const probabilities: Record<string, number> = {};
  for (const k of keys) probabilities[k] = k === selected ? 0.96 : 0.01; // sums to 1
  return { type: "choice", choice: selected, confidence, probabilities };
};

test("offline override always selects the local model without a network call", async () => {
  const client = new JevClient({ baseUrl: "https://openrouter.ai/api", fetch: async () => assert.fail("no call") });
  const state = createRouterState();
  const r = await routeModel(client, "fix the bug", TARGETS, true, state, undefined);
  assert.equal(r.provider, "llama.cpp");
  assert.equal(r.fromJev, false);
  assert.equal(state.fallbacks, 1);
});

test("an unconfigured client falls back to local instead of a doomed hosted call", async () => {
  const client = new JevClient({}); // no key, no base url
  const state = createRouterState();
  const r = await routeModel(client, "fix the bug", TARGETS, false, state, undefined);
  assert.equal(r.provider, "llama.cpp");
  assert.equal(r.fromJev, false);
  assert.match(r.error || "", /cloud-unreachable|missing-api-key/);
});

test("a confident Jev choice routes to the selected cloud model", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () =>
      Response.json({
        model: "jev-latest",
        usage: { input_tokens: 10 },
        answers: { model: choice("m1") },
      }),
  });
  const state = createRouterState();
  const r = await routeModel(client, "complex refactor", TARGETS, false, state, undefined);
  assert.equal(r.fromJev, true);
  assert.equal(r.model, "z-ai/glm-5.3-flash");
  assert.equal(state.routes, 1);
});

test("a low-confidence Jev judgment leaves the current model unchanged (below floor)", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () =>
      Response.json({
        model: "jev-latest",
        usage: { input_tokens: 10 },
        answers: { model: choice("m2", 0.3) },
      }),
  });
  const state = createRouterState();
  const r = await routeModel(client, "ambiguous request", TARGETS, false, state, undefined);
  assert.equal(r.fromJev, false);
  assert.equal(r.unchanged, true);
});

test("moderate 0.76 confidence routes because the router floor is 0.6", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () =>
      Response.json({
        model: "jev-latest",
        usage: { input_tokens: 10 },
        answers: { model: choice("m0", 0.76) },
      }),
  });
  const state = createRouterState();
  const r = await routeModel(client, "simple task", TARGETS, false, state, undefined);
  assert.equal(r.fromJev, true);
  assert.equal(r.model, "deepseek/deepseek-v4-flash-0731");
  assert.equal(state.routes, 1);
});