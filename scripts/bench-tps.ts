import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { aggregate, type RequestSample, type RunSample } from "./bench-stats.ts";
import { benchmarkEnvironment } from "./environment.ts";

/**
 * Throughput benchmark: does Jev improve Pi's tokens-per-second by compressing
 * the context the generator must prefill and by reducing tool round trips?
 *
 * Each task needs facts spread across several large, padded files with archived
 * distractors. The baseline must read files fully; Jev retrieves a short
 * excerpt set. We record per-request input/output tokens, prefill (TTFT) and
 * decode throughput, tool executions, and independent answer correctness.
 *
 * Context compression and fewer tool calls are the hypotheses, not assumptions:
 * this script reports negative results as readily as positive ones.
 */

const tasks = [
  {
    name: "incident-policy",
    question:
      "What is the current emergency access code, the current production deployment approval token, and the current audit-log retention period?",
    required: ["EAGLE-7", "TOKEN-MINT", "400"],
  },
  {
    name: "rate-limits",
    question:
      "What are the current public API rate limit and the current internal service rate limit?",
    required: ["250", "900"],
  },
];

const padding = (topic: string) =>
  Array.from(
    { length: 60 },
    (_, index) =>
      `# ${topic} operational note ${index + 1}\nThe ${topic} dashboard summarizes health metrics for shard ${index + 1}. Operators review latency, queue depth, error budgets, and host availability. This note does not define any policy value and is unrelated to the question.`,
  ).join("\n\n");

const files: Record<string, string> = {
  "security.md": `# Emergency access history\nBefore this revision, the emergency access code was FALCON-1. That code is retired and must not be used.\n\n# Current emergency access\nThe current emergency access code is EAGLE-7. Rotate it after every incident.\n\n${padding("security")}`,
  "deploy.md": `# Deployment approval history\nThe archived deployment approval token was TOKEN-OLD. It no longer authorizes production deploys.\n\n# Current deployment approval\nProduction deploys require the current approval token TOKEN-MINT.\n\n${padding("deploy")}`,
  "retention.md": `# Retention history\nAn earlier policy retained audit logs for 30 days. That policy is archived.\n\n# Current retention\nThe current policy retains audit logs for 400 days.\n\n${padding("retention")}`,
  "api.md": `# Public API limit history\nThe archived public API limit was 100 requests per minute.\n\n# Current public API limit\nThe current public API rate limit is 250 requests per minute.\n\n${padding("api")}`,
  "internal.md": `# Internal limit history\nThe archived internal service limit was 60 requests per minute.\n\n# Current internal rate limit\nInternal service calls are limited to 900 requests per minute.\n\n${padding("internal")}`,
};

const run = promisify(execFile);
const extension = resolve("src/index.ts");
const model = process.env.PI_BENCH_MODEL ?? "local-qwen/qwen3.8-27b";
const speedExperiment = process.env.PI_BENCH_SPEED === "1";
const reportPrefix = speedExperiment ? "tps-speed" : "tps";
const repeats = Number(process.env.PI_BENCH_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Invalid repeats");
const modes = (process.env.PI_BENCH_MODES ?? "read,local,jev")
  .split(",")
  .map((mode) => mode.trim())
  .filter(Boolean);
const allModes = ["read", "local", "jev", "bash", "focus"];
const hosted = (mode: string) => mode === "jev" || mode === "focus";
if (modes.length === 0 || modes.some((mode) => !allModes.includes(mode)))
  throw new Error(`PI_BENCH_MODES must be a comma-separated subset of ${allModes.join(",")}`);
if (modes.some(hosted) && !process.env.TYPESAFE_API_KEY)
  throw new Error(
    "Set TYPESAFE_API_KEY for the jev and focus modes, use PI_BENCH_MODES=read,local, or run bench:retrieval for keyless retrieval",
  );

const baseEnv = benchmarkEnvironment();
const fileNames = Object.keys(files);
const rows: Record<string, unknown>[] = [];
const samplesByMode: Record<string, RunSample[]> = Object.fromEntries(
  allModes.map((mode) => [mode, []]),
);
await mkdir("results", { recursive: true });

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const [index, task] of tasks.entries()) {
    const rotated = [
      ...modes.slice((repeat + index) % modes.length),
      ...modes.slice(0, (repeat + index) % modes.length),
    ];
    for (const mode of rotated) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-jev-tps-"));
      const timingPath = join(cwd, "timings.jsonl");
      const observer = join(cwd, "observer.ts");
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      if (!hosted(mode)) delete env.TYPESAFE_API_KEY;
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(cwd, name), `${content}\n`);
      }
      await writeFile(
        observer,
        `import { appendFileSync } from "node:fs";
const file = ${JSON.stringify(timingPath)};
const log = (value) => appendFileSync(file, JSON.stringify(value) + "\\n");
export default (pi) => {
  let started;
  let first;
  pi.on("before_provider_request", () => {
    started = Date.now();
    first = undefined;
  });
  pi.on("message_start", (event) => {
    if (event.message?.role === "assistant" && started === undefined) started = Date.now();
  });
  pi.on("message_update", () => {
    if (started !== undefined && first === undefined) first = Date.now();
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message?.role !== "assistant" || started === undefined) return;
    const ended = Date.now();
    log({
      input: message.usage?.input ?? 0,
      output: message.usage?.output ?? 0,
      reasoning: message.usage?.reasoning ?? 0,
      requestMs: ended - started,
      ttftMs: first === undefined ? null : first - started,
    });
    started = undefined;
    first = undefined;
  });
};\n`,
      );
      // bash and focus share one prompt and tool set; only --jev-tools differs.
      const shell = mode === "bash" || mode === "focus";
      const prompt = shell
        ? `Files in the current directory: ${fileNames.join(", ")}. Use bash to cat one file per call, gather current policy evidence, and answer this question: ${task.question} Rely only on current, non-archived values. Finish with a single line beginning "ANSWER:" that lists the requested values.`
        : mode === "read"
          ? `Files in the current directory: ${fileNames.join(", ")}. Use read to gather current policy evidence and answer this question: ${task.question} Rely only on current, non-archived values. Finish with a single line beginning "ANSWER:" that lists the requested values.`
          : `Files in the current directory: ${fileNames.join(", ")}. Use jev_search with paths ${JSON.stringify(fileNames)} and limit 9 to retrieve current policy evidence and answer this question: ${task.question} You may call jev_search more than once. Rely only on current, non-archived values. Finish with a single line beginning "ANSWER:" that lists the requested values.${mode === "local" ? " Jev is unavailable; jev_search uses local ranking." : ""}`;
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
            ...(mode === "focus" ? ["--jev-tools"] : []),
            "--tools",
            shell ? "bash" : mode === "read" ? "read" : "jev_search",
            "--model",
            model,
            "--thinking",
            "off",
            "--mode",
            "json",
            "-p",
            prompt,
          ],
          { cwd, env, timeout: 120_000, maxBuffer: 8_000_000 },
        );
        execution.child.stdin?.end();
        const { stdout } = await execution;
        const elapsedMs = performance.now() - start;
        const artifact = `results/${reportPrefix}-${repeat}-${task.name}-${mode}`;
        await writeFile(`${artifact}.jsonl`, stdout);
        const events = stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line));
        const assistantMessages = events
          .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
          .map((event) => event.message);
        const final = assistantMessages.at(-1);
        const answer = (final?.content ?? [])
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("")
          .trim();
        const tools = events.filter((event) => event.type === "tool_execution_end");
        const retrieval = tools
          .filter((event) => event.toolName === "jev_search" || mode === "focus")
          .map((event) => {
            try {
              const text: string = event.result.content[0].text;
              if (mode === "focus")
                return text.includes("\n[jev: kept ")
                  ? "evaluated"
                  : text.includes("\n[jev: withheld ")
                    ? "withheld"
                    : "unfocused";
              return JSON.parse(text).status as string;
            } catch {
              return "unparseable";
            }
          });
        const hostedEvaluated = retrieval.filter(
          (status) => status === "evaluated" || status === "cached" || status === "withheld",
        ).length;
        const correct =
          task.required.every((fact) => answer.includes(fact)) &&
          tools.length > 0 &&
          tools.every((event) => !event.isError);
        let requests: RequestSample[] = [];
        try {
          requests = (await readFile(timingPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((row) => typeof row.output === "number")
            .map((row) => ({
              input: row.input ?? 0,
              output: row.output ?? 0,
              reasoning: row.reasoning ?? 0,
              requestMs: typeof row.requestMs === "number" ? row.requestMs : null,
              ttftMs: typeof row.ttftMs === "number" ? row.ttftMs : null,
            }));
        } catch {
          /* No provider request was observed. */
        }
        const runSample: RunSample = {
          elapsedMs,
          toolCalls: tools.length,
          requests,
          hostedEvaluated,
          hostedFallback: retrieval.length - hostedEvaluated,
        };
        samplesByMode[mode]?.push(runSample);
        rows.push({
          repeat,
          task: task.name,
          mode,
          correct,
          answer,
          elapsedMs,
          toolCalls: tools.length,
          toolNames: tools.map((event) => event.toolName),
          toolErrors: tools.filter((event) => event.isError).length,
          retrieval,
          hostedEvaluated,
          withheld: retrieval.filter((status) => status === "withheld").length,
          requests: requests.length,
          inputTokens: requests.reduce((total, request) => total + request.input, 0),
          outputTokens: requests.reduce((total, request) => total + request.output, 0),
          reasoningTokens: requests.reduce((total, request) => total + request.reasoning, 0),
        });
      } catch {
        rows.push({
          repeat,
          task: task.name,
          mode,
          correct: false,
          elapsedMs: performance.now() - start,
          error: "Pi failed, output invalid, or exceeded deadline",
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
      console.log(
        `${repeat}/${task.name}/${mode}: ${rows.at(-1)?.correct ? "correct" : "failed"} (${Math.round(Number(rows.at(-1)?.elapsedMs))} ms)`,
      );
      await writeFile(
        `results/${reportPrefix}-benchmark.json`,
        `${JSON.stringify(
          {
            model,
            repeats,
            modes,
            speedExperiment,
            tasks: tasks.map((task) => ({
              name: task.name,
              question: task.question,
              required: task.required,
            })),
            files: Object.keys(files),
            scope:
              "Throughput comparison on frozen multi-file policy tasks using actual Pi tools. Read mode reads full padded files; local and jev modes retrieve excerpts; bash and focus modes cat files without and with --jev-tools output focusing. Rotated order, uncontrolled server cache. Measures context size, tool executions, prefill (TTFT), and decode TPS. Not a coding-quality or general-speed claim.",
            aggregate: Object.fromEntries(
              modes.map((mode) => [mode, aggregate(samplesByMode[mode] ?? [])]),
            ),
            rows,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
}

const summary = Object.fromEntries(
  Object.entries(samplesByMode).map(([mode, samples]) => [mode, aggregate(samples)]),
);
for (const mode of modes) {
  const value = summary[mode];
  if (!value) continue;
  console.log(
    `${mode}: ${value.requests} requests, ${value.toolCallsTotal} tool calls, median ${Math.round(value.inputTokensMedian ?? 0)} input tokens, effective ${value.effectiveTpsMedian?.toFixed(2) ?? "n/a"} tok/s, decode ${value.decodeTpsMedian?.toFixed(2) ?? "n/a"} tok/s, TTFT ${Math.round(value.ttftMsMedian ?? 0)} ms, hosted ${value.hostedEvaluatedTotal}/${value.hostedEvaluatedTotal + value.hostedFallbackTotal}`,
  );
}
if (rows.some((row) => !row.correct)) process.exitCode = 1;
