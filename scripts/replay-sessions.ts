import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { focusOutput, readOnlyCommand } from "../src/focus.ts";
import { requestExtensions } from "../src/index.ts";
import { JevClient } from "../src/jev.ts";

/**
 * Session replay: what would output focusing have done to the tool results of real Pi sessions?
 *
 * Reads Pi's session logs (PI_REPLAY_DIR, default ~/.pi/agent/sessions), rebuilds for every text
 * tool result the query the extension would have used (user prompt, the assistant's stated
 * intent, the tool call) and runs it through the real `focusOutput` path and deadline against
 * the configured judgment server. Nothing is written back and no generator runs, so this sizes
 * an opportunity; it cannot show that answers stay correct. Two proxies stand in for that:
 *
 * - carry: bytes saved times the model requests that came later in the session, since a tool
 *   result is sent again with every later request;
 * - retention: of the identifiers the model went on to use (backticked spans and quoted edit
 *   text in its next two messages) that occur in the original result, the share still present
 *   in the focused text.
 *
 * Session contents go to the judgment server: point TYPESAFE_BASE_URL at one you trust.
 * PI_REPLAY_TOOLS (default bash,read,grep,find,ls) and PI_REPLAY_MIN_BYTES (default 4000,
 * the extension's floor) select results; PI_REPLAY_LIMIT caps how many are replayed.
 */

const dir = process.env.PI_REPLAY_DIR ?? join(homedir(), ".pi/agent/sessions");
const tools = new Set((process.env.PI_REPLAY_TOOLS ?? "bash,read,grep,find,ls").split(","));
const minBytes = Number(process.env.PI_REPLAY_MIN_BYTES ?? 4000);
const limit = Number(process.env.PI_REPLAY_LIMIT ?? 1000);

interface Part {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
interface Entry {
  message?: { role?: string; content?: Part[] | string; toolCallId?: string; isError?: boolean };
}
interface Result {
  tool: string;
  input: Record<string, unknown>;
  text: string;
  query: string;
  later: number;
  used: string[];
}

const textOf = (content: Part[] | string | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? part.thinking ?? "").join("\n");

async function sessionFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await sessionFiles(path)));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

function resultsOf(lines: string[]): Result[] {
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Entry];
    } catch {
      return [];
    }
  });
  const requests = entries.filter((entry) => entry.message?.role === "assistant").length;
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results: Result[] = [];
  let request = "";
  let intent = "";
  let seen = 0;
  entries.forEach((entry, index) => {
    const message = entry.message;
    if (!message) return;
    if (message.role === "user") request = textOf(message.content).slice(0, 2000);
    if (message.role === "assistant") {
      seen++;
      const parts = Array.isArray(message.content) ? message.content : [];
      const said = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (said) intent = said.slice(-500);
      for (const part of parts)
        if (part.type === "toolCall" && part.id)
          calls.set(part.id, { name: part.name ?? "", input: part.arguments ?? {} });
    }
    if (message.role !== "toolResult" || message.isError) return;
    const call = calls.get(message.toolCallId ?? "");
    const parts = Array.isArray(message.content) ? message.content : [];
    if (!call || !tools.has(call.name) || parts.length !== 1 || parts[0]?.type !== "text") return;
    const text = parts[0].text ?? "";
    if (Buffer.byteLength(text) < minBytes) return;
    // What the model did next: its next two messages, including the arguments of their calls.
    const next = entries
      .slice(index + 1)
      .filter((later) => later.message?.role === "assistant")
      .slice(0, 2)
      .map((later) => {
        const content = later.message?.content;
        const args = Array.isArray(content)
          ? content.map((part) => JSON.stringify(part.arguments ?? "")).join("\n")
          : "";
        return `${textOf(content)}\n${args}`;
      })
      .join("\n");
    const used = [
      ...new Set([...next.matchAll(/`([^`\n]{4,80})`/g)].map((match) => match[1] as string)),
    ].filter((span) => text.includes(span));
    const label = `${call.name}:${JSON.stringify(call.input)}`.slice(0, 500);
    results.push({
      tool: call.name,
      input: call.input,
      text,
      query: `${request}${intent ? `\nAssistant intent: ${intent}` : ""}\nTool call: ${label}`,
      later: requests - seen,
      used,
    });
  });
  return results;
}

const client = new JevClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL,
  extensions: requestExtensions(process.env.TYPESAFE_REQUEST_EXTENSIONS),
  cooldownMs: 0,
});
if (!client.configured) throw new Error("Set TYPESAFE_BASE_URL or TYPESAFE_API_KEY");
await client.warm();

const all: Result[] = [];
for (const file of await sessionFiles(dir))
  all.push(...resultsOf((await readFile(file, "utf8")).split("\n")));
const selected = all.slice(0, limit);

interface Tally {
  results: number;
  condensed: number;
  withheld: number;
  passed: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
  carryBefore: number;
  carryAfter: number;
  used: number;
  usedKept: number;
  ms: number[];
}
const tallies = new Map<string, Tally>();
for (const result of selected) {
  const tally = tallies.get(result.tool) ?? {
    results: 0,
    condensed: 0,
    withheld: 0,
    passed: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    carryBefore: 0,
    carryAfter: 0,
    used: 0,
    usedKept: 0,
    ms: [],
  };
  tallies.set(result.tool, tally);
  const withhold = result.tool !== "bash" || readOnlyCommand(String(result.input.command ?? ""));
  const { text, withheld, outcome } = await focusOutput(
    client,
    result.query,
    result.text,
    undefined,
    withhold,
  );
  const before = Buffer.byteLength(result.text);
  const after = text ? Buffer.byteLength(text) : before;
  tally.results++;
  if (outcome && !outcome.ok) tally.failed++;
  else if (!text) tally.passed++;
  else if (withheld) tally.withheld++;
  else tally.condensed++;
  if (outcome?.ok) tally.ms.push(outcome.elapsedMs);
  tally.bytesBefore += before;
  tally.bytesAfter += after;
  tally.carryBefore += before * (1 + result.later);
  tally.carryAfter += after * (1 + result.later);
  if (text) {
    tally.used += result.used.length;
    tally.usedKept += result.used.filter((span) => text.includes(span)).length;
  }
}

const percent = (after: number, before: number) =>
  before ? `${Math.round((after / before - 1) * 100)}%` : "n/a";
console.log(`${all.length} results of at least ${minBytes} bytes; replayed ${selected.length}`);
for (const [tool, tally] of tallies) {
  const sorted = [...tally.ms].sort((a, b) => a - b);
  const median = Math.round(sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
  console.log(
    `${tool}: ${tally.results} results, condensed ${tally.condensed}, withheld ${tally.withheld}, passed ${tally.passed}, failed ${tally.failed}; bytes ${tally.bytesBefore} -> ${tally.bytesAfter} (${percent(tally.bytesAfter, tally.bytesBefore)}); carried bytes ${tally.carryBefore} -> ${tally.carryAfter} (${percent(tally.carryAfter, tally.carryBefore)}); identifiers the model used next that survive focusing: ${tally.usedKept}/${tally.used}; judgment ms median ${median}`,
  );
}
