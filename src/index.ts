import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rankPassages, suggestSkill } from "./decisions.ts";
import { focusableTools, focusOutput } from "./focus.ts";
import { JevClient, type Outcome } from "./jev.ts";
import { parseFindArguments, searchFiles } from "./retrieval.ts";
import { chooseSpeed, fastPayload, supportsSpeedControl } from "./speed.ts";

export default function jevExtension(
  pi: ExtensionAPI,
  client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY }),
) {
  let enabled = Boolean(process.env.TYPESAFE_API_KEY);
  let epoch = 0;
  let turn = 0;
  let speedModel: string | undefined;
  let request = "";
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
  pi.registerFlag("jev", {
    description: "Enable hosted Jev assistance (requires TYPESAFE_API_KEY)",
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
  pi.on("session_start", (_event, ctx) => {
    epoch++;
    request = "";
    focused.clear();
    speedModel = undefined;
    enabled = Boolean(pi.getFlag("jev")) && Boolean(process.env.TYPESAFE_API_KEY);
    ctx.ui.setStatus("jev", enabled ? "Jev: on" : "Jev: off");
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
        enabled = command === "on" && Boolean(process.env.TYPESAFE_API_KEY);
        epoch++;
        speedModel = undefined;
        ctx.ui.setStatus("jev", enabled ? "Jev: on" : "Jev: off");
      } else if (command !== "status") {
        ctx.ui.notify(
          "Usage: /jev on | off | status | find <question> -- <path or JSON array>",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        JSON.stringify({
          enabled,
          keyConfigured: Boolean(process.env.TYPESAFE_API_KEY),
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
    focused.clear();
    if (!enabled || event.images?.length) return;
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
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !pi.getFlag("jev-tools") || !request || event.isError) return;
    const [part] = event.content;
    if (!focusableTools.has(event.toolName) || event.content.length !== 1 || part?.type !== "text")
      return;
    const call = `${event.toolName}:${JSON.stringify(event.input)}`;
    if (focused.delete(call)) return;
    const currentEpoch = epoch;
    const { text, outcome } = await focusOutput(
      client,
      `${request}\nTool call: ${call.slice(0, 500)}`,
      part.text,
      ctx.signal,
    );
    record(outcome);
    if (!text || !enabled || epoch !== currentEpoch || ctx.signal?.aborted) return;
    focused.add(call);
    stats.focusedResults++;
    stats.focusedBytesSaved += Buffer.byteLength(part.text) - Buffer.byteLength(text);
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
}
