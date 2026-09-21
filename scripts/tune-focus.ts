import { mkdir, writeFile } from "node:fs/promises";
import { setConfidenceFloor } from "../src/decisions.ts";
import { focusOutput } from "../src/focus.ts";
import { serverOptions } from "../src/index.ts";
import { JevClient } from "../src/jev.ts";
import { bashPrompt, files, relevantFiles, tasks } from "./fixture-policy.ts";

/**
 * Focus tuner: sweeps the judgment server's request extensions and the client's confidence
 * floor over the frozen policy fixture, through the extension's real `focusOutput` path and
 * deadline, with no generator in the loop. Every file of every task is one `cat` output.
 *
 * A decision is ideal when a relevant file is condensed and still carries its current value,
 * or a distractor file is withheld. A relevant file whose current value is lost counts as a
 * failure regardless of bytes saved. Timeouts count as pass-throughs, as they would in use.
 *
 * Targets the default DiffusionGemma server unless TYPESAFE_BASE_URL says otherwise (hosted:
 * https://api.typesafe.ai with TYPESAFE_API_KEY). Grids come from
 * PI_TUNE_FLOORS (comma list, default 0.8,0.7,0.6,0.5) and PI_TUNE_EXTENSIONS (a JSON array
 * of request-extension objects, default below). Reports go to results/tune-focus*.json.
 */

const floors = (process.env.PI_TUNE_FLOORS ?? "0.8,0.7,0.6,0.5")
  .split(",")
  .map(Number)
  .filter((f) => Number.isFinite(f) && f >= 0.5 && f <= 1);
const extensions: Record<string, unknown>[] = process.env.PI_TUNE_EXTENSIONS
  ? (JSON.parse(process.env.PI_TUNE_EXTENSIONS) as Record<string, unknown>[])
  : [{}, { samples: 1 }, { samples: 4 }, { samples: 8 }, { think: 32 }, { think: 96 }];
const label = process.env.PI_TUNE_LABEL ?? "";
const fileNames = Object.keys(files);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : 0;
};

interface Decision {
  task: string;
  file: string;
  relevant: boolean;
  result: "condensed" | "withheld" | "pass";
  reason?: string;
  bytesBefore: number;
  bytesAfter: number;
  factKept: boolean | null;
  archivedKept: boolean | null;
  elapsedMs: number;
}
interface ConfigReport {
  extensions: Record<string, unknown>;
  floor: number;
  decisions: Decision[];
  summary: {
    condensed: number;
    withheld: number;
    pass: number;
    timeouts: number;
    ideal: number;
    factsLost: number;
    bytesBefore: number;
    bytesAfter: number;
    saving: number;
    judgmentMsMedian: number;
    judgmentMsMax: number;
  };
}

const reports: ConfigReport[] = [];
for (const ext of extensions) {
  // One client per extension set: identical bodies within it hit the exact-result cache, so the
  // floor sweep re-decides on the same judgments instead of re-asking the server.
  const client = new JevClient({
    ...serverOptions(),
    extensions: Object.keys(ext).length ? ext : undefined,
    cacheTtlMs: 600_000,
    cooldownMs: 0,
  });
  if (!client.configured)
    throw new Error("TYPESAFE_BASE_URL is empty and no TYPESAFE_API_KEY is set");
  await client.warm();
  for (const floor of floors) {
    setConfidenceFloor(floor);
    const decisions: Decision[] = [];
    for (const task of tasks) {
      const query = `${bashPrompt(task.question, fileNames)}\nTool call: bash:${JSON.stringify({ command: "cat FILE" })}`;
      for (const [file, text] of Object.entries(files)) {
        const current = relevantFiles[task.name]?.[file];
        const start = performance.now();
        const {
          text: focused,
          withheld,
          outcome,
        } = await focusOutput(
          client,
          query.replace("cat FILE", `cat ${file}`),
          text,
          undefined,
          true,
        );
        const elapsedMs = outcome?.ok && outcome.cached ? 0 : performance.now() - start;
        const archived = /FALCON-1|TOKEN-OLD|30 days|100 requests|60 requests/;
        decisions.push({
          task: task.name,
          file,
          relevant: current !== undefined,
          result: focused ? (withheld ? "withheld" : "condensed") : "pass",
          reason: outcome && !outcome.ok ? outcome.reason : undefined,
          bytesBefore: Buffer.byteLength(text),
          bytesAfter: Buffer.byteLength(focused ?? text),
          factKept: current === undefined ? null : (focused ?? text).includes(current),
          archivedKept: current === undefined ? null : archived.test(focused ?? text),
          elapsedMs,
        });
      }
    }
    const timed = decisions.filter((d) => d.elapsedMs > 0).map((d) => d.elapsedMs);
    const bytesBefore = decisions.reduce((sum, d) => sum + d.bytesBefore, 0);
    const bytesAfter = decisions.reduce((sum, d) => sum + d.bytesAfter, 0);
    const summary = {
      condensed: decisions.filter((d) => d.result === "condensed").length,
      withheld: decisions.filter((d) => d.result === "withheld").length,
      pass: decisions.filter((d) => d.result === "pass").length,
      timeouts: decisions.filter((d) => d.reason === "timeout").length,
      ideal: decisions.filter(
        (d) =>
          (d.relevant && d.result === "condensed" && d.factKept) ||
          (!d.relevant && d.result === "withheld"),
      ).length,
      factsLost: decisions.filter((d) => d.relevant && d.factKept === false).length,
      bytesBefore,
      bytesAfter,
      saving: 1 - bytesAfter / bytesBefore,
      judgmentMsMedian: Math.round(median(timed)),
      judgmentMsMax: Math.round(Math.max(0, ...timed)),
    };
    reports.push({ extensions: ext, floor, decisions, summary });
    const s = summary;
    console.log(
      `${JSON.stringify(ext).padEnd(16)} floor ${floor}: condensed ${s.condensed} withheld ${s.withheld} pass ${s.pass} (timeouts ${s.timeouts}), ideal ${s.ideal}/${decisions.length}, facts lost ${s.factsLost}, bytes -${(s.saving * 100).toFixed(0)}%, judgment ms median ${s.judgmentMsMedian} max ${s.judgmentMsMax}`,
    );
  }
}

await mkdir("results", { recursive: true });
const report = {
  baseUrl: serverOptions().baseUrl || "hosted",
  scope:
    "Focus decisions on the frozen policy fixture through the extension's focusOutput path and 3-second deadline, without a generator. Ideal = relevant file condensed with its current value, distractor withheld. Not a coding-quality or end-to-end claim.",
  floors,
  extensions,
  reports,
};
const path = `results/tune-focus${label ? `-${label}` : ""}.json`;
await writeFile(path, JSON.stringify(report, null, 2));
console.log(`report written to ${path}`);
