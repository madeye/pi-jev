/**
 * Frozen multi-file policy fixture shared by the throughput benchmark and the focus tuner.
 * Each task needs facts spread across several large, padded files with archived distractors.
 */
export const tasks = [
  {
    name: "incident-policy",
    question:
      "What is the current emergency access code, the current production deployment approval token, and the current audit-log retention period?",
    required: ["EAGLE-7", "TOKEN-MINT", "400"],
  },
  {
    name: "rate-limits",
    question:
      "What are the current public API rate limit and the current internal service rate limit?",
    required: ["250", "900"],
  },
];

const padding = (topic: string) =>
  Array.from(
    { length: 60 },
    (_, index) =>
      `# ${topic} operational note ${index + 1}\nThe ${topic} dashboard summarizes health metrics for shard ${index + 1}. Operators review latency, queue depth, error budgets, and host availability. This note does not define any policy value and is unrelated to the question.`,
  ).join("\n\n");

export const files: Record<string, string> = {
  "security.md": `# Emergency access history\nBefore this revision, the emergency access code was FALCON-1. That code is retired and must not be used.\n\n# Current emergency access\nThe current emergency access code is EAGLE-7. Rotate it after every incident.\n\n${padding("security")}`,
  "deploy.md": `# Deployment approval history\nThe archived deployment approval token was TOKEN-OLD. It no longer authorizes production deploys.\n\n# Current deployment approval\nProduction deploys require the current approval token TOKEN-MINT.\n\n${padding("deploy")}`,
  "retention.md": `# Retention history\nAn earlier policy retained audit logs for 30 days. That policy is archived.\n\n# Current retention\nThe current policy retains audit logs for 400 days.\n\n${padding("retention")}`,
  "api.md": `# Public API limit history\nThe archived public API limit was 100 requests per minute.\n\n# Current public API limit\nThe current public API rate limit is 250 requests per minute.\n\n${padding("api")}`,
  "internal.md": `# Internal limit history\nThe archived internal service limit was 60 requests per minute.\n\n# Current internal rate limit\nInternal service calls are limited to 900 requests per minute.\n\n${padding("internal")}`,
};

/** Which file answers which task, for scoring decisions without a generator in the loop. */
export const relevantFiles: Record<string, Record<string, string>> = {
  "incident-policy": { "security.md": "EAGLE-7", "deploy.md": "TOKEN-MINT", "retention.md": "400" },
  "rate-limits": { "api.md": "250", "internal.md": "900" },
};

/** The `bash` mode prompt of the throughput benchmark, verbatim. */
export const bashPrompt = (question: string, fileNames: string[]) =>
  `Files in the current directory: ${fileNames.join(", ")}. Use bash to cat one file per call, gather current policy evidence, and answer this question: ${question} Rely only on current, non-archived values. Finish with a single line beginning "ANSWER:" that lists the requested values.`;
