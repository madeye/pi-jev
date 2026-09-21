import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Frozen synthetic coding tasks. Expected behavior is checked by a separate Node process.
const tasks = [
  {
    name: "retry-policy",
    query:
      "What is the current retry delay policy, including invalid inputs and non-retryable status codes?",
    signature: "retryDelay(status, attempt)",
    docs: [
      "# Archived retry policy\nBefore version 2, all HTTP errors were retried after 1000 milliseconds. This policy is obsolete.",
      "# Current retry policy\nOnly statuses 429 and 503 are retryable. Return null for all other statuses. A retry attempt must be an integer from 0 to 4 inclusive; otherwise return null. For retryable status and valid attempt, return Math.min(8000, 500 * 2 ** attempt) milliseconds. Do not coerce strings to numbers.",
      "# Error logging\nLog status and attempt for diagnostics, without including credentials or response bodies.",
    ],
    tests: `import assert from 'node:assert/strict'; import { retryDelay as f } from './solution.mjs';
for (const s of [429,503]) for(let a=0;a<=4;a++) assert.equal(f(s,a),Math.min(8000,500*2**a));
for(const s of [200,400,500,'429',null]) assert.equal(f(s,0),null);
for(const a of [-1,5,0.5,'0',NaN,Infinity,null]) assert.equal(f(429,a),null);`,
  },
  {
    name: "cache-expiry",
    query:
      "What is the current cache expiration policy, including invalid ages and private records?",
    signature: "isExpired(ageSeconds, isPrivate)",
    docs: [
      "# Archived expiration policy\nVersion 1 expired every record after 60 seconds. This is no longer the current policy.",
      "# Current cache expiration\nReturn true for invalid ages: anything other than a finite number greater than or equal to zero. Valid private records expire when ageSeconds is at least 30. Valid public records expire when ageSeconds is at least 300. A record is private only when isPrivate is exactly boolean true. Do not coerce strings or other truthy values.",
      "# Cache storage\nRecords are stored in memory and indexed by key. Expiration is checked before serving a record.",
    ],
    tests: `import assert from 'node:assert/strict'; import { isExpired as f } from './solution.mjs';
for(const a of [0,29,29.99]) assert.equal(f(a,true),false);
for(const a of [30,300]) assert.equal(f(a,true),true);
for(const a of [0,30,299.99]) assert.equal(f(a,false),false);
assert.equal(f(300,false),true);
for(const a of [-1,NaN,Infinity,'0',null,undefined]) assert.equal(f(a,false),true);
for(const p of ['true',1,{},null,undefined]) assert.equal(f(30,p),false);`,
  },
];
const run = promisify(execFile);
const extension = resolve("src/index.ts");
const model = process.env.PI_BENCH_MODEL ?? "local-qwen/qwen3.8-27b";
const speedExperiment = process.env.PI_BENCH_SPEED === "1";
const reportPrefix = speedExperiment ? "speed" : "coding";
const repeats = Number(process.env.PI_BENCH_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Invalid repeats");
if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY");
const rows: Record<string, unknown>[] = [];
const baseEnv = { ...process.env, PI_TELEMETRY: "0" };
await mkdir("results", { recursive: true });
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const [index, task] of tasks.entries()) {
    for (const mode of (repeat + index) % 2 ? ["jev", "read"] : ["read", "jev"]) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-jev-coding-"));
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      if (mode === "read") {
        // No key and an empty base URL: no judgment server at all, not the default one.
        delete env.TYPESAFE_API_KEY;
        env.TYPESAFE_BASE_URL = "";
      }
      const sections = [
        ...task.docs,
        ...Array.from(
          { length: 9 },
          (_, i) =>
            `# Operational note ${i + 1}\nThe dashboard presents health metrics for deployment region ${i + 1}. Operators monitor memory use, queue depth, request counts, and host availability. This note does not define application policy.`,
        ),
      ];
      await writeFile(join(cwd, "policy.md"), `${sections.join("\n\n")}\n`);
      await writeFile(
        join(cwd, "solution.mjs"),
        `export function ${task.signature} { throw new Error('TODO'); }\n`,
      );
      const observer = join(cwd, "observer.ts");
      await writeFile(
        observer,
        `import { appendFileSync } from "node:fs";
export default (pi) => pi.on("before_provider_request", event => {
  appendFileSync(${JSON.stringify(join(cwd, "request-controls.jsonl"))}, JSON.stringify({ nonThinking: event.payload?.chat_template_kwargs?.enable_thinking === false }) + "\\n");
});\n`,
      );
      const prompt = `Implement the exported function in solution.mjs according to the CURRENT policy in policy.md. ${mode === "jev" && !speedExperiment ? `Use jev_search with query ${JSON.stringify(task.query)}, paths ["policy.md"], limit 3 to retrieve policy evidence.` : "Use read to retrieve policy evidence."} Preserve the export signature. Write the implementation to solution.mjs. Do not change policy.md. You may read full files for more context. Finish with a brief description.`;
      const start = performance.now();
      try {
        const execution = run(
          "pi",
          [
            "--offline",
            "--no-extensions",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-session",
            "-e",
            extension,
            "-e",
            observer,
            ...(speedExperiment && mode === "jev" ? ["--jev-speed"] : []),
            "--tools",
            mode === "jev" && !speedExperiment ? "read,write,edit,jev_search" : "read,write,edit",
            "--model",
            model,
            "--thinking",
            "off",
            "--mode",
            "json",
            "-p",
            prompt,
          ],
          { cwd, env, timeout: 120_000, maxBuffer: 4_000_000 },
        );
        execution.child.stdin?.end();
        const { stdout } = await execution;
        const elapsedMs = performance.now() - start;
        const artifact = `results/${reportPrefix}-${repeat}-${task.name}-${mode}`;
        await writeFile(`${artifact}.jsonl`, stdout);
        await writeFile(`${artifact}.mjs`, await readFile(join(cwd, "solution.mjs")));
        // Tests are introduced only after generation, so the model cannot modify them.
        await writeFile(join(cwd, "verify.mjs"), task.tests);
        let testsPassed = false;
        try {
          await run(process.execPath, ["verify.mjs"], { cwd, timeout: 5000 });
          testsPassed = true;
        } catch {
          /* retain failed generation */
        }
        const events = stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line));
        const messages = events
          .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
          .map((e) => e.message);
        const calls = events.filter((e) => e.type === "tool_execution_end");
        let requestControls: { nonThinking: boolean }[] = [];
        try {
          requestControls = (await readFile(join(cwd, "request-controls.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        } catch {
          /* no provider requests */
        }
        rows.push({
          repeat,
          task: task.name,
          mode,
          testsPassed,
          elapsedMs,
          inputTokens: messages.reduce((n, m) => n + (m.usage?.input ?? 0), 0),
          outputTokens: messages.reduce((n, m) => n + (m.usage?.output ?? 0), 0),
          reasoningTokens: messages.reduce((n, m) => n + (m.usage?.reasoning ?? 0), 0),
          requestControls,
          toolCalls: calls.length,
          toolErrors: calls.filter((e) => e.isError).length,
          retrieval: calls
            .filter((e) => e.toolName === "jev_search")
            .map((e) => JSON.parse(e.result.content[0].text).status),
        });
      } catch {
        rows.push({
          repeat,
          task: task.name,
          mode,
          testsPassed: false,
          elapsedMs: performance.now() - start,
          error: "Pi failed, output invalid, or exceeded deadline",
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
      console.log(
        `${repeat}/${task.name}/${mode}: ${rows.at(-1)?.testsPassed ? "passed" : "failed"} (${Math.round(Number(rows.at(-1)?.elapsedMs))} ms)`,
      );
      await writeFile(
        `results/${reportPrefix}-benchmark.json`,
        `${JSON.stringify({ model, repeats, tasks, speedExperiment, scope: "Two frozen synthetic coding tasks, actual Pi extension and independently executed assertions. Alternated order; uncontrolled server cache. Speed experiment uses identical prompts/tools and varies only Jev thinking control. Does not establish general coding quality.", rows }, null, 2)}\n`,
      );
    }
  }
}
if (rows.some((row) => !row.testsPassed)) process.exitCode = 1;
