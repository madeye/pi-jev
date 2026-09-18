import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";

// Scoped to Jev requests; never changes Pi's global networking or local model routing.
let dispatcher: EnvHttpProxyAgent | undefined;
// Idle connections outlive a model turn, so a warmed connection is still open for tool results.
const connections = () => {
  dispatcher ??= new EnvHttpProxyAgent({ keepAliveTimeout: 30_000 });
  return dispatcher;
};
const origin = "https://api.typesafe.ai/";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
export interface Evaluation {
  answers: Record<string, Answer>;
  model: string;
  usage: { input_tokens?: number; output_tokens?: number };
}
export type Outcome =
  | { ok: true; result: Evaluation; elapsedMs: number; cached?: boolean }
  | { ok: false; reason: string; elapsedMs: number };

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function validResponse(
  value: unknown,
  questions: Record<string, Question>,
): value is Evaluation {
  if (!isObject(value) || typeof value.model !== "string" || !isObject(value.answers)) return false;
  if (!isObject(value.usage)) return false;
  for (const field of ["input_tokens", "output_tokens"]) {
    const count = value.usage[field];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    )
      return false;
  }
  return Object.entries(questions).every(([id, question]) => {
    const answer = value.answers && (value.answers as Record<string, unknown>)[id];
    if (
      !isObject(answer) ||
      answer.type !== question.type ||
      !probability(answer.confidence) ||
      !isObject(answer.probabilities)
    )
      return false;
    const keys =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (Object.keys(probs).length !== keys.length || !keys.every((key) => probability(probs[key])))
      return false;
    if (
      Math.abs(Object.values(probs).reduce<number>((sum, p) => sum + (p as number), 0) - 1) > 0.02
    )
      return false;
    if (question.type === "choice")
      return typeof answer.choice === "string" && keys.includes(answer.choice);
    return (
      typeof answer.score === "number" &&
      Number.isFinite(answer.score) &&
      answer.score >= 0 &&
      answer.score <= keys.length - 1
    );
  });
}

/** One bounded request, no retries on the agent's critical path. Never logs state or credentials. */
export class JevClient {
  private readonly cache = new Map<string, { result: Evaluation; expires: number }>();
  private consecutiveFailures = 0;
  private cooldownUntil = 0;

  constructor(
    private readonly options: {
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      cacheTtlMs?: number;
      cooldownMs?: number;
      fetch?: typeof fetch;
    } = {},
  ) {}

  /**
   * Open the connection ahead of a likely request so that its deadline is not spent on the
   * TLS handshake. Sends no credentials or state; failures are ignored and never counted.
   */
  async warm(signal?: AbortSignal): Promise<void> {
    if (!this.options.apiKey || performance.now() < this.cooldownUntil) return;
    const timeout = AbortSignal.timeout(3000);
    const request = {
      method: "HEAD",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "manual" as const,
    };
    try {
      const response = this.options.fetch
        ? await this.options.fetch(origin, request)
        : await proxyFetch(origin, { ...request, dispatcher: connections() });
      await response.body?.cancel();
    } catch {
      /* The real request reports its own failure. */
    }
  }

  async evaluate(
    state: unknown,
    questions: Record<string, Question>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Outcome> {
    const start = performance.now();
    const fail = (reason: string): Outcome => ({
      ok: false,
      reason,
      elapsedMs: performance.now() - start,
    });
    if (!this.options.apiKey) return fail("missing-api-key");
    if (signal?.aborted) return fail("cancelled");
    const body = JSON.stringify({ model: this.options.model ?? "jev-1.13.0", state, questions });
    // Conservative byte bound, well below the documented request token limits even for CJK.
    if (Buffer.byteLength(body) > 24_000) return fail("request-too-large");
    const cached = this.cache.get(body);
    if (cached && cached.expires > performance.now()) {
      this.cache.delete(body);
      this.cache.set(body, cached);
      return {
        ok: true,
        result: structuredClone(cached.result),
        elapsedMs: performance.now() - start,
        cached: true,
      };
    }
    this.cache.delete(body);
    if (performance.now() < this.cooldownUntil) return fail("circuit-open");
    const failedRequest = (reason: string): Outcome => {
      if (reason !== "cancelled" && ++this.consecutiveFailures >= 2)
        this.cooldownUntil = performance.now() + (this.options.cooldownMs ?? 30_000);
      return fail(reason);
    };
    const timeout = AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? 1500);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const request = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: combined,
        redirect: "error" as const,
      };
      const response = this.options.fetch
        ? await this.options.fetch("https://api.typesafe.ai/v1/systemone", request)
        : await proxyFetch("https://api.typesafe.ai/v1/systemone", {
            ...request,
            dispatcher: connections(),
          });
      if (!response.ok) {
        await response.body?.cancel();
        return failedRequest(`http-${response.status}`);
      }
      const value: unknown = await response.json();
      if (combined.aborted) return failedRequest(signal?.aborted ? "cancelled" : "timeout");
      if (!validResponse(value, questions)) return failedRequest("invalid-response");
      this.consecutiveFailures = 0;
      this.cooldownUntil = 0;
      const ttl = this.options.cacheTtlMs ?? 60_000;
      if (ttl > 0) {
        this.cache.set(body, { result: structuredClone(value), expires: performance.now() + ttl });
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value as string);
      }
      return { ok: true, result: value, elapsedMs: performance.now() - start };
    } catch {
      return failedRequest(
        signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network-or-json-error",
      );
    }
  }
}
