# Validation — 2026-09-18

Environment: macOS on Apple Silicon, Node 25.9.0, installed Pi 0.85.1. Local generator: the existing `local-qwen/qwen3.8-27b` provider entry. Hosted decision model: `jev-1.13.0`. No DeepSeek runtime was tested.

## Automated checks

- `npm run lint`: TypeScript strict checking and Biome passed.
- `npm test`: 42 tests passed, covering the original request/retrieval/cache behavior plus adaptive thinking, explicit parameter preservation, local endpoint selection, turn/model lifecycle, direct command delivery, built-in tool output focusing, and actual Pi-to-HTTP integration against a mock provider.
- `npm pack --dry-run`: extension sources and package metadata included; ignored results and credentials excluded.

## Live hosted checks

`npm run eval:live` completed six successful requests. All five synthetic skill requests selected the expected result (PDF, Rust, spreadsheet, none, none). Evidence ranking put the test-command passage first. Observed Jev request times were approximately 240–950 ms, including networking.

An earlier direct-network attempt timed out on every request at 1.5 seconds. A later six-request live check succeeded with the same deadline. Later benchmark requests still encountered timeouts (below). This is evidence for the local network configuration, not a service latency guarantee.

Raw report: `results/jev-live.json` (retained locally, ignored by Git).

## Actual Pi tool execution

Loaded `src/index.ts` into the installed Pi CLI and used the existing Qwen model, with no built-in tools or external extensions enabled. A synthetic request caused exactly one `jev_rank` call. Jev ranked the tests passage first; Qwen returned `tests`. The complete process took 9.56 seconds, including approximately 660 ms for the ranking request. No tool error occurred.

Raw event stream: `results/pi-smoke.jsonl` (retained locally, ignored by Git). This verifies loading, schema/tool calling, hosted evaluation, tool-result handling, and the final local-model response.

## Small paired local comparison

`npm run bench:local` compared five synthetic skill-selection requests, one run per mode per request, alternating pair order. Both modes used Pi with the same local provider/model and a three-skill catalog. Hybrid mode used the same `suggestSkill` helper and an optional hint; this comparison does not exercise the extension hook itself.

| Measurement | Plain local Qwen | Jev enabled, with fallback |
| --- | ---: | ---: |
| Exact-match skill selections | 5/5 | 5/5 |
| Median end-to-end time | 6.47 s | 4.39 s |
| Total time across five requests | 35.49 s | 22.14 s |
| Reported local-model output tokens | 347 | 383 |
| Successful Jev judgments | — | 2/5 |
| Requests receiving a skill hint | — | 1/5 |

The hybrid median was about 32% lower in this single run, but **this does not establish a speedup or quality improvement attributable to Jev**. Three Jev calls timed out and fell back; one selected `none`; only the Rust request received advice. That advised request actually took 4.39 s versus 3.84 s for its baseline. There were only five easy tasks, no repeats, no controlled server cache state, and no repository changes or correctness tests. Process startup and Jev latency are included; model server generation settings may override the requested thinking level. More output tokens despite lower wall time further cautions against attributing the difference to reduced model work.

Raw report, per-case timing, token usage, and Jev responses: `results/local-benchmark.json` (retained locally, ignored by Git). Larger frozen coding tasks and repeated controlled runs are needed before enabling more invasive optimizations.

## File retrieval through the actual extension

`npm run bench:retrieval` completed 18 Pi runs: three frozen synthetic questions, two repetitions, and three modes with rotated order. Each run loaded the extension; mode-specific tool allowlists selected `read` or `jev_search`. The local-only mode had no Jev key. Questions covered current versus archived policy, an exact release command, and an undocumented secret for which the correct answer was UNKNOWN.

| Measurement | Full-file read | Local retrieval | Jev retrieval |
| --- | ---: | ---: | ---: |
| Correct answers | 6/6 | 6/6 | 6/6 |
| Median end-to-end time | 10.46 s | 14.12 s | 7.70 s |
| Total time | 59.98 s | 76.24 s | 45.11 s |
| Reported input tokens | 13,144 | 13,520 | 13,563 |
| Reported output tokens | 801 | 997 | 1,070 |
| Successful hosted rankings | — | — | 5/6 |

One hosted request timed out and used the local fallback. For the three successful hosted rankings on the two current-policy questions, Jev promoted the current policy above the archived distractor; local retrieval put the archived passage first. All modes still answered correctly. Every retrieval returned three excerpts with source lines and omission counts.

This run demonstrates actual tool integration and better evidence ordering on these examples. The observed Jev median was 26% below full-file reading, but uncontrolled server caching, generation variation, only two repetitions, and increased token counts prevent attributing a reliable speedup to Jev. On a small document, retrieval metadata and the tool schema can cost more input tokens than reading the file. Use this tool for focused questions over larger files, not as a universal replacement for `read`.

Raw report: `results/retrieval-benchmark.json`; all 18 event streams are retained under `results/retrieval-*.jsonl`.

## Coding latency counterexample

`npm run bench:coding` ran two frozen synthetic implementation tasks twice per mode. A separate Node process verified strict input validation, boundary conditions, and current rather than archived policy. All eight implementations passed. This is a correctness guard for latency measurement, not a quality-improvement claim.

| Measurement | Full-file read | Jev retrieval available |
| --- | ---: | ---: |
| Passing implementations | 4/4 | 4/4 |
| Median time to completed implementation | 43.24 s | 57.84 s |
| Reported input tokens | 25,891 | 47,433 |
| Reported output tokens | 4,874 | 5,885 |
| Tool calls | 12 | 18 |

**Jev mode was slower in this experiment.** In one run, Qwen read the full policy, then called retrieval, then tried to read a directory and recovered from that tool error. Adding another tool does not guarantee efficient use. Two of four hosted rankings timed out. This counterexample rules out claiming a general coding speedup; the default does not force retrieval or skill advice. Artifacts, independent assertions, and event streams are retained in `results/coding-benchmark.json` and `results/coding-*`.

## Exact-result replay and outage overhead

The first cache probe used the runtime's 1.5-second deadline; all six attempts timed out. A separate network probe measured about 1.91 seconds just to complete a cold TLS handshake. That failed report is retained as `results/cache-benchmark-timeouts.json`.

To isolate the cache, `npm run bench:cache` explicitly uses a **5-second diagnostic deadline**, leaving the plugin's default at 1.5 seconds. Three hosted judgments took 1663, 764, and 274 ms. Immediate exact replays took 0.028, 0.054, and 0.030 ms and returned identical passages without network calls. This proves elimination of the repeated hosted request, not a local generation speedup. Raw report: `results/cache-benchmark.json`.

The client now uses a 30-second local fallback cooldown after two consecutive service failures. Automated checks verify that the next call makes no network request and that a fresh attempt can recover after expiry. Cancellation does not count as service failure. Skill advice now requires `--jev-skills`, removing its unconditional pre-generation network latency from the default path.

## Larger-document latency and context

`PI_BENCH_PADDING=64 PI_BENCH_REPEATS=2 npm run bench:retrieval` reran the same three questions with 64 irrelevant design notes appended, preserving the policy passages. All 18 answers were correct.

| Measurement | Full-file read | Local retrieval | Jev retrieval |
| --- | ---: | ---: | ---: |
| Median end-to-end time | 7.31 s | 13.09 s | 7.38 s |
| Total time | 52.29 s | 70.17 s | 55.80 s |
| Reported input tokens | 47,461 | 13,490 | 13,514 |
| Reported output tokens | 577 | 925 | 931 |

Jev retrieval reduced reported input tokens by 71.5%, but did **not** reduce median end-to-end time in this run. Two hosted calls timed out. Tool-argument generation, output length, and server variability can outweigh reduced prefill work. The report and events are retained under `results/retrieval-large-*`.

## Throughput (TPS) harness

`npm run bench:tps` adds the missing throughput view. Earlier experiments reported wall time and token totals, but not whether less context or fewer tool calls actually changes generation throughput. The harness runs frozen multi-file policy tasks where each answer needs facts from several large, padded files with archived distractors. The `read` mode reads full files; the `local` and `jev` modes call `jev_search` with every path and limit 9, with `local` using only on-device ranking and `jev` adding the hosted judgment. An observer extension records per-request input/output tokens, time to first token (prefill), and decode time; the report aggregates effective TPS (`output / request wall time`), decode TPS (`output / only decode time`), median and p95 input tokens, tool executions, and end-to-end wall time. Answers are checked against the frozen current values, so speed cannot be bought with a wrong answer. Unlike the coding benchmark, the `jev` mode exposes only `jev_search`, so measured differences belong to retrieval rather than to the model choosing to ignore it.

A full paired run completed on the same machine (`PI_BENCH_MODES=read,local,jev PI_BENCH_REPEATS=2`, local `local-qwen/qwen3.8-27b` generator, hosted `jev-1.13.0`). All 12 answers were correct. Both tasks need three files' worth of current facts among five padded files with archived distractors.

| Measurement (2 tasks, 2 repetitions) | Full-file `read` | Local `jev_search` | Hosted `jev_search` |
| --- | ---: | ---: | ---: |
| Tool executions | 20 | 8 | 9 |
| Median input tokens | 8,613 | 1,371 | 1,349 |
| p95 input tokens | 16,333 | 3,105 | 3,204 |
| Median effective TPS | 17.33 tok/s | 31.34 tok/s | 26.02 tok/s |
| Median decode TPS | 37.79 tok/s | 40.23 tok/s | 33.74 tok/s |
| Median TTFT (prefill) | 7,452 ms | 1,415 ms | 2,416 ms |
| Median end-to-end wall time | 27.7 s | 15.0 s | 22.2 s |
| Hosted rankings succeeded | — | 0/8 (local only) | 4/9 |

Retrieval cut the median prefill context by ~84% and the tool executions by more than half, and effective TPS roughly doubled (`read` 17.33 → `local` 31.34 tok/s). Decode TPS stayed roughly flat (33.7–40.2), consistent with the mechanism: less context shortens prefill (TTFT 7.5 s → 1.4 s), not decode. This is direct evidence for the context-compression hypothesis.

Hosted Jev did **not** add a throughput win in this network environment. It succeeded on only 4 of 9 `jev_search` calls; the other 5 hit the plugin's 1.5-second deadline and fell back to local ranking (one run had all three calls time out, another had two). Because the first hosted call also pays connection setup, its median TTFT (2,416 ms) and effective TPS (26.02) landed between `local` and `read`. The hosted ranking itself did improve ordering in the runs where it returned, and every answer stayed correct. One caveat keeps this from being a verdict on Jev: the 1.5-second deadline is tight for a cold TLS handshake on this network. A benchmark with warm connections or a larger deadline would be needed to separate Jev's ranking value from its network cost.

The aggregate is written to `results/tps-benchmark.json` (ignored by Git). `PI_BENCH_SPEED=1` for adaptive non-thinking routing remains outstanding. Because these are single-machine runs with uncontrolled server cache state, read them as evidence for or against the hypothesis, not as a stable speedup estimate.

## Built-in tool output focusing (`--jev-tools`)

`PI_BENCH_MODES=bash,focus npm run bench:tps` compares identical prompts and the same single `bash` tool on the throughput fixture; only `--jev-tools` differs. The model is told to `cat` one file per call, so every result is a ~15 KB output of which two lines matter or none do. The local Qwen server was unreachable, so both runs used the hosted `opencode-go/deepseek-v4.1-flash` generator, with two repetitions and rotated order. All 16 answers were correct.

| Measurement (2 tasks, 2 repetitions) | Run 1 `bash` | Run 1 `focus` | Run 2 `bash` | Run 2 `focus` |
| --- | ---: | ---: | ---: | ---: |
| Tool executions | 20 | 26 | 21 | 20 |
| Results focused | — | 10/26 | — | 11/20 |
| Total input tokens | 62,732 | 45,165 | 62,807 | 32,890 |
| p95 input tokens | 14,750 | 9,127 | 14,717 | 9,181 |
| Median end-to-end wall time | 10.6 s | 15.3 s | 8.2 s | 12.3 s |

Run 1 exposed a design flaw: its closing notice read "Partial output; repeat the identical tool call to receive it complete", and the model used that escape hatch for **every** focused result, re-reading all relevant files in full. Run 2 uses the current wording ("Answer from these excerpts when they suffice; only if evidence is missing, repeat…"); no focused call was repeated and input tokens fell 48%. A first attempt with retrieval's 1.5-second deadline focused only 2 of 11 results, because five parallel cold requests timed out and opened the cooldown; focusing now uses the 3-second deadline of speed routing.

**Wall time got worse in both runs.** Against a fast hosted generator, prefill of 15 KB is cheap, while each focused result waits on a hosted judgment and the smaller context did not remove a model round trip. Two further limits were visible: outputs from files irrelevant to the question pass through complete, because "no confident direct evidence" is deliberately not treated as "confidently irrelevant"; and the sample is four runs per arm on a shared hosted endpoint with large variance (4.9–28.2 s for the same baseline task). Whether the token saving becomes a time saving on a prefill-bound local model is **unmeasured**. The flag stays opt-in and experimental. Reports: `results/tps-focus-v1-benchmark.json`, `results/tps-focus-v2-benchmark.json`.

### Withholding unrelated output

`--jev-tools` now has a third outcome from the same hosted request: when **every** shortlisted excerpt scores below 0.5 with confidence ≥ 0.8, the output is reduced to its first and final excerpts plus a notice. For `bash` this applies only to inspection pipelines (`cat`, `grep`, `git log`, …; no redirects or substitutions). The judgment query also carries the model's latest stated intent, and a non-blocking `HEAD` warm-up opens the Jev connection at turn start.

Same paired benchmark, hosted `opencode-go/deepseek-v4.1-flash` generator, three repetitions, all 12 answers correct (`results/tps-withhold-v2-benchmark.json`):

| Measurement (2 tasks, 3 repetitions) | `bash` | `focus` |
| --- | ---: | ---: |
| Tool executions | 30 | 34 |
| Results condensed / withheld / unchanged | — | 12 / 9 / 13 |
| Total input tokens | 93,932 | 42,027 (−55%) |
| Median input tokens per request | 7,821 | 925 |
| Median end-to-end wall time | 9.6 s | 13.6 s |

In the three runs where every Jev call returned, a run used 1,734–2,178 input tokens against 15,635–15,686 for the baseline (**−86% to −89%**): relevant files were condensed to about 570 bytes and unrelated files withheld. The overall figure is lower because two runs had all five parallel Jev calls hit the 3-second deadline, passing everything through and adding the wait, and in one run the model repeated three calls to get complete output. An earlier run before the warm-up (`results/tps-withhold-v1-benchmark.json`) lost three of four runs the same way; a direct probe confirmed the network path to Jev alternates between ~0.7 s responses and stretches where every request times out. **Wall time was again worse**, for the same reasons as above plus those timeouts. The token saving is real when Jev is reachable; the latency cost is unresolved, and a prefill-bound local model remains unmeasured.

### Hosted Jev reachability, reruns of 2026-09-19

Two reruns of the same paired benchmark, same code, differed only in whether the hosted service answered. With 22 of 30 calls hitting the 3-second deadline (`results/tps-withhold-v3-benchmark.json`) the run saved 26% of input tokens; with 33 of 39 answered (`results/tps-withhold-v4-benchmark.json`) it saved 79%, with a median TTFT below the baseline for the first time (1,303 ms vs 1,851 ms). Direct probes of the endpoint between the runs showed TLS handshakes of 1.1 s, 4.9 s, 7.6 s and one outright timeout. The network path, not the ranking, decides the outcome.

### Self-hosted DiffusionGemma as the judgment server

To take the network out, [vllm-project/vllm#57250](https://github.com/vllm-project/vllm/pull/57250) was deployed on the LAN DGX Spark (GB10): its structured-read patch overlaid on the arm64 nightly image at commit `a8d1aa9c` (eight commits past the PR's merge base, none touching the patched files), `nvidia/diffusiongemma-26B-A4B-it-NVFP4` with a 32-row canvas next to the running Qwen engine, and the PR's example interposer serving the Jev `/v1/systemone` contract on port 8011. The client reaches it through `TYPESAFE_BASE_URL`; on this Mac that has to be an SSH tunnel to loopback because macOS local-network privacy blocks Homebrew Node, Python and curl from the Spark's ports while Apple's own binaries connect. The interposer maps the extension's existing choice and score questions to single-letter slots itself, and its responses pass the client's validator unchanged.

Same paired benchmark, hosted `opencode-go/deepseek-v4.1-flash` generator, three repetitions, all answers correct:

| Measurement (2 tasks, 3 repetitions) | `bash` | `focus`, cold server (`tps-dgemma-v1`) | `focus`, warm server (`tps-dgemma-v2`) | `focus`, hosted Jev v4 |
| --- | ---: | ---: | ---: | ---: |
| Tool executions | 30 | 31 | 32 | 39 |
| Results condensed / withheld / unchanged | — | 4 / 13 / 14 | 5 / 12 / 15 | 18 / 15 / 6 |
| Total input tokens | 93,915–94,006 | 46,670 (−50%) | 52,372 (−44%) | 17,612 (−79%) |
| Median end-to-end wall time | 5.6–6.5 s | 8.0 s | 8.9 s | 9.2 s |
| Judgment latency (interposer log) | — | 7.7–7.9 s first batch, then 0.4–1.7 s | median ~0.7 s | 0.4–1.1 s when answered, else timeout |

**Latency is solved; decisiveness is not.** Once warm, every judgment returned well inside the 3-second deadline: no timeouts in the warm run, against 6 to 22 per run for the hosted service. The cold first batch took 7.8 s because Triton JIT-compiled the logprob kernels on first inference (`_fill_logprob_token_ids_kernel`, `_topk_log_softmax_kernel`), a one-time cost per engine process that `warm.sh` on the Spark now pays at start-up. But the local model condensed far fewer results (5 versus 18) and passed 15 through unchanged, so the token saving was 44% against 79%.

A direct probe with the extension's exact ranking question explains the gap. On five hand-picked passages for the rate-limits query, the current public-limit passage scored 1.99 at confidence 0.99 and the padding note 0.05 at 0.96, both decisive. But the archived-limit passage landed at 0.76 confidence on "unrelated", just under the 0.8 withhold bar, and the internal-limit passage, which answers the second half of the question, was split 0.31 / 0.46 / 0.23 across the three levels. The interposer reports the top label's probability as `confidence`, a different quantity from the hosted service's calibrated estimate, and the thresholds in `src/decisions.ts` and `src/focus.ts` (0.8 confidence, score 1.5 for direct evidence, score below 0.5 to withhold) were tuned on the hosted signal. Whether re-tuning them for this model, or the interposer's `samples`/`think` options, closes the gap is unmeasured. Multi-part questions are a weak spot worth a dedicated case.

Deployment notes: the engine holds ~24 GB beside Qwen's 55 GB, leaving about 4 GB of unused host RAM on the 121 GB unified box; the first start failed inside the NVIDIA driver with `NV_ERR_NO_MEMORY` until the page cache left by the 19 GB download was dropped. The interposer is an example script with no authentication, published only on the LAN. The PR is unmerged, so the overlay pins one revision. Reports: `results/tps-dgemma-v1-benchmark.json`, `results/tps-dgemma-v2-benchmark.json`.

## Direct lookup: measured speed path

`npm run bench:direct` reused the exact large-document fixture and questions for six fresh Pi processes calling `/jev find`. All six returned the expected source evidence, with **zero assistant messages and zero agent-start events**. Median time including Pi startup was **0.892 s** (range 0.863–2.252 s); five Jev calls succeeded and one timed out into local fallback.

For comparison, the model-based read and retrieval workflows above took about 7.3 s median. The direct command returns source excerpts rather than a generated answer, so this is a faster evidence-lookup workflow, not an equivalent-output generation benchmark. It makes no claim about general coding speed. These direct runs followed the prior experiment rather than being interleaved.

Raw results: `results/direct-benchmark.json` and `results/direct-*.jsonl`. Verified savings are currently limited to direct lookup and repeated hosted-request overhead. A reliable speedup for model-driven agent tasks remains unproven, so the broader speed goal remains active. Quality improvement is outside the narrowed goal; correctness assertions remain regression checks.

## Adaptive thinking: implementation and outstanding runtime check

Retained Pi events revealed substantial thinking output despite `--thinking off`: one retry-policy run reported 1,599 reasoning tokens out of 2,338 output tokens. The configured model advertises `reasoning: false` to Pi, which does not itself establish that the server disables thinking. The Qwen model card documents `chat_template_kwargs.enable_thinking=false` for compatible Chat Completions servers.

The opt-in `--jev-speed` implementation asks Jev whether the current request is a bounded routine task. Only a confident `fast` choice applies that template parameter. Unsupported endpoints, explicit existing reasoning controls, uncertainty, service failure, cancellation, images, and stale turn/model decisions leave the payload unchanged. Model completion and switching clear the selection. This feature remains experimental.

The integration test launches the installed Pi CLI against an actual local HTTP listener, with a mocked Jev judgment. It verifies an unchanged baseline request and `enable_thinking=false` in the adaptive request, while messages stay identical. Both requests succeed. This proves the Pi transport, not inference speed.

Six live routing judgments matched their frozen expected choices with a 5-second diagnostic deadline (238–2267 ms). The production routing deadline is now 3 seconds, separate from retrieval's 1.5 seconds. At that deadline, five requests succeeded with the expected choices and the first timed out, preserving baseline behavior. Reports: `results/speed-routing-live-5000.json` and `results/speed-routing-live-3000.json`. The earlier 1.5-second attempt timed out twice and opened the cooldown; it remains in `results/speed-routing-live.json`.

The next inference experiment is prepared as `PI_BENCH_SPEED=1 npm run bench:coding`. It uses the same frozen tasks, identical prompts and tools across modes, independent implementation assertions, observed provider template switches, and reasoning-token counts. **It has not been completed against Qwen.**
