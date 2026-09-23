import type { JevClient, Outcome } from "./jev.ts";

/**
 * `jev_scout` — zero-hallucination package vetting.
 *
 * Before the model installs a dependency, this asks Jev (via the configured
 * `/v1/systemone` endpoint, e.g. OpenRouter or TypeSafe) whether the package,
 * crate, or repository is likely real and appropriate — without the model being
 * able to invent a false positive. Uses a Bool (Noul) question so the caller can
 * threshold on a probability rather than trusting a generated answer.
 */

export interface ScoutRequest {
  type: "npm" | "crate" | "go" | "pip" | "maven" | "repo" | "generic";
  name: string;
  reason?: string;
}

export interface ScoutResult {
  exists: boolean;
  probability: number;
  reason?: string;
  error?: string;
  outcome?: Outcome;
}

export async function scoutPackage(
  client: JevClient,
  request: ScoutRequest,
  signal?: AbortSignal,
  probabilityFloor = 0.7,
): Promise<ScoutResult> {
  const trust = {
    type: "noul" as const,
    instructions:
      `Does the package \`${request.name}\` (${request.type}) very likely exist and is appropriate for this use? ` +
      (request.reason ? `Planned use: ${request.reason}. ` : "") +
      "Say yes only if you are confident it is a real, well-known package; prefer false if it looks invented, hallucinated, or obscure.",
  };

  const outcome = await client.evaluate(
    { name: request.name, type: request.type, reason: request.reason ?? "" },
    { exists: trust },
    signal,
  );

  if (!outcome.ok) return { exists: false, probability: 0, error: outcome.reason, outcome };
  const answer = outcome.result.answers.exists;
  if (!answer || answer.type !== "noul") {
    return { exists: false, probability: 0, error: "unexpected-response", outcome };
  }
  return {
    exists: answer.noul >= probabilityFloor,
    probability: answer.noul,
    outcome,
  };
}
