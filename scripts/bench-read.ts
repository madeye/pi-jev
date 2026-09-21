import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Read-focusing benchmark: is it safe and worthwhile to condense whole-file `read` results?
 *
 * Runs real Pi sessions with its built-in read, grep, find, ls and edit tools over a fresh
 * copy of a real repository (PI_BENCH_REPO, default the public ech-tls-tunnel checkout next to
 * this one), on lookup, comprehension and edit tasks whose answers are checked. Modes: `read`
 * (no focusing), `focus` (--jev-tools --jev-read plain) and `outline` (--jev-read outline,
 * which keeps the declarations of omitted lines). Rotated order; PI_BENCH_REPEATS repetitions.
 *
 * The risk being measured is the model needing what condensing dropped: watch repeated reads,
 * extra requests and failed edits, not only input tokens.
 */

const run = promisify(execFile);
const repo = resolve(process.env.PI_BENCH_REPO ?? "../ech-tls-tunnel");
const model = process.env.PI_BENCH_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const repeats = Number(process.env.PI_BENCH_REPEATS ?? 3);
const allModes = ["read", "focus", "outline"];
const modes = (process.env.PI_BENCH_MODES ?? allModes.join(",")).split(",");
if (modes.some((mode) => !allModes.includes(mode))) throw new Error(`modes: ${allModes.join(",")}`);
const extension = resolve("src/index.ts");

interface Task {
  name: string;
  prompt: string;
  /** Checked against the final answer, or for edit tasks against the working copy. */
  check: (answer: string, cwd: string) => Promise<boolean>;
}
const answerHas =
  (...patterns: RegExp[]) =>
  async (answer: string) =>
    patterns.every((pattern) => pattern.test(answer));
const fileHas =
  (path: string, present: RegExp, changedLines: number) => async (_: string, cwd: string) => {
    const text = await readFile(join(cwd, path), "utf8").catch(() => "");
    const original = await readFile(join(repo, path), "utf8");
    const before = original.split("\n");
    const after = text.split("\n");
    const changed =
      Math.abs(after.length - before.length) + after.filter((line, i) => line !== before[i]).length;
    return present.test(text) && changed > 0 && changed <= changedLines;
  };
const tasks: Task[] = [
  {
    name: "peek",
    prompt:
      "Read src/server.rs. When the server peeks at a new TCP connection to decide whether it is an ECH or ACME handshake, what is the time budget and what is the peek buffer cap?",
    check: answerHas(/\b5\s*(s\b|sec)/i, /8\s*(\*\s*1024|KiB|KB|,?192)/i),
  },
  {
    name: "bool",
    prompt:
      "Read src/config.rs. Which literal string values does the plugin option parser accept as boolean false?",
    check: answerHas(/\bno\b/i, /\boff\b/i, /\b0\b/),
  },
  {
    name: "flow",
    prompt:
      "Read src/server.rs. On a server with ECH configured and reject_non_ech on, what does it do with a TCP connection whose ClientHello is not an ECH or ACME handshake? Name the function it calls to do that.",
    check: answerHas(/rst_drop/, /\b(RST|reset|drop)/i),
  },
  {
    name: "edit-budget",
    prompt:
      "In src/server.rs change the ClientHello peek time budget from 5 seconds to 3 seconds. Make no other change.",
    check: fileHas("src/server.rs", /PEEK_BUDGET: Duration = Duration::from_secs\(3\)/, 1),
  },
  {
    name: "edit-bool",
    prompt:
      'In src/config.rs make the plugin option parser also accept the string "disabled" as boolean false. Make no other change.',
    check: fileHas(
      "src/config.rs",
      /Some\([^)]*"off"[^)]*"disabled"[^)]*\)|Some\([^)]*"disabled"[^)]*"off"[^)]*\)/,
      3,
    ),
  },
];

const tracked = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

interface Row {
  repeat: number;
  task: string;
  mode: string;
  correct: boolean;
  requests: number;
  toolCalls: number;
  reads: number;
  rangedReads: number;
  repeatedReads: number;
  focusedResults: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}
const rows: Row[] = [];
await mkdir("results", { recursive: true });

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const [index, task] of tasks.entries()) {
    const offset = (repeat + index) % modes.length;
    for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
      const cwd = await mkdtemp(join(tmpdir(), "pi-jev-read-"));
      try {
        for (const path of tracked) {
          await mkdir(dirname(join(cwd, path)), { recursive: true });
          await cp(join(repo, path), join(cwd, path)).catch(() => {});
        }
        const flags =
          mode === "read"
            ? []
            : ["--jev-tools", "--jev-read", mode === "outline" ? "outline" : "plain"];
        const start = performance.now();
        const execution = run(
          "pi",
          [
            "--no-session",
            "--no-extensions",
            "-e",
            extension,
            ...flags,
            "--tools",
            "read,grep,find,ls,edit",
            "--model",
            model,
            "--thinking",
            "off",
            "--mode",
            "json",
            "-p",
            task.prompt,
          ],
          {
            cwd,
            env: { ...process.env, PI_TELEMETRY: "0" },
            timeout: 180_000,
            maxBuffer: 16_000_000,
          },
        );
        execution.child.stdin?.end();
        const { stdout } = await execution.catch((error: { stdout?: string }) => ({
          stdout: error.stdout ?? "",
        }));
        const row: Row = {
          repeat,
          task: task.name,
          mode,
          correct: false,
          requests: 0,
          toolCalls: 0,
          reads: 0,
          rangedReads: 0,
          repeatedReads: 0,
          focusedResults: 0,
          inputTokens: 0,
          outputTokens: 0,
          elapsedMs: performance.now() - start,
        };
        let answer = "";
        const wholeReads = new Set<string>();
        for (const line of stdout.split("\n")) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const message = event.message as
            | {
                role?: string;
                usage?: Record<string, number>;
                content?: { type: string; text?: string }[];
              }
            | undefined;
          if (event.type === "message_end" && message?.role === "assistant") {
            row.requests++;
            row.inputTokens += (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
            row.outputTokens += message.usage?.output ?? 0;
            const said = (message.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")
              .trim();
            if (said) answer = said;
          }
          if (event.type === "tool_execution_start") {
            row.toolCalls++;
            const args = (event.args ?? {}) as { path?: string; offset?: number; limit?: number };
            if (event.toolName === "read") {
              row.reads++;
              if (args.offset !== undefined || args.limit !== undefined) row.rangedReads++;
              else if (wholeReads.has(String(args.path))) row.repeatedReads++;
              else wholeReads.add(String(args.path));
            }
          }
          if (event.type === "tool_execution_end") {
            const result = event.result as { content?: { text?: string }[] } | undefined;
            const text = (result?.content ?? []).map((part) => part.text ?? "").join("");
            if (/\[jev: (kept|withheld) \d+ of \d+ lines/.test(text)) row.focusedResults++;
          }
        }
        row.correct = await task.check(answer, cwd);
        rows.push(row);
        console.log(
          `${repeat}/${task.name}/${mode}: ${row.correct ? "correct" : "FAILED"} requests ${row.requests} tools ${row.toolCalls} reads ${row.reads} (ranged ${row.rangedReads}, repeated ${row.repeatedReads}) focused ${row.focusedResults} input ${row.inputTokens}`,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
}

const total = (mode: string, field: keyof Row) =>
  rows.filter((row) => row.mode === mode).reduce((sum, row) => sum + Number(row[field]), 0);
const aggregate = Object.fromEntries(
  modes.map((mode) => [
    mode,
    Object.fromEntries(
      (
        [
          "correct",
          "requests",
          "toolCalls",
          "reads",
          "rangedReads",
          "repeatedReads",
          "focusedResults",
          "inputTokens",
          "outputTokens",
        ] as (keyof Row)[]
      ).map((field) => [field, total(mode, field)]),
    ),
  ]),
);
await writeFile(
  "results/read-benchmark.json",
  `${JSON.stringify({ repo, model, repeats, modes, aggregate, rows }, null, 2)}\n`,
);
for (const mode of modes) console.log(mode, JSON.stringify(aggregate[mode]));
