import assert from "node:assert/strict";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { focusOutput, readOnlyCommand } from "../src/focus.ts";
import jevExtension from "../src/index.ts";
import { JevClient } from "../src/jev.ts";

// 40 grep-style blocks; only one mentions the retry delay the user asked about.
const output = Array.from({ length: 40 }, (_, i) =>
  i === 17
    ? "src/net.ts:170: const retryDelayMs = 250; // current retry delay\n\n"
    : `src/file${i}.ts:${i}: ${"unrelated padding text ".repeat(8)}\n\n`,
).join("");
const query = "What is the retry delay?";

/** Scores passages containing `marker` as confident direct evidence, the rest as unrelated. */
function rankingClient(
  marker: string | undefined,
  calls: { count: number; query?: string; warmed?: boolean } = { count: 0 },
  unrelatedConfidence = 0.95,
) {
  return new JevClient({
    apiKey: "test",
    fetch: async (_url, options) => {
      if (options?.method === "HEAD") {
        // The warm-up opens the connection only; it carries no credentials or state.
        assert.equal(options.headers, undefined);
        assert.equal(options.body, undefined);
        calls.warmed = true;
        return new Response(null, { status: 204 });
      }
      calls.count++;
      const { state } = JSON.parse(String(options?.body)) as {
        state: { query: string; passages: { text: string }[] };
      };
      calls.query = state.query;
      const answers = Object.fromEntries(
        state.passages.map((passage, i) => {
          const direct = marker !== undefined && passage.text.includes(marker);
          return [
            `p${i}`,
            {
              type: "score",
              score: direct ? 2 : 0,
              confidence: direct ? 0.95 : unrelatedConfidence,
              probabilities: { "0": direct ? 0 : 1, "1": 0, "2": direct ? 1 : 0 },
            },
          ];
        }),
      );
      return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 10 }, answers });
    },
  });
}

test("large output keeps direct evidence, the final excerpt, and explicit omissions", async () => {
  const { text } = await focusOutput(rankingClient("retryDelayMs"), query, output);
  assert.ok(text);
  assert.ok(text.includes("const retryDelayMs = 250"));
  assert.ok(text.includes("src/file39.ts:39:"));
  assert.ok(!text.includes("src/file3.ts"));
  assert.match(text, /\[jev: lines 1-34 omitted\]/);
  assert.match(text, /kept 4 of 80 lines/);
  assert.match(text, /repeat the identical tool call/);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(output) / 4);
});

test("small output makes no hosted request", async () => {
  const client = new JevClient({ apiKey: "test", fetch: async () => assert.fail("unexpected") });
  assert.deepEqual(await focusOutput(client, query, "src/net.ts:1: retry\n"), {});
});

test("no confident direct evidence leaves the output untouched", async () => {
  const { text, outcome } = await focusOutput(rankingClient(undefined), query, output);
  assert.equal(text, undefined);
  assert.equal(outcome?.ok, true);
});

test("a hosted failure leaves the output untouched", async () => {
  const client = new JevClient({
    apiKey: "test",
    fetch: async () => new Response("", { status: 503 }),
  });
  const { text, outcome } = await focusOutput(client, query, output);
  assert.equal(text, undefined);
  assert.equal(outcome?.ok, false);
});

test("withholding keeps only the first and final excerpts of a confidently unrelated output", async () => {
  const { text, withheld } = await focusOutput(
    rankingClient(undefined),
    query,
    output,
    undefined,
    true,
  );
  assert.equal(withheld, true);
  assert.ok(text?.startsWith("src/file0.ts:0:"));
  assert.ok(text?.includes("src/file39.ts:39:"));
  assert.ok(!text?.includes("retryDelayMs"));
  assert.match(text ?? "", /\[jev: lines 3-78 omitted\]/);
  assert.match(text ?? "", /withheld 76 of 80 lines/);
});

test("uncertain judgments are never treated as unrelated", async () => {
  const { text } = await focusOutput(
    rankingClient(undefined, { count: 0 }, 0.6),
    query,
    output,
    undefined,
    true,
  );
  assert.equal(text, undefined);
});

test("only inspection pipelines count as read-only", () => {
  for (const command of ["cat a.md", "grep -rn retry src | head -50", "git log --oneline; ls"])
    assert.equal(readOnlyCommand(command), true, command);
  for (const command of [
    "npm test",
    "cat a.md > b.md",
    "cat a.md && rm a.md",
    "echo $(rm a.md)",
    "sed -i s/a/b/ a.md",
    "git commit -m x",
  ])
    assert.equal(readOnlyCommand(command), false, command);
});

function setup(client: JevClient, tools = true) {
  const handlers = new Map<string, unknown>();
  const pi = {
    on: (name: string, handler: unknown) => handlers.set(name, handler),
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    getFlag: (name: string) => (name === "jev-tools" ? tools : name === "jev"),
  } as unknown as ExtensionAPI;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-only";
  try {
    jevExtension(pi, client);
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
  const before = handlers.get("before_agent_start") as (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  const messageEnd = handlers.get("message_end") as (event: unknown) => void;
  const result = handlers.get("tool_result") as (
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ) => Promise<{ content?: unknown; details?: unknown } | undefined>;
  return { before, result, messageEnd };
}
const prompt = {
  type: "before_agent_start",
  prompt: query,
  systemPrompt: "",
  systemPromptOptions: { cwd: "/example" },
} as BeforeAgentStartEvent;
const grep = (toolName = "grep", isError = false, input: object = { pattern: "retry" }) =>
  ({
    type: "tool_result",
    toolName,
    toolCallId: "t1",
    input,
    content: [{ type: "text", text: output }],
    details: undefined,
    isError,
  }) as ToolResultEvent;

test("the hook is opt-in", async () => {
  const { before, result } = setup(
    new JevClient({ apiKey: "test", fetch: async () => assert.fail("unexpected") }),
    false,
  );
  await before(prompt, {} as ExtensionContext);
  assert.equal(await result(grep(), {} as ExtensionContext), undefined);
});

test("read output, errors, and turns without a text prompt are never altered", async () => {
  const { before, result } = setup(
    new JevClient({ apiKey: "test", fetch: async () => assert.fail("unexpected") }),
  );
  assert.equal(await result(grep(), {} as ExtensionContext), undefined);
  await before(prompt, {} as ExtensionContext);
  assert.equal(await result(grep("read"), {} as ExtensionContext), undefined);
  assert.equal(await result(grep("bash", true), {} as ExtensionContext), undefined);
});

test("repeating a focused call verbatim returns the complete output", async () => {
  const calls: { count: number; warmed?: boolean } = { count: 0 };
  const { before, result } = setup(rankingClient("retryDelayMs", calls));
  await before(prompt, {} as ExtensionContext);
  const first = await result(grep(), {} as ExtensionContext);
  assert.match(JSON.stringify(first?.content), /retryDelayMs = 250/);
  assert.equal(first?.details, undefined);
  assert.equal(await result(grep(), {} as ExtensionContext), undefined);
  assert.equal(calls.count, 1);
  assert.equal(calls.warmed, true);
});

test("unrelated output is withheld for inspection commands but not for side effects", async () => {
  const calls: { count: number; query?: string } = { count: 0 };
  const { before, result, messageEnd } = setup(rankingClient(undefined, calls));
  await before(prompt, {} as ExtensionContext);
  messageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Checking the deploy notes." }] },
  });
  const inspected = await result(
    grep("bash", false, { command: "cat deploy.md" }),
    {} as ExtensionContext,
  );
  assert.match(JSON.stringify(inspected?.content), /withheld 76 of 80 lines/);
  assert.match(calls.query ?? "", /Assistant intent: Checking the deploy notes\./);
  assert.equal(
    await result(grep("bash", false, { command: "npm run build" }), {} as ExtensionContext),
    undefined,
  );
});

test("outline keeps the declarations of omitted lines, with line numbers", async () => {
  const source = Array.from({ length: 40 }, (_, i) =>
    i === 17
      ? "fn retry_delay() -> u64 {\n    250 // current retry delay\n}\n\n"
      : `pub fn helper_${i}() {\n    // ${"unrelated padding text ".repeat(8)}\n}\n\n`,
  ).join("");
  const plain = await focusOutput(rankingClient("retry delay"), query, source, undefined, true);
  const outlined = await focusOutput(
    rankingClient("retry delay"),
    query,
    source,
    undefined,
    true,
    6,
    true,
  );
  assert.doesNotMatch(plain.text ?? "", /helper_3\(\)/);
  assert.match(outlined.text ?? "", /^ {2}13: pub fn helper_3\(\) \{$/m);
  assert.match(outlined.text ?? "", /250 \/\/ current retry delay/);
  assert.match(outlined.text ?? "", /declarations of omitted lines/);
  assert.doesNotMatch(outlined.text ?? "", /unrelated padding text .*helper_3/);
});
