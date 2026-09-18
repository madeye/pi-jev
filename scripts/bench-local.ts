import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { suggestSkill } from "../src/decisions.ts";
import { JevClient, type Outcome } from "../src/jev.ts";
import { benchmarkEnvironment } from "./environment.ts";

const run = promisify(execFile);
const model = process.env.PI_BENCH_MODEL ?? "local-qwen/qwen3.8-27b";
const env = benchmarkEnvironment();
const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY });
if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY before benchmarking.");
const skills = [
  {
    name: "pdf",
    description: "Extract text from PDF documents and render PDF pages.",
    filePath: "/example/pdf/SKILL.md",
  },
  {
    name: "rust",
    description: "Implement and debug Rust code and run Cargo checks.",
    filePath: "/example/rust/SKILL.md",
  },
  {
    name: "spreadsheet",
    description: "Create and edit XLSX workbooks with formulas and charts.",
    filePath: "/example/sheets/SKILL.md",
  },
];
const cases = [
  { prompt: "Extract all text from invoice.pdf.", expected: "pdf" },
  { prompt: "Fix the borrow checker error in my Rust function.", expected: "rust" },
  { prompt: "Create an XLSX budget workbook with formulas.", expected: "spreadsheet" },
  { prompt: "Hello!", expected: "none" },
  { prompt: "Do the other one instead.", expected: "none" },
];
const system = `You are evaluating skill selection. Select a skill for the user's request. Return ONLY its name, or none if no skill applies or the request depends on missing history. Do not execute the user's request. Skills: ${JSON.stringify(skills.map(({ name, description }) => ({ name, description })))}`;
interface Event {
  type: string;
  message?: {
    role: string;
    content: { type: string; text?: string }[];
    stopReason?: string;
    usage?: { input: number; output: number };
  };
}
const results: {
  mode: string;
  prompt: string;
  expected: string;
  correct: boolean;
  elapsedMs: number;
  answer?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  jev?: Outcome;
  adviceApplied?: boolean;
}[] = [];
for (const [index, item] of cases.entries()) {
  // Alternate pair order to reduce systematic warm-cache/order bias. Still only a smoke benchmark.
  for (const mode of index % 2 ? ["hybrid", "baseline"] : ["baseline", "hybrid"]) {
    const start = performance.now();
    const decision =
      mode === "hybrid" ? await suggestSkill(client, item.prompt, skills) : undefined;
    const hint = decision?.selected
      ? `\nOptional skill suggestion: ${decision.selected.name}. Use only if relevant.`
      : "";
    try {
      const execution = run(
        "pi",
        [
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--no-tools",
          "--no-session",
          "--model",
          model,
          "--thinking",
          "off",
          "--system-prompt",
          system + hint,
          "--mode",
          "json",
          "-p",
          item.prompt,
        ],
        { timeout: 60_000, maxBuffer: 4_000_000, env },
      );
      // Pi reads piped stdin before starting; send EOF for a prompt-only run.
      execution.child.stdin?.end();
      const { stdout } = await execution;
      const events = stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Event);
      const messages = events
        .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
        .map((e) => e.message);
      const final = messages.at(-1);
      const answer = final?.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim();
      results.push({
        mode,
        prompt: item.prompt,
        expected: item.expected,
        answer,
        correct: answer === item.expected && final?.stopReason !== "error",
        elapsedMs: performance.now() - start,
        inputTokens: messages.reduce((n, m) => n + (m?.usage?.input ?? 0), 0),
        outputTokens: messages.reduce((n, m) => n + (m?.usage?.output ?? 0), 0),
        jev: decision?.outcome,
        adviceApplied: Boolean(decision?.selected),
      });
    } catch {
      results.push({
        mode,
        prompt: item.prompt,
        expected: item.expected,
        correct: false,
        error: "Pi failed or exceeded 60 seconds",
        elapsedMs: performance.now() - start,
      });
    }
    console.log(`${mode}: ${item.expected}: ${results.at(-1)?.correct ? "correct" : "failed"}`);
  }
}
const summary = ["baseline", "hybrid"].map((mode) => {
  const rows = results.filter((r) => r.mode === mode);
  const latencies = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
  return {
    mode,
    correct: rows.filter((r) => r.correct).length,
    total: rows.length,
    medianMs: latencies[Math.floor(latencies.length / 2)],
    totalMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
    outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
    successfulJevRequests: rows.filter((r) => r.jev?.ok).length,
    failedJevRequests: rows.filter((r) => r.jev && !r.jev.ok).length,
    adviceApplied: rows.filter((r) => r.adviceApplied).length,
  };
});
await mkdir("results", { recursive: true });
await writeFile(
  "results/local-benchmark.json",
  `${JSON.stringify({ timestamp: new Date().toISOString(), model, scope: "Five synthetic skill-selection tasks; uses the same Jev decision helper plus a prompt hint, not the full extension hook. Not a coding-quality benchmark or statistical evidence of speedup. Includes process startup and Jev latency. Server generation settings may override requested thinking=off.", summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (results.some((r) => "error" in r)) process.exitCode = 1;
