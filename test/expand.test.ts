import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandMatches, parseMatches, searchDirectory } from "../src/expand.ts";
import { JevClient } from "../src/jev.ts";

/** Scores the match whose text contains `marker` highest; the rest as unrelated. */
const scoringClient = (marker: string, calls = { count: 0 }) =>
  new JevClient({
    apiKey: "test-only",
    fetch: async (_url, options) => {
      calls.count++;
      const body = JSON.parse(String(options?.body));
      const answers = Object.fromEntries(
        (body.state.passages as { text: string }[]).map((passage, i) => {
          const hit = passage.text.includes(marker);
          return [
            `p${i}`,
            {
              type: "score",
              score: hit ? 0.9 : 0.1,
              confidence: hit ? 0.45 : 0.9,
              probabilities: hit ? { 0: 0.3, 1: 0.5, 2: 0.2 } : { 0: 0.9, 1: 0.1, 2: 0 },
            },
          ];
        }),
      );
      return Response.json({ model: "jev-1.13.0", answers, usage: {} });
    },
  });

test("parses path:line matches, one per nearby window, and ignores other lines", () => {
  const matches = parseMatches(
    "./src/a.ts:10:const x = 1;\nsrc/a.ts:14:const y = 2;\nsrc/a.ts:90:  retry();\nBinary file b matches\nsrc/b.rs:7:fn main() {}\n",
  );
  assert.deepEqual(
    matches.map((m) => `${m.path}:${m.line}`),
    ["src/a.ts:10", "src/a.ts:90", "src/b.rs:7"],
  );
});

test("only a single grep-style search without context flags names a search directory", () => {
  assert.equal(searchDirectory("rg -n retry src | head -50", "/repo"), "/repo");
  assert.equal(searchDirectory("cd /other && grep -rn retry .", "/repo"), "/other");
  assert.equal(searchDirectory("cd sub && git grep -n retry", "/repo"), "/repo/sub");
  for (const command of [
    "rg -n -A30 retry src",
    "grep -rn -C 3 retry .",
    "rg -n retry src; cat src/a.ts",
    "ls -la && rg -n retry && echo done",
    "cat src/a.ts",
    "rg -n retry src > out.txt",
  ])
    assert.equal(searchDirectory(command, "/repo"), undefined, command);
});

test("appends the lines around the best-ranked match and removes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-expand-"));
  try {
    const source = Array.from({ length: 60 }, (_, i) =>
      i === 29 ? "const retryDelayMs = 250;" : `// filler ${i + 1}`,
    ).join("\n");
    await writeFile(join(dir, "net.ts"), source);
    await writeFile(join(dir, "other.ts"), "// retry is mentioned here\n");
    const output = "net.ts:30:const retryDelayMs = 250;\nother.ts:1:// retry is mentioned here\n";
    const calls = { count: 0 };
    const result = await expandMatches(
      scoringClient("retryDelayMs", calls),
      "retry delay?",
      output,
      dir,
    );
    assert.equal(calls.count, 1);
    assert.equal(result.expanded, 1);
    assert.ok(result.text?.startsWith(output.trimEnd()));
    assert.match(result.text ?? "", /--- net\.ts lines 20-50 ---/);
    assert.match(result.text ?? "", /30: const retryDelayMs = 250;/);
    assert.doesNotMatch(result.text ?? "", /--- other\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a single match, a failed judgment, or a stale match leaves the output alone", async () => {
  const none = new JevClient({ apiKey: "k", fetch: async () => assert.fail("unexpected call") });
  assert.deepEqual(await expandMatches(none, "q", "a.ts:1:only one\n", "/nowhere"), {});
  const failing = new JevClient({
    apiKey: "k",
    fetch: async () => new Response(null, { status: 500 }),
  });
  const failed = await expandMatches(failing, "q", "a.ts:1:x marker\nb.ts:2:y\n", "/nowhere");
  assert.equal(failed.text, undefined);
  assert.equal(failed.outcome?.ok, false);
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-expand-"));
  try {
    await writeFile(join(dir, "a.ts"), "the file changed since the search\n");
    const stale = await expandMatches(
      scoringClient("marker"),
      "q",
      "a.ts:1:x marker\nb.ts:2:y\n",
      dir,
    );
    assert.equal(stale.text, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
