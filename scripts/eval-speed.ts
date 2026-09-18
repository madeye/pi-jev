import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { JevClient } from "../src/jev.ts";
import { chooseSpeed } from "../src/speed.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY");
const timeoutMs = Number(process.env.JEV_EVAL_TIMEOUT_MS ?? 3000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
  throw new Error("Invalid evaluation deadline");
const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, timeoutMs });
const cases = [
  { prompt: "Extract the npm test command from README.md.", fast: true },
  {
    prompt: "Implement a function sum(a, b) that returns a + b. Export it from sum.js.",
    fast: true,
  },
  {
    prompt: "Rename the heading Setup to Installation in README.md. Leave the body unchanged.",
    fast: true,
  },
  {
    prompt:
      "Investigate the intermittent distributed deadlock and design a robust architecture fix. Think carefully through races and failure modes.",
    fast: false,
  },
  { prompt: "Do the other one instead.", fast: false },
  {
    prompt:
      "Analyze the full repository and propose a migration architecture with compatibility tradeoffs.",
    fast: false,
  },
];
const rows = [];
for (const item of cases)
  rows.push({ ...item, result: await chooseSpeed(client, item.prompt, undefined, timeoutMs) });
await mkdir("results", { recursive: true });
await writeFile(
  `results/speed-routing-live-${timeoutMs}.json`,
  `${JSON.stringify({ timeoutMs, scope: "Six frozen synthetic routing requests; does not measure local inference or task completion latency.", rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    rows.map((row) => ({
      expectedFast: row.fast,
      actualFast: row.result.fast,
      ok: row.result.outcome?.ok,
      elapsedMs: row.result.outcome?.elapsedMs,
    })),
  ),
);
assert.ok(
  rows.every((row) => row.result.outcome?.ok && row.fast === row.result.fast),
  "Routing differed or a request failed; report retained.",
);
