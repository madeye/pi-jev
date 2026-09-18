import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, median, percentile, tokensPerSecond } from "../scripts/bench-stats.ts";

test("median and percentile handle odd, even, and empty inputs", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([], 0.95), undefined);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
});

test("tokens per second rejects missing or non-positive durations", () => {
  assert.equal(tokensPerSecond(100, 1000), 100);
  assert.equal(tokensPerSecond(100, null), undefined);
  assert.equal(tokensPerSecond(100, 0), undefined);
  assert.equal(tokensPerSecond(0, 1000), undefined);
});

test("aggregate separates effective from decode throughput", () => {
  const result = aggregate([
    {
      elapsedMs: 1000,
      toolCalls: 3,
      requests: [
        { input: 4000, output: 200, reasoning: 0, requestMs: 2000, ttftMs: 1000 },
        { input: 1000, output: 100, reasoning: 0, requestMs: 1000, ttftMs: 200 },
      ],
    },
    {
      elapsedMs: 3000,
      toolCalls: 1,
      requests: [{ input: 500, output: 50, reasoning: 0, requestMs: 500, ttftMs: 100 }],
    },
  ]);
  assert.equal(result.runs, 2);
  assert.equal(result.requests, 3);
  assert.equal(result.toolCallsTotal, 4);
  assert.equal(result.toolCallsMedian, 2);
  assert.equal(result.inputTokensTotal, 5500);
  assert.equal(result.inputTokensMedian, 1000);
  assert.equal(result.outputTokensTotal, 350);
  assert.equal(result.effectiveTpsMedian, 100);
  assert.equal(result.decodeTpsMedian, 125);
  assert.equal(result.ttftMsMedian, 200);
  assert.equal(result.elapsedMsMedian, 2000);
});
