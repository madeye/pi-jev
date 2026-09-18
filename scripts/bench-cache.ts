import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { rankPassages } from "../src/decisions.ts";
import { JevClient } from "../src/jev.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY");
// Isolate cache behavior even when cold TLS exceeds the runtime's 1.5-second budget.
const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, timeoutMs: 5000 });
const passages = [
  { id: "test", text: "Run npm test to execute the test suite." },
  { id: "format", text: "Run npm run format to format source files." },
  { id: "install", text: "Run npm ci to install locked dependencies." },
];
const rows = [];
for (const query of [
  "How do I execute tests?",
  "How do I format source files?",
  "How do I install dependencies?",
]) {
  const first = await rankPassages(client, query, passages);
  const cached = await rankPassages(client, query, passages);
  rows.push({
    query,
    first: first.outcome,
    repeated: cached.outcome,
    samePassages: JSON.stringify(first.passages) === JSON.stringify(cached.passages),
  });
}
await mkdir("results", { recursive: true });
await writeFile(
  "results/cache-benchmark.json",
  `${JSON.stringify({ requestDeadlineMs: 5000, scope: "Hosted request latency versus exact in-memory replay. Does not measure local model generation.", rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    rows.map((row) => ({
      query: row.query,
      firstMs: row.first?.elapsedMs,
      repeatedMs: row.repeated?.elapsedMs,
      cached: row.repeated?.ok && row.repeated.cached,
    })),
  ),
);
assert.ok(
  rows.every((row) => row.first?.ok && row.repeated?.ok && row.repeated.cached && row.samePassages),
  "A hosted request or cache check failed; report retained.",
);
