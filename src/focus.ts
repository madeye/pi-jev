import { isDirectEvidence, rankPassages } from "./decisions.ts";
import type { JevClient, Outcome } from "./jev.ts";
import { chunkLines, words } from "./retrieval.ts";

/** Built-in tools whose large text output may be focused. `read` and edits are never altered. */
export const focusableTools = new Set(["grep", "find", "ls", "bash"]);

/**
 * Condense a large tool output to the excerpts Jev confidently judges as direct evidence.
 * Any uncertainty, failure, or small saving returns no text, leaving the original untouched.
 */
export async function focusOutput(
  client: JevClient,
  query: string,
  text: string,
  signal?: AbortSignal,
  keep = 6,
): Promise<{ text?: string; outcome?: Outcome }> {
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
  if (!direct.length) return { outcome };
  const kept = [...direct.map((passage) => byId.get(passage.id) as typeof last), last].sort(
    (a, b) => a.startLine - b.startLine,
  );
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
  focused += `[jev: kept ${keptLines} of ${lineCount} lines: excerpts judged direct evidence for the user's request, plus the final excerpt. Omitted lines ranked lower. Answer from these excerpts when they suffice; only if evidence is missing, repeat the identical tool call for the complete output.]`;
  return Buffer.byteLength(focused) > bytes * 0.7 ? { outcome } : { text: focused, outcome };
}
