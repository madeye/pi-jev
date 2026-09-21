import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { rankPassages } from "./decisions.ts";
import type { JevClient, Outcome } from "./jev.ts";

/**
 * Search expansion: a search result that names `path:line:` matches is usually followed by a
 * second call that opens the code around one of them. Jev judges which matches matter for the
 * request, and the lines around those are appended to the search result itself, so the
 * follow-up call and the model request it costs are not needed. Nothing is removed from the
 * output, so a wrong judgment costs a few hundred bytes, never evidence.
 */

const matchLine = /^(?:\.\/)?([^\s:][^:\n]*?):(\d+):(.*)$/;
const searchCommand =
  /^(?:cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*)?(?:rg|grep|egrep|fgrep|git grep|ag)\s/;

export interface Match {
  path: string;
  line: number;
  text: string;
}

/** `path:line:text` matches of a grep-style output; at most one per file and twelve-line window. */
export function parseMatches(output: string): Match[] {
  const matches: Match[] = [];
  for (const raw of output.split("\n")) {
    const found = matchLine.exec(raw);
    if (!found) continue;
    const [, path, line, text] = found as unknown as [string, string, string, string];
    const at = Number(line);
    if (matches.some((m) => m.path === path && Math.abs(m.line - at) <= 12)) continue;
    matches.push({ path, line: at, text: text.trim().slice(0, 200) });
    if (matches.length === 24) break;
  }
  return matches;
}

/** Directory a search ran in, for a bash command that is a single grep-style search; else undefined. */
export function searchDirectory(command: string, cwd: string): string | undefined {
  const trimmed = command.trim();
  if (/[;\n`]|\$\(|>|\|\||&&.*&&/.test(trimmed)) return undefined;
  const found = searchCommand.exec(trimmed);
  if (!found) return undefined;
  // Context flags mean the model already asked for the surrounding lines.
  if (/\s-(?:[A-Za-z]*[ABC]\d*|-(?:context|after-context|before-context))\b/.test(trimmed))
    return undefined;
  const dir = found[1]?.replace(/^["']|["']$/g, "");
  return dir ? resolve(cwd, dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : cwd;
}

export async function expandMatches(
  client: JevClient,
  query: string,
  output: string,
  directory: string,
  signal?: AbortSignal,
  options: { keep?: number; radius?: number; minScore?: number } = {},
): Promise<{ text?: string; expanded?: number; outcome?: Outcome }> {
  const { keep = 3, radius = 10, minScore = 0.6 } = options;
  const matches = parseMatches(output);
  // A single match needs no judgment about which one matters; many files means a survey, not a lookup.
  if (!query.trim() || matches.length < 2) return {};
  const { passages, outcome } = await rankPassages(
    client,
    query,
    matches.map((m, i) => ({ id: `m${i}`, text: `${m.path}:${m.line}: ${m.text}` })),
    signal,
    3000,
  );
  if (!outcome?.ok) return { outcome };
  // One matched line is rarely "direct evidence" on its own, so the bar condensing uses would
  // never be met. Nothing is removed here, so rank decides: the best few matches that are not
  // judged unrelated. (A question asking how useful the surrounding code would be ranked worse.)
  const chosen = passages
    .filter((p) => (p.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, keep)
    .map((p) => matches[Number(p.id.slice(1))] as Match);
  let appended = "";
  let expanded = 0;
  for (const match of chosen) {
    const path = isAbsolute(match.path) ? match.path : resolve(directory, match.path);
    let lines: string[];
    try {
      lines = (await readFile(path, "utf8")).split("\n");
    } catch {
      continue;
    }
    // A stale or mis-parsed match must not inject unrelated text.
    if (!lines[match.line - 1]?.includes(match.text.slice(0, 40))) continue;
    const start = Math.max(1, match.line - radius);
    const end = Math.min(lines.length, match.line + radius * 2);
    const body = lines
      .slice(start - 1, end)
      .map((text, i) => `${start + i}: ${text}`)
      .join("\n")
      .slice(0, 2400);
    appended += `\n--- ${match.path} lines ${start}-${end} ---\n${body}\n`;
    expanded++;
  }
  if (!expanded) return { outcome };
  return {
    text: `${output.replace(/\n+$/, "")}\n\n[jev: the lines around the ${expanded} match${expanded === 1 ? "" : "es"} judged most relevant to the user's request follow, so reading those files again may be unnecessary.]${appended}`,
    expanded,
    outcome,
  };
}
