import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { rankPassages, suggestSkill } from "../src/decisions.ts";
import { JevClient } from "../src/jev.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("Set TYPESAFE_API_KEY to run the live API smoke evaluation.");
const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY });
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
  { prompt: "Extract all the text from invoice.pdf.", expected: "pdf" },
  { prompt: "Fix the borrow checker error in my Rust function.", expected: "rust" },
  { prompt: "Build an XLSX budget workbook with SUM formulas.", expected: "spreadsheet" },
  { prompt: "Hello!", expected: undefined },
  { prompt: "Do the other one instead.", expected: undefined },
];
const results = [];
for (const item of cases) {
  const decision = await suggestSkill(client, item.prompt, skills);
  results.push({
    ...item,
    actual: decision.selected?.name,
    correct: Boolean(decision.outcome?.ok) && decision.selected?.name === item.expected,
    outcome: decision.outcome,
  });
}
const ranking = await rankPassages(client, "What command runs the tests?", [
  { id: "license", text: "This project uses the MIT license." },
  { id: "tests", text: "Run npm test to execute the project's test suite." },
  { id: "format", text: "Run npm run format to format source files." },
]);
const report = {
  timestamp: new Date().toISOString(),
  scope:
    "Synthetic live Jev API smoke evaluation. Not a local-model speed or coding-quality benchmark.",
  results,
  ranking,
};
await mkdir("results", { recursive: true });
await writeFile("results/jev-live.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    skillCorrect: results.filter((r) => r.correct).length,
    skillTotal: results.length,
    successfulRequests: results.filter((r) => r.outcome?.ok).length + Number(ranking.outcome?.ok),
    rankingOrder: ranking.passages.map((p) => p.id),
    report: "results/jev-live.json",
  }),
);
assert.ok(
  results.every((r) => r.outcome?.ok),
  "Some live requests failed; inspect the report.",
);
assert.ok(ranking.outcome?.ok, "Live ranking request failed.");
