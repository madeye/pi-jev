import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JevClient } from "../src/jev.ts";
import { parseFindArguments, searchFiles } from "../src/retrieval.ts";

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-test-"));
  try {
    await writeFile(
      join(cwd, "guide.md"),
      "# Retry background\r\n\r\nNetwork failures must immediately return cached data.\r\n\r\nRetry settings belong to the legacy client.\r\n",
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("direct lookup parses paths with spaces and explicit multi-file arrays", () => {
  assert.deepEqual(parseFindArguments("How to test? -- docs/Build guide.md"), {
    query: "How to test?",
    paths: ["docs/Build guide.md"],
  });
  assert.deepEqual(parseFindArguments('How to test? -- ["a.md", "b.md"]'), {
    query: "How to test?",
    paths: ["a.md", "b.md"],
  });
  for (const args of [
    "no separator",
    "query -- ",
    "query -- []",
    "query -- [1]",
    "query -- [broken",
  ])
    assert.throws(() => parseFindArguments(args));
});

test("file retrieval sends bounded text, maps ranked IDs to exact source lines and discloses omissions", async () => {
  await fixture(async (cwd) => {
    let calls = 0;
    const client = new JevClient({
      apiKey: "test",
      fetch: async (_url, options) => {
        calls++;
        const body = JSON.parse(String(options?.body));
        assert.ok(Buffer.byteLength(String(options?.body)) <= 24_000);
        assert.equal(String(options?.body).includes(cwd), false);
        assert.equal(String(options?.body).includes("guide.md"), false);
        const answers = Object.fromEntries(
          body.state.passages.map((p: { text: string }, i: number) => {
            const direct = p.text.includes("cached data");
            return [
              `p${i}`,
              {
                type: "score",
                score: direct ? 2 : 0,
                confidence: 0.99,
                probabilities: { "0": direct ? 0 : 1, "1": 0, "2": direct ? 1 : 0 },
              },
            ];
          }),
        );
        return Response.json({ model: "jev-1.13.0", usage: {}, answers });
      },
    });
    const result = await searchFiles(client, cwd, "retry", ["guide.md"], 1);
    assert.equal(calls, 1);
    assert.equal(result.status, "evaluated");
    assert.equal(result.snippets[0]?.startLine, 3);
    assert.equal(result.snippets[0]?.endLine, 4);
    assert.equal(
      result.snippets[0]?.text,
      "Network failures must immediately return cached data.\r\n\r\n",
    );
    assert.equal(result.omittedSnippets, 2);
  });
});

test("offline and hosted failure retain identical local ranking", async () => {
  await fixture(async (cwd) => {
    const local = await searchFiles(undefined, cwd, "legacy client", ["guide.md"]);
    const failed = await searchFiles(
      new JevClient({ apiKey: "test", fetch: async () => new Response("", { status: 503 }) }),
      cwd,
      "legacy client",
      ["guide.md"],
    );
    assert.equal(local.snippets[0]?.startLine, 5);
    assert.deepEqual(failed.snippets, local.snippets);
    assert.equal(failed.status, "http-503");
  });
});

test("unreadable, binary, oversized and long-line inputs have explicit coverage warnings", async () => {
  await fixture(async (cwd) => {
    await writeFile(join(cwd, "binary"), Buffer.from([0, 1]));
    await writeFile(join(cwd, "huge"), "a".repeat(256_001));
    await writeFile(join(cwd, "long"), `${"a".repeat(801)}\nfind me\n`);
    const result = await searchFiles(undefined, cwd, "find me", [
      "missing",
      "binary",
      "huge",
      "long",
      ".",
    ]);
    assert.equal(result.warnings.length, 5);
    assert.equal(result.snippets[0]?.text, "find me\n");
    assert.equal(result.snippets[0]?.startLine, 2);
  });
});

test("retrieval is bounded, de-duplicates paths and honors cancellation", async () => {
  await fixture(async (cwd) => {
    await writeFile(
      join(cwd, "many"),
      Array.from({ length: 100 }, (_, i) => `Record ${i}\n\n`).join(""),
    );
    const result = await searchFiles(undefined, cwd, "Record", ["many", "many"], 2);
    assert.equal(result.indexedSnippets, 100);
    assert.equal(result.shortlistedSnippets, 12);
    assert.equal(result.snippets.length, 2);
    assert.equal(result.omittedSnippets, 98);
    await assert.rejects(searchFiles(undefined, cwd, "q", ["many"], 1, AbortSignal.abort()));
    await assert.rejects(searchFiles(undefined, cwd, "q", ["many"], 0));
  });
});
