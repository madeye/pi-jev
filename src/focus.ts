import { confident, isDirectEvidence, type RankedPassage, rankPassages } from "./decisions.ts";
import type { JevClient, Outcome } from "./jev.ts";
import { chunkLines, words } from "./retrieval.ts";

/** Built-in tools whose large text output may be focused. `read` and edits are never altered. */
export const focusableTools = new Set(["grep", "find", "ls", "bash"]);

const readOnly =
  /^(cat|head|tail|less|grep|egrep|fgrep|rg|ag|find|fd|ls|tree|wc|nl|sort|uniq|cut|column|file|stat|du|jq|sed -n|awk|git (log|show|diff|status|grep|ls-files|blame))(\s|$)/;
/** True for shell pipelines that only inspect files, so withholding output hides no side effect. */
export const readOnlyCommand = (command: string) =>
  !/[>`]|\$\(/.test(command) &&
  command.split(/\|\||&&|[|;\n]/).every((part) => readOnly.test(part.trim()));

const confidentlyUnrelated = (p: RankedPassage) =>
  p.score !== undefined && p.score < 0.5 && confident(p.confidence);

/**
 * Condense a large tool output to the excerpts Jev confidently judges as direct evidence.
 * With `withhold`, an output whose every shortlisted excerpt is confidently unrelated is reduced
 * to its first and final excerpts. Any uncertainty, failure, or small saving returns no text,
 * leaving the original untouched.
 */
export async function focusOutput(
  client: JevClient,
  query: string,
  text: string,
  signal?: AbortSignal,
  withhold = false,
  keep = 6,
): Promise<{ text?: string; withheld?: boolean; outcome?: Outcome }> {
  const bytes = Buffer.byteLength(text);
  if (!query.trim() || bytes < 4000) return {};
  const { chunks, lineCount } = chunkLines(text);
  // The final excerpt carries exit summaries and Pi's own truncation notice; always retained.
  const last = chunks.at(-1);
  if (!last || chunks.length <= keep + 1) return {};
  const terms = words(query);
  const scored = chunks.slice(0, -1).map((chunk, i) => {
    const tokens = words(chunk.text);
    return { id: `c${i}`, chunk, overlap: [...terms].filter((term) => tokens.has(term)).length };
  });
  const byId = new Map(scored.map(({ id, chunk }) => [id, chunk]));
  scored.sort((a, b) => b.overlap - a.overlap);
  const { passages, outcome } = await rankPassages(
    client,
    query,
    scored.slice(0, 12).map(({ id, chunk }) => ({ id, text: chunk.text })),
    signal,
    // Replaces a far longer prefill, so it tolerates a cold connection like speed routing does.
    3000,
  );
  if (!outcome?.ok) return { outcome };
  const direct = passages.filter(isDirectEvidence).slice(0, keep);
  const withheld = !direct.length;
  if (withheld && !(withhold && passages.every(confidentlyUnrelated))) return { outcome };
  // A withheld output still shows how it begins, so the model can tell what it skipped.
  const selected = withheld ? [chunks[0] as typeof last] : direct.map((p) => byId.get(p.id));
  const kept = [...(selected as (typeof last)[]), last].sort((a, b) => a.startLine - b.startLine);
  let focused = "";
  let next = 1;
  let keptLines = 0;
  const gap = (until: number) => {
    if (until < next) return;
    if (focused && !focused.endsWith("\n")) focused += "\n";
    focused += `[jev: lines ${next}-${until} omitted]\n`;
  };
  for (const chunk of kept) {
    gap(chunk.startLine - 1);
    focused += chunk.text;
    keptLines += chunk.endLine - chunk.startLine + 1;
    next = chunk.endLine + 1;
  }
  gap(lineCount);
  if (!focused.endsWith("\n")) focused += "\n";
  focused += withheld
    ? `[jev: withheld ${lineCount - keptLines} of ${lineCount} lines: every sampled excerpt was judged unrelated to the user's request. Continue without this output; only if you need it, repeat the identical tool call for the complete output.]`
    : `[jev: kept ${keptLines} of ${lineCount} lines: excerpts judged direct evidence for the user's request, plus the final excerpt. Omitted lines ranked lower. Answer from these excerpts when they suffice; only if evidence is missing, repeat the identical tool call for the complete output.]`;
  return Buffer.byteLength(focused) > bytes * 0.7
    ? { outcome }
    : { text: focused, withheld, outcome };
}
