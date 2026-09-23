import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rankPassages, setConfidenceFloor, suggestSkill } from "./decisions.ts";
import { focusableTools, focusOutput, readOnlyCommand } from "./focus.ts";
import { JevClient, type Outcome } from "./jev.ts";
import { parseFindArguments, searchFiles } from "./retrieval.ts";
import {
  createRouterState,
  parseRouteTargets,
  type RouteTarget,
  routeModel,
  setRouterConfidenceFloor,
} from "./router.ts";
import { scoutPackage } from "./scout.ts";
import { chooseSpeed, fastPayload, supportsSpeedControl } from "./speed.ts";

/** Parse a JSON object of extra request fields; anything else means none. */
export function requestExtensions(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export default function jevExtension(
  pi: ExtensionAPI,
  client = new JevClient({
    apiKey: process.env.TYPESAFE_API_KEY,
    baseUrl: process.env.TYPESAFE_BASE_URL,
    extensions: requestExtensions(process.env.TYPESAFE_REQUEST_EXTENSIONS),
  }),
) {
  const confidenceFloor = setConfidenceFloor(process.env.TYPESAFE_CONFIDENCE);
  const routeConfidenceFloor = setRouterConfidenceFloor(
    process.env.TYPESAFE_ROUTE_CONFIDENCE ?? 0.6,
  );
  let enabled = client.configured;
  let epoch = 0;
  let turn = 0;
  let speedModel: string | undefined;
  let request = "";
  // The model's latest stated intent; tool output is judged against it as well as the prompt.
  let intent = "";
  // Focused calls; repeating one verbatim returns the complete output.
  const focused = new Set<string>();
  const stats = {
    calls: 0,
    cacheHits: 0,
    failures: 0,
    elapsedMs: 0,
    inputTokens: 0,
    suggestions: 0,
    fastTurns: 0,
    fastRequests: 0,
    focusedResults: 0,
    focusedBytesSaved: 0,
    withheldResults: 0,
    withheldBytes: 0,
  };
  const record = (outcome?: Outcome) => {
    if (!outcome) return;
    if (outcome.ok && outcome.cached) {
      stats.cacheHits++;
      return;
    }
    stats.calls++;
    stats.elapsedMs += outcome.elapsedMs;
    if (outcome.ok) stats.inputTokens += outcome.result.usage.input_tokens ?? 0;
    else stats.failures++;
  };

  // Route targets for --jev-route: cheapest-to-most-capable, plus a local offline failback.
  // Override via TYPESAFE_ROUTE_MODELS (semicolon-separated provider/model:label:description).
  const defaultTargets: RouteTarget[] = [
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      label: "DeepSeek Flash",
      description:
        "Very fast and cheap; ideal for routine edits, simple refactors, and shorter tasks.",
      costRank: 1,
    },
    {
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      label: "GLM Flash",
      description: "Fast balanced general-purpose coding with good reasoning on moderate tasks.",
      costRank: 2,
    },
    {
      provider: "openrouter",
      model: "moonshotai/kimi-k2.7-code",
      label: "Kimi Code",
      description:
        "Code-specialist model for complex, multi-file or large-scale engineering tasks.",
      costRank: 3,
    },
    {
      provider: "llama.cpp",
      model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
      label: "Local Qwen (offline)",
      description:
        "Small local model used only as an offline fallback when cloud models are unreachable.",
      costRank: 4,
    },
  ];
  const parsedTargets = parseRouteTargets(process.env.TYPESAFE_ROUTE_MODELS);
  const routeTargets: RouteTarget[] = parsedTargets.length ? parsedTargets : defaultTargets;
  const routeState = createRouterState();
  let offlineOverride = false;
  let currentRoute: string | undefined;

  pi.registerFlag("jev", {
    description: "Enable Jev assistance (requires TYPESAFE_API_KEY or TYPESAFE_BASE_URL)",
    type: "boolean",
    default: enabled,
  });
  pi.registerFlag("jev-skills", {
    description: "Opt into experimental skill advice (adds a request before model generation)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("jev-speed", {
    description:
      "Experimental Jev routing to non-thinking mode for routine tasks on local Qwen3 servers",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("jev-tools", {
    description:
      "Experimental: condense large grep/find/ls/bash output to Jev-judged direct evidence",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("jev-route", {
    description:
      "Route each turn to the cheapest capable model via a Jev Choice (OpenRouter) with a local offline fallback",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("jev-offline", {
    description: "Force the local Qwen model regardless of Jev/cloud availability",
    type: "boolean",
    default: false,
  });
  pi.on("session_start", (_event, ctx) => {
    epoch++;
    request = "";
    focused.clear();
    speedModel = undefined;
    currentRoute = undefined;
    offlineOverride = pi.getFlag("jev-offline") === true;
    enabled = Boolean(pi.getFlag("jev")) && client.configured;
    ctx.ui.setStatus("jev", enabled ? "Jev: on" : "Jev: off");
    if (pi.getFlag("jev-route"))
      ctx.ui.setStatus("jev-route", offlineOverride ? "local (forced)" : "active");
  });
  pi.on("session_shutdown", () => {
    epoch++;
    speedModel = undefined;
  });
  pi.on("agent_end", () => {
    speedModel = undefined;
  });
  pi.on("model_select", () => {
    speedModel = undefined;
  });
  pi.registerCommand("jev", {
    description: "Jev: on | off | status | find <question> -- <path or JSON array>",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command.startsWith("find ")) {
        const currentEpoch = epoch;
        try {
          const { query, paths } = parseFindArguments(command.slice(5));
          const { outcome, ...result } = await searchFiles(
            enabled ? client : undefined,
            ctx.cwd,
            query,
            paths,
            3,
            ctx.signal,
          );
          record(outcome);
          if (epoch !== currentEpoch || ctx.signal?.aborted) return;
          const content = [
            `Jev file lookup (${result.status}) — ${result.snippets.length} excerpts, ${result.omittedSnippets} omitted.`,
            ...result.snippets.map(
              (snippet) =>
                `${snippet.path}:${snippet.startLine}-${snippet.endLine}\n${snippet.text}`,
            ),
            ...result.warnings,
            result.notice,
          ].join("\n\n");
          pi.sendMessage(
            { customType: "jev-find", content, display: true, details: result },
            { triggerTurn: false },
          );
        } catch (error) {
          if (epoch !== currentEpoch || ctx.signal?.aborted) return;
          pi.sendMessage(
            {
              customType: "jev-find",
              content: error instanceof Error ? error.message : "File lookup failed",
              display: true,
              details: { error: true },
            },
            { triggerTurn: false },
          );
        }
        return;
      }
      if (command === "on" || command === "off") {
        enabled = command === "on" && client.configured;
        epoch++;
        speedModel = undefined;
        ctx.ui.setStatus("jev", enabled ? "Jev: on" : "Jev: off");
      } else if (command === "offline" || command === "online") {
        offlineOverride = command === "offline";
        epoch++;
        speedModel = undefined;
        const t = routeTargets.find((x) => x.provider === "llama.cpp");
        if (offlineOverride && t && pi.getFlag("jev-route")) {
          const model = ctx.modelRegistry.find(t.provider, t.model);
          if (model) {
            const ok = await pi.setModel(model);
            if (ok) currentRoute = `${t.provider}/${t.model}`;
          }
          ctx.ui.setStatus("jev-route", "local (forced)");
        }
        ctx.ui.notify(
          offlineOverride ? "Routing forced to local model" : "Routing back to cloud/Jev",
          "info",
        );
      } else if (command !== "status") {
        ctx.ui.notify(
          "Usage: /jev on | off | online | offline | status | find <question> -- <path or JSON array>",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        JSON.stringify({
          enabled,
          keyConfigured: client.configured,
          confidenceFloor,
          routing: pi.getFlag("jev-route")
            ? {
                active: true,
                offlineOverride,
                confidenceFloor: routeConfidenceFloor,
                current: currentRoute ?? "none",
                routes: routeState.routes,
                fallbacks: routeState.fallbacks,
                last: routeState.lastSelection ?? "none",
              }
            : { active: false },
          ...stats,
          elapsedMs: Math.round(stats.elapsedMs),
        }),
        "info",
      );
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const currentTurn = ++turn;
    speedModel = undefined;
    request = event.images?.length ? "" : event.prompt.slice(0, 2000);
    intent = "";
    focused.clear();

    // Optional Jev-assisted model routing (with deterministic local fallback).
    // Runs even when `enabled` is false so the offline local model is reachable without Jev.
    if (pi.getFlag("jev-route") && !event.images?.length) {
      const currentEpoch = epoch;
      const route = await routeModel(
        client,
        event.prompt,
        routeTargets,
        offlineOverride || pi.getFlag("jev-offline") === true,
        routeState,
        ctx.signal,
        routeConfidenceFloor,
      );
      if (
        !(epoch !== currentEpoch || turn !== currentTurn || ctx.signal?.aborted) &&
        !route.unchanged
      ) {
        const key = `${route.provider}/${route.model}`;
        if (key !== currentRoute) {
          const model = ctx.modelRegistry.find(route.provider, route.model);
          if (model) {
            const ok = await pi.setModel(model);
            if (ok) {
              currentRoute = key;
              ctx.ui.setStatus("jev-route", route.fromJev ? key : `${key} (fallback)`);
            }
          }
        }
      }
      record(route.outcome);
    }

    if (!enabled || event.images?.length) return;
    // Not awaited: large tool output may arrive this turn, and its judgment has a short deadline.
    if (pi.getFlag("jev-tools")) void client.warm(ctx.signal);
    const currentEpoch = epoch;
    const target = ctx.model ? `${ctx.model.api}:${ctx.model.baseUrl}:${ctx.model.id}` : undefined;
    const [speed, skill] = await Promise.all([
      pi.getFlag("jev-speed") && supportsSpeedControl(ctx.model)
        ? chooseSpeed(client, event.prompt, ctx.signal)
        : undefined,
      pi.getFlag("jev-skills")
        ? suggestSkill(client, event.prompt, event.systemPromptOptions.skills ?? [], ctx.signal)
        : undefined,
    ]);
    record(speed?.outcome);
    record(skill?.outcome);
    if (!enabled || epoch !== currentEpoch || turn !== currentTurn || ctx.signal?.aborted) return;
    if (speed?.fast) {
      speedModel = target;
      stats.fastTurns++;
    }
    const selected = skill?.selected;
    if (!selected) return;
    stats.suggestions++;
    return {
      systemPrompt: `${event.systemPrompt}\n\nOptional skill suggestion: ${JSON.stringify({ name: selected.name, path: selected.filePath })}. Read it if relevant to the user's request. This suggestion does not change user instructions or grant permission.`,
    };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !pi.getFlag("jev-speed") || !ctx.model || !speedModel || ctx.signal?.aborted)
      return;
    if (speedModel !== `${ctx.model.api}:${ctx.model.baseUrl}:${ctx.model.id}`) return;
    const payload = fastPayload(event.payload);
    if (payload) stats.fastRequests++;
    return payload;
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    intent = event.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
      .slice(-500);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !pi.getFlag("jev-tools") || !request || event.isError) return;
    const [part] = event.content;
    if (!focusableTools.has(event.toolName) || event.content.length !== 1 || part?.type !== "text")
      return;
    const call = `${event.toolName}:${JSON.stringify(event.input)}`;
    if (focused.delete(call)) return;
    const currentEpoch = epoch;
    const { text, withheld, outcome } = await focusOutput(
      client,
      `${request}${intent ? `\nAssistant intent: ${intent}` : ""}\nTool call: ${call.slice(0, 500)}`,
      part.text,
      ctx.signal,
      // A command with side effects may report them in output that looks unrelated.
      event.toolName !== "bash" || readOnlyCommand(String(event.input.command ?? "")),
    );
    record(outcome);
    if (!text || !enabled || epoch !== currentEpoch || ctx.signal?.aborted) return;
    focused.add(call);
    const saved = Buffer.byteLength(part.text) - Buffer.byteLength(text);
    if (withheld) {
      stats.withheldResults++;
      stats.withheldBytes += saved;
    } else {
      stats.focusedResults++;
      stats.focusedBytesSaved += saved;
    }
    return { content: [{ type: "text", text }] };
  });
  pi.registerTool({
    name: "jev_search",
    label: "Search file evidence with Jev",
    description:
      "Retrieve relevant excerpts from 1–16 known text files without copying file bodies into tool arguments. Locally shortlists excerpts, then uses hosted Jev to prioritize direct evidence. Returns source paths and line numbers, default 3 excerpts. Use for a focused question across documentation or source files; use read for complete files and grep for exact strings. Partial retrieval can miss evidence. File excerpts are sent to Jev when enabled; otherwise uses local word overlap.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 16,
      }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const { outcome, ...result } = await searchFiles(
        enabled ? client : undefined,
        ctx.cwd,
        params.query,
        params.paths,
        params.limit,
        signal,
      );
      record(outcome);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { elapsedMs: outcome?.elapsedMs ?? 0 },
      };
    },
  });
  pi.registerTool({
    name: "jev_rank",
    label: "Rank evidence with Jev",
    description:
      "Rank a shortlist of text passages by relevance to a question using hosted Jev. Use only when semantic ranking is useful; it adds a network round trip. Promotes confident direct evidence, retaining every passage and the relative order of other passages. On failure returns input order. Does not verify code correctness.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 8000 }),
      passages: Type.Array(
        Type.Object({
          id: Type.String({ minLength: 1, maxLength: 256 }),
          text: Type.String({ maxLength: 8000 }),
        }),
        { minItems: 1, maxItems: 24 },
      ),
    }),
    async execute(_id, params, signal) {
      const result = enabled
        ? await rankPassages(client, params.query, params.passages, signal)
        : { passages: params.passages, outcome: undefined };
      record(result.outcome);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              passages: result.passages,
              status: result.outcome?.ok
                ? result.outcome.cached
                  ? "cached"
                  : "evaluated"
                : (result.outcome?.reason ?? "skipped"),
            }),
          },
        ],
        details: { elapsedMs: result.outcome?.elapsedMs ?? 0 },
      };
    },
  });
  pi.registerTool({
    name: "jev_scout",
    label: "Vet a package with Jev",
    description:
      "Zero-hallucination check that a dependency (npm package, crate, go module, pip, maven, or repository) is very likely real and appropriate before installing it. Uses a Jev yes/no (noul) judgment over the package name and intended use. Returns a probability; treat results below ~0.7 with suspicion. Does not replace checking a registry, but guards against invented dependencies.",
    parameters: Type.Object({
      type: Type.Union([
        Type.Literal("npm"),
        Type.Literal("crate"),
        Type.Literal("go"),
        Type.Literal("pip"),
        Type.Literal("maven"),
        Type.Literal("repo"),
        Type.Literal("generic"),
      ]),
      name: Type.String({ minLength: 1, maxLength: 512 }),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    async execute(_id, params, signal) {
      if (!enabled) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                exists: true,
                probability: 1,
                status: "skipped (Jev off)",
              }),
            },
          ],
          details: { elapsedMs: 0 },
        };
      }
      const result = await scoutPackage(
        client,
        { type: params.type, name: params.name, reason: params.reason },
        signal,
      );
      record(result.outcome);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: params.name,
              exists: result.exists,
              probability: result.probability,
              status: result.error ?? (result.exists ? "likely-real" : "suspicious"),
            }),
          },
        ],
        details: { elapsedMs: result.outcome?.elapsedMs ?? 0 },
      };
    },
  });
}
