import assert from "node:assert/strict";
import test from "node:test";
import { JevClient } from "../src/jev.ts";
import { parseRouteTargets } from "../src/router.ts";
import { scoutPackage } from "../src/scout.ts";

const noul = (n: number) => ({ type: "noul", noul: n });

test("scoutPackage accepts a real package above the floor", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () =>
      Response.json({
        model: "jev-latest",
        usage: { input_tokens: 5 },
        answers: { exists: noul(0.98) },
      }),
  });
  const r = await scoutPackage(client, { type: "npm", name: "lodash", reason: "debounce" });
  assert.equal(r.exists, true);
  assert.equal(r.probability, 0.98);
});

test("scoutPackage flags a likely-invented package below the floor", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () =>
      Response.json({
        model: "jev-latest",
        usage: { input_tokens: 5 },
        answers: { exists: noul(0.1) },
      }),
  });
  const r = await scoutPackage(client, { type: "npm", name: "super-fake-pkg-xyz" });
  assert.equal(r.exists, false);
  assert.equal(r.probability, 0.1);
});

test("scoutPackage surfaces a hosted failure rather than guessing", async () => {
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://openrouter.ai/api",
    fetch: async () => new Response(null, { status: 503 }),
  });
  const r = await scoutPackage(client, { type: "npm", name: "lodash" });
  assert.equal(r.exists, false);
  assert.ok(r.error);
});

test("parseRouteTargets reads a semicolon-separated list cheapest-first", () => {
  const t = parseRouteTargets(
    "openrouter/deepseek/deepseek-v4-flash-0731:Fast:quick edits;openrouter/z-ai/glm-5.3-flash:Balanced:general coding;llama.cpp/qwen2.5-coder-1.5b-instruct-q4_k_m:Local:offline fallback",
  );
  assert.equal(t.length, 3);
  assert.equal(t[0]?.provider, "openrouter");
  assert.equal(t[0]?.model, "deepseek/deepseek-v4-flash-0731");
  assert.equal(t[0]?.costRank, 1);
  assert.equal(t[2]?.provider, "llama.cpp");
  assert.equal(t[2]?.costRank, 3);
  assert.match(t[0]?.description || "", /quick/);
});

test("parseRouteTargets ignores malformed entries and returns empty for none", () => {
  assert.equal(parseRouteTargets("").length, 0);
  assert.equal(parseRouteTargets(";;;").length, 0);
  assert.equal(parseRouteTargets("no-slash-here").length, 0);
  assert.equal(parseRouteTargets("/bare").length, 0);
});