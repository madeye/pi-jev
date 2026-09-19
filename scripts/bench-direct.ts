import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Reuse the exact fixture and questions from the completed paired retrieval experiment.
const previous = JSON.parse(await readFile("results/retrieval-large-benchmark.json", "utf8"));
const run = promisify(execFile);
const env = { ...process.env, PI_TELEMETRY: "0" };
const extension = resolve("src/index.ts");
const cwd = await mkdtemp(join(tmpdir(), "pi-jev-direct-"));
const rows = [];
await writeFile(join(cwd, "guide.md"), `${previous.sections.join("\n\n")}\n`);
try {
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const [index, task] of previous.cases.entries()) {
      const start = performance.now();
      const execution = run(
        "pi",
        [
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--no-session",
          "--no-tools",
          "-e",
          extension,
          "--model",
          previous.model,
          "--mode",
          "json",
          "-p",
          `/jev find ${task.query} -- guide.md`,
        ],
        { cwd, env, timeout: 15_000, maxBuffer: 1_000_000 },
      );
      execution.child.stdin?.end();
      const { stdout } = await execution;
      const elapsedMs = performance.now() - start;
      await writeFile(`results/direct-${repeat}-${index}.jsonl`, stdout);
      const events = stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      const messages = events
        .filter((event) => event.type === "message_end")
        .map((event) => event.message);
      const result = messages.find((message) => message.customType === "jev-find")?.details;
      const expectedText = task.expected === "UNKNOWN" ? "not documented" : task.expected;
      const evidenceFound =
        result?.snippets?.some((snippet: { text: string }) =>
          snippet.text.includes(expectedText),
        ) ?? false;
      const modelMessages = messages.filter((message) => message.role === "assistant").length;
      const agentStarts = events.filter((event) => event.type === "agent_start").length;
      rows.push({
        repeat,
        case: index,
        elapsedMs,
        evidenceFound,
        modelMessages,
        agentStarts,
        status: result?.status,
      });
      console.log(
        `${repeat}/${index}: ${evidenceFound ? "evidence found" : "missing"}, ${modelMessages} model messages, ${Math.round(elapsedMs)} ms`,
      );
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
await writeFile(
  "results/direct-benchmark.json",
  `${JSON.stringify({ scope: "Direct excerpt lookup on the exact large-retrieval fixture. Returns evidence, not a generated answer. Timings include Pi startup. Run after the model-based experiment, not interleaved.", model: previous.model, rows }, null, 2)}\n`,
);
assert.ok(
  rows.every((row) => row.evidenceFound && row.modelMessages === 0 && row.agentStarts === 0),
);
