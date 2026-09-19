import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Freeze cases before running. Compare context reduction separately from Jev's contribution.
const cases = [
  {
    query: "What must the current client do when a network request fails?",
    expected: "RETURN_CACHE",
  },
  {
    query: "Which command checks the current release before deployment?",
    expected: "npm run verify:release",
  },
  { query: "What is the production database password?", expected: "UNKNOWN" },
];
const sections = [
  "# Network retry history\nThe archived client repeated failed network requests five times. This is not current behavior.",
  "# Release command history\nThe archived deployment command was npm run ship:old. It is no longer valid.",
  "# Database password policy\nProduction database passwords are stored in a separate secret manager. Their values are not documented here.",
  "# UI theme\nUsers can choose a light or dark theme. Theme settings do not affect transport behavior.",
  "# Logging\nOperational logs contain timestamps and event names. Credentials must not appear in logs.",
  "# Cache maintenance\nThe cache stores previous successful responses and evicts the oldest entries first.",
  "# Current failure handling\nIf the transport cannot reach the service, immediately use the previously saved response. The exact action code is RETURN_CACHE. Do not repeat the request.",
  "# Current release verification\nBefore deploying the current release, execute npm run verify:release. This runs the mandatory verification suite.",
  "# Accessibility\nThe application supports keyboard navigation and descriptive labels for controls.",
  "# Deployment regions\nThe service runs in two regions. Failover is managed by the infrastructure team.",
  "# Development setup\nInstall dependencies using npm ci. Development setup does not validate release readiness.",
  "# Support\nSupport tickets should include a reproducible example and the affected version.",
];
const model = process.env.PI_BENCH_MODEL ?? "local-qwen/qwen3.8-27b";
const baseEnv = { ...process.env, PI_TELEMETRY: "0" };
const padding = Number(process.env.PI_BENCH_PADDING ?? 0);
if (!Number.isInteger(padding) || padding < 0 || padding > 200) throw new Error("Invalid padding");
for (let i = 0; i < padding; i++) {
  sections.push(
    `# Historical design note ${i + 1}\n${"Typography uses consistent spacing. Colors distinguish navigation elements. Layout adapts to viewport dimensions. Icons have labels. Animations respect accessibility preferences. ".repeat(3)}`,
  );
}
const reportPrefix = padding ? "retrieval-large" : "retrieval";
const repeats = Number(process.env.PI_BENCH_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error("Invalid repeat count");
if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY");
const run = promisify(execFile);
const cwd = await mkdtemp(join(tmpdir(), "pi-jev-bench-"));
const rows: Record<string, unknown>[] = [];
const extension = resolve("src/index.ts");
await mkdir("results", { recursive: true });
await writeFile(join(cwd, "guide.md"), `${sections.join("\n\n")}\n`);
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [index, task] of cases.entries()) {
      const modes = ["read", "local", "jev"];
      const offset = (repeat + index) % modes.length;
      for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
        const env: NodeJS.ProcessEnv = { ...baseEnv };
        if (mode !== "jev") delete env.TYPESAFE_API_KEY;
        const tool = mode === "read" ? "read" : "jev_search";
        const prompt = `Use ${tool} on guide.md to answer this question: ${task.query} ${mode === "read" ? "Read the full file." : 'Use the question verbatim as query, paths ["guide.md"], and limit 3.'} Return only the exact action code or command. If the source does not state an answer, return UNKNOWN.`;
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
              "--tools",
              tool,
              "--model",
              model,
              "--thinking",
              "off",
              "--mode",
              "json",
              "-p",
              prompt,
            ],
            { cwd, env, timeout: 90_000, maxBuffer: 4_000_000 },
          );
          execution.child.stdin?.end();
          const { stdout } = await execution;
          await writeFile(`results/${reportPrefix}-${repeat}-${index}-${mode}.jsonl`, stdout);
          const events = stdout
            .trim()
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line));
          const messages = events
            .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
            .map((event) => event.message);
          const final = messages.at(-1);
          const answer = final?.content
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text)
            .join("")
            .trim();
          const tools = events.filter((event) => event.type === "tool_execution_end");
          rows.push({
            repeat,
            case: index,
            mode,
            answer,
            correct:
              answer === task.expected &&
              final?.stopReason !== "error" &&
              tools.length > 0 &&
              tools.every((event) => !event.isError),
            elapsedMs: performance.now() - start,
            inputTokens: messages.reduce((n, m) => n + (m.usage?.input ?? 0), 0),
            outputTokens: messages.reduce((n, m) => n + (m.usage?.output ?? 0), 0),
            toolCalls: tools.length,
            retrieval: tools
              .filter((event) => event.toolName === "jev_search")
              .map((event) => {
                const result = JSON.parse(event.result.content[0].text);
                return {
                  status: result.status,
                  lines: result.snippets?.map(
                    (snippet: { startLine: number }) => snippet.startLine,
                  ),
                  elapsedMs: event.result.details?.elapsedMs,
                };
              }),
          });
        } catch {
          rows.push({
            repeat,
            case: index,
            mode,
            correct: false,
            elapsedMs: performance.now() - start,
            error: "Pi failed, output invalid, or exceeded 90 seconds",
          });
        }
        console.log(
          `${repeat}/${index}/${mode}: ${rows.at(-1)?.correct ? "correct" : "failed"} (${Math.round(Number(rows.at(-1)?.elapsedMs))} ms)`,
        );
        await writeFile(
          `results/${reportPrefix}-benchmark.json`,
          `${JSON.stringify({ model, repeats, cases, sections, scope: "Synthetic file question answering; actual Pi tools. Rotated order; uncontrolled server cache. Not a coding-quality benchmark.", rows }, null, 2)}\n`,
        );
      }
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
if (rows.some((row) => !row.correct)) process.exitCode = 1;
