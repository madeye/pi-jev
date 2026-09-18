import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import jevExtension from "../src/index.ts";
import { JevClient } from "../src/jev.ts";

const event: BeforeAgentStartEvent = {
  type: "before_agent_start",
  prompt: "Extract this PDF's text",
  systemPrompt: "Original instructions",
  systemPromptOptions: {
    cwd: "/example",
    skills: [
      {
        name: "pdf",
        description: "Extract text from PDFs",
        filePath: "/example/pdf/SKILL.md",
        baseDir: "/example/pdf",
        disableModelInvocation: false,
        sourceInfo: {
          path: "/example/pdf/SKILL.md",
          source: "local",
          scope: "project",
          origin: "top-level",
        },
      },
    ],
  },
};
const payload = {
  model: "jev-1.13.0",
  usage: { input_tokens: 100 },
  answers: {
    skill: {
      type: "choice",
      choice: "s0",
      confidence: 0.98,
      probabilities: { s0: 0.99, none: 0.01 },
    },
  },
};

function setup(client: JevClient, skillAdvice = true) {
  const handlers = new Map<string, unknown>();
  let command:
    | { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    | undefined;
  const messages: { message: unknown; options: unknown }[] = [];
  const pi = {
    on: (name: string, handler: unknown) => handlers.set(name, handler),
    registerFlag: () => {},
    registerCommand: (_name: string, value: typeof command) => {
      command = value;
    },
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    registerTool: () => {},
    getFlag: (name: string) => (name === "jev-skills" ? skillAdvice : true),
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
  ) => Promise<BeforeAgentStartEventResult | undefined>;
  const shutdown = handlers.get("session_shutdown") as () => void;
  const runCommand = async (args: string, ctx: ExtensionCommandContext) => {
    assert.ok(command);
    await command.handler(args, ctx);
  };
  return { before, shutdown, runCommand, messages };
}

test("direct file lookup delivers source evidence without triggering a model turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-command-"));
  try {
    await writeFile(join(cwd, "guide.md"), "Run npm test.\n");
    const { runCommand, messages } = setup(
      new JevClient({
        apiKey: "test",
        fetch: async () => assert.fail("one excerpt needs no ranking"),
      }),
    );
    await runCommand("find How to test? -- guide.md", { cwd } as ExtensionCommandContext);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.options, { triggerTurn: false });
    assert.match(JSON.stringify(messages[0]?.message), /Run npm test/);
    assert.match(JSON.stringify(messages[0]?.message), /guide.md:1-1/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill advice makes no critical-path request unless opted in", async () => {
  const { before } = setup(
    new JevClient({ apiKey: "test", fetch: async () => assert.fail("unexpected hosted call") }),
    false,
  );
  assert.equal(await before(event, {} as ExtensionContext), undefined);
});

test("skill advice is turn-local and preserves the original system instructions", async () => {
  const { before } = setup(
    new JevClient({ apiKey: "test-only", fetch: async () => Response.json(payload) }),
  );
  const result = await before(event, {} as ExtensionContext);
  assert.ok(result?.systemPrompt?.startsWith("Original instructions\n\n"));
  assert.ok(result?.systemPrompt?.includes("/example/pdf/SKILL.md"));
  assert.equal(result?.message, undefined);
  assert.equal(event.systemPrompt, "Original instructions");
});

test("image prompts never send a partial text-only request", async () => {
  const { before } = setup(
    new JevClient({ apiKey: "test-only", fetch: async () => assert.fail("unexpected upload") }),
  );
  const result = await before(
    { ...event, images: [{ type: "image", mimeType: "image/png", data: "test" }] },
    {} as ExtensionContext,
  );
  assert.equal(result, undefined);
});

test("a session shutdown invalidates a pending suggestion", async () => {
  let release: ((response: Response) => void) | undefined;
  const client = new JevClient({
    apiKey: "test-only",
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const { before, shutdown } = setup(client);
  const pending = before(event, {} as ExtensionContext);
  shutdown();
  assert.ok(release);
  release(Response.json(payload));
  assert.equal(await pending, undefined);
});
