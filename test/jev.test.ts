import assert from "node:assert/strict";
import test from "node:test";
import {
  isDirectEvidence,
  rankPassages,
  setConfidenceFloor,
  suggestSkill,
} from "../src/decisions.ts";
import { requestExtensions } from "../src/index.ts";
import { JevClient, type Question } from "../src/jev.ts";

const question: Record<string, Question> = {
  skill: { type: "choice", instructions: "Pick one", criteria: { s0: "Code", none: "None" } },
};
const response = (answers: unknown) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 100 },
});
const choice = (selected = "s0", confidence = 0.95) => ({
  type: "choice" as const,
  choice: selected,
  confidence,
  probabilities: { s0: selected === "s0" ? 0.99 : 0.01, none: selected === "none" ? 0.99 : 0.01 },
});
const mock = (value: unknown) =>
  new JevClient({ apiKey: "test-only", fetch: async () => Response.json(value) });
const skill = {
  name: "typescript",
  description: "Write TypeScript",
  filePath: "/skills/ts/SKILL.md",
};

test("sends one request with the documented endpoint, pinned model, and only supplied state", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "test-only",
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(options?.redirect, "error");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, "jev-1.13.0");
      assert.deepEqual(body.state, { request: "Write a TypeScript module" });
      assert.equal(JSON.stringify(body).includes(skill.filePath), false);
      return Response.json(response({ skill: choice() }));
    },
  });
  assert.equal(
    (await suggestSkill(client, "Write a TypeScript module", [skill])).selected?.name,
    "typescript",
  );
  assert.equal(calls, 1);
});

test("a self-hosted base URL replaces the origin, needs no key, and rejects other schemes", async () => {
  const seen: string[] = [];
  const client = new JevClient({
    baseUrl: "http://192.168.0.4:8011/",
    fetch: async (url, options) => {
      seen.push(`${options?.method} ${url}`);
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      return options?.method === "HEAD"
        ? new Response(null)
        : Response.json(response({ skill: choice() }));
    },
  });
  assert.equal(client.configured, true);
  await client.warm();
  const outcome = await client.evaluate({ request: "x" }, question);
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [
    "HEAD http://192.168.0.4:8011/",
    "POST http://192.168.0.4:8011/v1/systemone",
  ]);
  for (const baseUrl of ["ftp://host/", "not a url", ""]) {
    const bad = new JevClient({ baseUrl, fetch: async () => assert.fail("unexpected call") });
    assert.equal(bad.configured, false);
    assert.equal((await bad.evaluate({}, question)).ok, false);
  }
  const prefixed = new JevClient({
    apiKey: "k",
    baseUrl: "https://example.test/jev//",
    fetch: async (url) => {
      assert.equal(url, "https://example.test/jev/v1/systemone");
      return Response.json(response({ skill: choice() }));
    },
  });
  assert.equal((await prefixed.evaluate({}, question)).ok, true);
});

test("request extensions ride along without overriding the core fields", async () => {
  const client = new JevClient({
    apiKey: "k",
    extensions: { samples: 1, model: "other", state: "x", questions: {} },
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.samples, 1);
      assert.equal(body.model, "jev-1.13.0");
      assert.deepEqual(body.state, { request: "r" });
      assert.deepEqual(Object.keys(body.questions), ["skill"]);
      return Response.json(response({ skill: choice() }));
    },
  });
  assert.equal((await client.evaluate({ request: "r" }, question)).ok, true);
  for (const value of ['{"samples":1}', "[1]", "null", "nonsense", "", undefined]) {
    const parsed = requestExtensions(value);
    assert.deepEqual(parsed, value === '{"samples":1}' ? { samples: 1 } : undefined);
  }
});

test("the confidence floor is configurable within bounds and gates evidence and skills", async () => {
  try {
    assert.equal(setConfidenceFloor("0.6"), 0.6);
    assert.equal(isDirectEvidence({ id: "p", text: "", score: 1.8, confidence: 0.65 }), true);
    for (const bad of ["0.4", "1.5", "abc", undefined, null])
      assert.equal(setConfidenceFloor(bad), 0.6);
    const client = mock(response({ skill: choice("s0", 0.7) }));
    assert.equal(
      (await suggestSkill(client, "Write TypeScript", [skill])).selected?.name,
      "typescript",
    );
  } finally {
    setConfidenceFloor(0.8);
  }
  assert.equal(isDirectEvidence({ id: "p", text: "", score: 1.8, confidence: 0.65 }), false);
});

test("uncertain and no-match choices do not change the prompt", async () => {
  for (const answer of [choice("s0", 0.4), choice("none")]) {
    assert.equal(
      (await suggestSkill(mock(response({ skill: answer })), "hello", [skill])).selected,
      undefined,
    );
  }
});

test("missing key, cancellation, and oversized input make no request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error("unexpected network");
  };
  const client = new JevClient({ apiKey: "test-only", fetch: fetcher });
  assert.equal((await new JevClient({ fetch: fetcher }).evaluate({}, question)).ok, false);
  assert.equal((await client.evaluate({}, question, AbortSignal.abort())).ok, false);
  assert.equal((await client.evaluate("x".repeat(48_000), question)).ok, false);
  assert.equal(calls, 0);
});

test("explicit skills, disabled skills and over-limit catalogs skip evaluation", async () => {
  const client = new JevClient({
    apiKey: "test-only",
    fetch: async () => {
      assert.fail("unexpected call");
    },
  });
  for (const prompt of [
    "/skill:typescript do this",
    '<skill name="typescript">expanded</skill>',
    "x".repeat(8001),
  ]) {
    assert.equal((await suggestSkill(client, prompt, [skill])).outcome, undefined);
  }
  assert.equal(
    (await suggestSkill(client, "code", [{ ...skill, disableModelInvocation: true }])).outcome,
    undefined,
  );
  assert.equal(
    (
      await suggestSkill(
        client,
        "code",
        Array.from({ length: 65 }, () => skill),
      )
    ).outcome,
    undefined,
  );
});

test("rejects incomplete, unknown, malformed and out-of-range answers", async () => {
  const malformed = [
    {},
    response({}),
    response({ skill: { ...choice(), choice: "s999" } }),
    response({ skill: { ...choice(), confidence: 2 } }),
    response({ skill: { ...choice(), probabilities: { s0: 1 } } }),
    response({ skill: { ...choice(), probabilities: { s0: 0.9, none: 0.9 } } }),
    { ...response({ skill: choice() }), usage: { input_tokens: -1 } },
  ];
  for (const value of malformed) assert.equal((await mock(value).evaluate({}, question)).ok, false);
});

test("HTTP failures and malformed JSON fall back without retries", async () => {
  for (const status of [401, 422, 429, 500, 529]) {
    let calls = 0;
    const client = new JevClient({
      apiKey: "test-only",
      fetch: async () => {
        calls++;
        return new Response("private server detail", { status });
      },
    });
    const outcome = await client.evaluate({}, question);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, `http-${status}`);
    assert.equal(calls, 1);
  }
  const client = new JevClient({
    apiKey: "test-only",
    fetch: async () => new Response("not JSON"),
  });
  assert.equal((await client.evaluate({}, question)).ok, false);
});

test("deadline and caller cancellation abort in-flight requests", async () => {
  const fetcher: typeof fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  // Keep the event loop alive while AbortSignal.timeout's unref timer is pending.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const outcome = await new JevClient({
      apiKey: "test-only",
      timeoutMs: 10,
      fetch: fetcher,
    }).evaluate({}, question);
    assert.equal(!outcome.ok && outcome.reason, "timeout");
    const controller = new AbortController();
    const pending = new JevClient({ apiKey: "test-only", fetch: fetcher }).evaluate(
      {},
      question,
      controller.signal,
    );
    controller.abort();
    const cancelled = await pending;
    assert.equal(!cancelled.ok && cancelled.reason, "cancelled");
  } finally {
    clearInterval(keepAlive);
  }
});

test("ranking batches questions and retains every original passage verbatim", async () => {
  const passages = [
    { id: "background", text: "Other text" },
    { id: "answer", text: "The required evidence" },
  ];
  const score = (value: number, confidence = 0.95) => ({
    type: "score",
    score: value,
    confidence,
    probabilities: { "0": value === 0 ? 1 : 0, "1": 0, "2": value === 2 ? 1 : 0 },
  });
  const result = await rankPassages(
    mock(response({ p0: score(0), p1: score(2) })),
    "question",
    passages,
  );
  assert.deepEqual(
    result.passages.map((p) => p.id),
    ["answer", "background"],
  );
  assert.equal(result.passages[0]?.text, passages[1]?.text);
  const uncertain = await rankPassages(
    mock(response({ p0: score(0), p1: score(2, 0.5) })),
    "question",
    passages,
  );
  assert.deepEqual(
    uncertain.passages.map((p) => p.id),
    passages.map((p) => p.id),
  );
  const uncertainBackground = await rankPassages(
    mock(response({ p0: score(0, 0.5), p1: score(2) })),
    "question",
    passages,
  );
  assert.equal(uncertainBackground.passages[0]?.id, "answer");
  const failed = await rankPassages(mock({}), "question", passages);
  assert.deepEqual(failed.passages, passages);
});

test("duplicate passage IDs and empty queries are skipped", async () => {
  const client = new JevClient({
    apiKey: "test-only",
    fetch: async () => assert.fail("unexpected call"),
  });
  assert.equal(
    (
      await rankPassages(client, "q", [
        { id: "same", text: "a" },
        { id: "same", text: "b" },
      ])
    ).outcome,
    undefined,
  );
  assert.equal((await rankPassages(client, " ", [{ id: "a", text: "a" }])).outcome, undefined);
});

test("exact successful judgments reuse a bounded cache without stale state or token mutation", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "test",
    fetch: async () => {
      calls++;
      return Response.json(response({ skill: choice() }));
    },
  });
  const first = await client.evaluate({ prompt: "same" }, question);
  assert.ok(first.ok);
  first.result.answers.skill = choice("none");
  const second = await client.evaluate({ prompt: "same" }, question);
  assert.ok(second.ok && second.cached);
  assert.equal(
    second.result.answers.skill?.type === "choice" && second.result.answers.skill.choice,
    "s0",
  );
  assert.equal(calls, 1);
  await client.evaluate({ prompt: "changed" }, question);
  assert.equal(calls, 2);
  assert.ok(question.skill);
  await client.evaluate(
    { prompt: "same" },
    { skill: { ...question.skill, instructions: "new judgment" } },
  );
  assert.equal(calls, 3);
  const cancelled = await client.evaluate({ prompt: "same" }, question, AbortSignal.abort());
  assert.equal(cancelled.ok, false);
  for (let i = 0; i < 33; i++) await client.evaluate({ prompt: i }, question);
  const evicted = await client.evaluate({ prompt: "same" }, question);
  assert.ok(evicted.ok && !evicted.cached);
});

test("cache expiration and failures allow a fresh network attempt", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "test",
    cacheTtlMs: 1,
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response("", { status: 503 })
        : Response.json(response({ skill: choice() }));
    },
  });
  await client.evaluate({}, question);
  const recovered = await client.evaluate({}, question);
  assert.ok(recovered.ok && !recovered.cached);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await client.evaluate({}, question);
  assert.ok(expired.ok && !expired.cached);
  assert.equal(calls, 3);
});

test("repeated service failure opens a cooldown to avoid paying a timeout on every call", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "test",
    fetch: async () => {
      calls++;
      return new Response("", { status: 503 });
    },
  });
  await client.evaluate({}, question);
  await client.evaluate({}, question);
  const fallback = await client.evaluate({}, question);
  assert.equal(!fallback.ok && fallback.reason, "circuit-open");
  assert.equal(calls, 2);
});

test("cooldown expiry permits recovery", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "test",
    cooldownMs: 1,
    fetch: async () =>
      ++calls <= 2
        ? new Response("", { status: 503 })
        : Response.json(response({ skill: choice() })),
  });
  await client.evaluate({}, question);
  await client.evaluate({}, question);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok((await client.evaluate({}, question)).ok);
  assert.equal(calls, 3);
});
