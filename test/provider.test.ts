import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { benchmarkEnvironment } from "../scripts/environment.ts";

test("installed Pi forwards adaptive thinking control to an actual HTTP provider", {
  timeout: 30_000,
}, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const common = {
      id: "test",
      object: "chat.completion.chunk",
      created: 0,
      model: "qwen3.8-27b",
    };
    res.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-provider-"));
  try {
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "unused",
            models: [
              {
                id: "qwen3.8-27b",
                name: "Test model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 512,
              },
            ],
          },
        },
      }),
    );
    const extension = join(cwd, "fixture.ts");
    await writeFile(
      extension,
      `import jev from ${JSON.stringify(pathToFileURL(resolve("src/index.ts")).href)};
import { JevClient } from ${JSON.stringify(pathToFileURL(resolve("src/jev.ts")).href)};
export default (pi) => jev(pi, new JevClient({ apiKey: 'test', fetch: async () => Response.json({ model: 'jev-1.13.0', usage: {}, answers: { execution: { type: 'choice', choice: 'fast', confidence: 0.99, probabilities: { fast: 0.99, preserve: 0.01 } } } }) }));\n`,
    );
    for (const adaptive of [false, true]) {
      const execution = promisify(execFile)(
        process.execPath,
        [
          resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--no-session",
          "--no-tools",
          "-e",
          extension,
          ...(adaptive ? ["--jev-speed"] : []),
          "--model",
          "fixture/qwen3.8-27b",
          "--thinking",
          "off",
          "--mode",
          "json",
          "-p",
          "Say done",
        ],
        {
          cwd,
          timeout: 12_000,
          maxBuffer: 1_000_000,
          env: benchmarkEnvironment({
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            TYPESAFE_API_KEY: "test",
            PI_TELEMETRY: "0",
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            http_proxy: "http://127.0.0.1:9",
            https_proxy: "http://127.0.0.1:9",
            NO_PROXY: "",
            no_proxy: "",
          }),
        },
      );
      execution.child.stdin?.end();
      const { stdout, stderr } = await execution;
      assert.equal(stderr.includes("Extension error"), false, stderr);
      const events = stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      const final = events.findLast(
        (event) => event.type === "message_end" && event.message?.role === "assistant",
      );
      assert.equal(final?.message.stopReason, "stop");
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.chat_template_kwargs, undefined);
    assert.deepEqual(requests[1]?.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(requests[1]?.messages, requests[0]?.messages);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
