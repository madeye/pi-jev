import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { rankPassages } from "./decisions.ts";
import type { JevClient } from "./jev.ts";

interface Snippet {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

const stopwords = new Set(
  "a an the is are for to of in on and or what which how does where".split(" "),
);
export const words = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => !stopwords.has(w)));

/** Split text into excerpts of at most 12 lines and 800 bytes, breaking at blank lines. */
export function chunkLines(text: string) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: { startLine: number; endLine: number; text: string }[] = [];
  let chunk = "";
  let start = 1;
  let end = 0;
  let skipped = 0;
  const flush = () => {
    if (chunk.trim()) chunks.push({ startLine: start, endLine: end, text: chunk });
    chunk = "";
  };
  for (const [i, line] of lines.entries()) {
    if (Buffer.byteLength(line) > 800) {
      flush();
      skipped++;
      continue;
    }
    if (Buffer.byteLength(chunk + line) > 800 || i + 1 - start >= 12) flush();
    if (!chunk) start = i + 1;
    chunk += line;
    end = i + 1;
    if (!line.trim()) flush();
  }
  flush();
  return { chunks, skipped, lineCount: lines.length };
}

export function parseFindArguments(args: string): { query: string; paths: string[] } {
  const separator = args.lastIndexOf(" -- ");
  if (separator < 1)
    throw new Error("Usage: /jev find <question> -- <path or JSON array of paths>");
  const query = args.slice(0, separator).trim();
  const source = args.slice(separator + 4).trim();
  let paths: unknown;
  try {
    paths = source.startsWith("[") ? JSON.parse(source) : [source];
  } catch {
    throw new Error("Paths must be a file path or JSON array of file paths.");
  }
  if (
    !query ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 16 ||
    !paths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 4096)
  )
    throw new Error("Provide a question and 1–16 nonempty file paths.");
  return { query, paths };
}

/** Read only explicitly supplied files; shortlist locally before any hosted request. */
export async function searchFiles(
  client: JevClient | undefined,
  cwd: string,
  query: string,
  paths: string[],
  limit = 3,
  signal?: AbortSignal,
) {
  if (!query.trim() || query.length > 2000 || paths.length < 1 || paths.length > 16)
    throw new Error("Provide a question of 1–2000 characters and 1–16 file paths.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 12)
    throw new Error("limit must be an integer from 1 to 12.");
  const snippets: Snippet[] = [];
  const warnings: string[] = [];
  for (const path of new Set(paths)) {
    signal?.throwIfAborted();
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // NONBLOCK prevents a supplied FIFO from hanging the agent before fstat.
      file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256_000) {
        warnings.push(`${path}: skipped; requires a regular text file of at most 256 KB`);
        continue;
      }
      const buffer = Buffer.alloc(256_001);
      let size = 0;
      while (size < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 256_000) {
        warnings.push(`${path}: skipped; grew beyond 256 KB`);
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
      if (text.includes("\0")) throw new Error("binary");
      const { chunks, skipped } = chunkLines(text);
      for (const chunk of chunks) snippets.push({ id: `c${snippets.length}`, path, ...chunk });
      if (skipped)
        warnings.push(`${path}: ${skipped} lines over 800 bytes were not indexed; use read`);
    } catch {
      signal?.throwIfAborted();
      warnings.push(`${path}: unreadable or not UTF-8 text`);
    } finally {
      await file?.close();
    }
  }
  signal?.throwIfAborted();
  const terms = words(query);
  const scored = snippets.map((snippet) => {
    const tokens = words(snippet.text);
    return { snippet, overlap: [...terms].filter((term) => tokens.has(term)).length };
  });
  scored.sort((a, b) => b.overlap - a.overlap);
  const shortlist = scored.slice(0, 12).map(({ snippet }) => snippet);
  // IDs carry source mapping locally; private file paths are not sent to Jev.
  const decision =
    client && shortlist.length > 1
      ? await rankPassages(
          client,
          query,
          shortlist.map(({ id, text }) => ({ id, text })),
          signal,
        )
      : undefined;
  signal?.throwIfAborted();
  const ordering = decision?.passages ?? shortlist;
  const byId = new Map(shortlist.map((snippet) => [snippet.id, snippet]));
  const outcome = decision?.outcome;
  return {
    snippets: ordering.slice(0, limit).map((passage) => byId.get(passage.id) as Snippet),
    status: outcome?.ok
      ? outcome.cached
        ? "cached"
        : "evaluated"
      : (outcome?.reason ?? "local-only"),
    indexedSnippets: snippets.length,
    shortlistedSnippets: shortlist.length,
    omittedSnippets: snippets.length - Math.min(limit, shortlist.length),
    warnings,
    notice:
      "Partial retrieval, not an exhaustive search. Read source files to verify context; refine paths/query if evidence is missing.",
    outcome: decision?.outcome,
  };
}
