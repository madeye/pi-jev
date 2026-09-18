/**
 * Pure aggregation helpers for the throughput (TPS) benchmark.
 * Kept separate from the launcher so the math can be unit tested without starting Pi.
 */

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

/** Tokens per second for a token count over a duration in milliseconds. */
export function tokensPerSecond(tokens: number, milliseconds: number | null): number | undefined {
  if (milliseconds === null || milliseconds <= 0 || tokens <= 0) return undefined;
  return tokens / (milliseconds / 1000);
}

/** One assistant provider request: prefill plus decode. */
export interface RequestSample {
  input: number;
  output: number;
  reasoning: number;
  /** Milliseconds from request send to finalized assistant message. */
  requestMs: number | null;
  /** Milliseconds from request send to the first streamed content event. */
  ttftMs: number | null;
}

/** One Pi process, including every provider request it made. */
export interface RunSample {
  elapsedMs: number;
  toolCalls: number;
  requests: RequestSample[];
  /** jev_search calls whose hosted ranking succeeded (evaluated or cached). */
  hostedEvaluated?: number;
  /** jev_search calls that fell back to local ranking. */
  hostedFallback?: number;
}

export interface Aggregate {
  runs: number;
  requests: number;
  toolCallsTotal: number;
  toolCallsMedian: number | undefined;
  hostedEvaluatedTotal: number;
  hostedFallbackTotal: number;
  inputTokensTotal: number;
  inputTokensMedian: number | undefined;
  inputTokensP95: number | undefined;
  outputTokensTotal: number;
  effectiveTpsMedian: number | undefined;
  decodeTpsMedian: number | undefined;
  ttftMsMedian: number | undefined;
  elapsedMsMedian: number | undefined;
}

/**
 * Decode TPS excludes prefill time (ttft) so prompt-length changes do not
 * masquerade as decode speed changes. Effective TPS includes everything.
 */
export function aggregate(runs: readonly RunSample[]): Aggregate {
  const requests = runs.flatMap((run) => run.requests);
  const effective = requests
    .map((request) => tokensPerSecond(request.output, request.requestMs))
    .filter((value): value is number => value !== undefined);
  const decode = requests
    .map((request) =>
      tokensPerSecond(
        request.output,
        request.ttftMs !== null && request.requestMs !== null
          ? request.requestMs - request.ttftMs
          : null,
      ),
    )
    .filter((value): value is number => value !== undefined);
  const ttft = requests
    .map((request) => request.ttftMs)
    .filter((value): value is number => value !== null);
  const inputs = requests.map((request) => request.input);
  return {
    runs: runs.length,
    requests: requests.length,
    toolCallsTotal: runs.reduce((total, run) => total + run.toolCalls, 0),
    toolCallsMedian: median(runs.map((run) => run.toolCalls)),
    hostedEvaluatedTotal: runs.reduce((total, run) => total + (run.hostedEvaluated ?? 0), 0),
    hostedFallbackTotal: runs.reduce((total, run) => total + (run.hostedFallback ?? 0), 0),
    inputTokensTotal: inputs.reduce((total, value) => total + value, 0),
    inputTokensMedian: median(inputs),
    inputTokensP95: percentile(inputs, 0.95),
    outputTokensTotal: requests.reduce((total, request) => total + request.output, 0),
    effectiveTpsMedian: median(effective),
    decodeTpsMedian: median(decode),
    ttftMsMedian: median(ttft),
    elapsedMsMedian: median(runs.map((run) => run.elapsedMs)),
  };
}
