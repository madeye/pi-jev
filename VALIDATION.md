# Validation

Measurements taken 2026-09-18 and 2026-09-19. Every claim below cites a retained report under `results/` (ignored by Git). Negative results are kept.

Environment: macOS on Apple Silicon, Node 25.9.0, installed Pi 0.85.1. Generators: the local `local-qwen/qwen3.8-27b` provider entry (a vLLM server on a DGX Spark) and the hosted `opencode-go/deepseek-v4.1-flash`. Judgment servers: hosted `jev-1.13.0`, and from 2026-09-19 a self-hosted DiffusionGemma structured-read server on the same Spark.

## Summary

- **Context compression works and is the one measured mechanism.** Retrieval and output focusing cut the context the generator prefills by 70–90% on the frozen fixtures, with every answer still correct. Decode throughput is unchanged; only prefill shrinks.
- **End-to-end wall time is not yet better** for model-driven tasks against a fast hosted generator: each judgment adds a round trip, and a shorter prefill did not remove a model turn. A prefill-bound local generator remains unmeasured for `--jev-tools`.
- **The hosted service's network path decided its results here.** The same code saved 26% or 79% of input tokens on the same day depending only on whether hosted Jev answered within the deadline.
- **Adopted configuration:** the self-hosted DiffusionGemma server (`TYPESAFE_BASE_URL`) with single-sample reads (`TYPESAFE_REQUEST_EXTENSIONS='{"samples":1}'`) and the default 0.8 confidence floor. It saves 76–78% of input tokens with no timeouts, level with hosted Jev's best run. Details in [Judgment server](#judgment-server-hosted-jev-and-self-hosted-diffusiongemma).
- **Rejected:** jeff (GLiFormer), which produced no usable judgment on this task; lowering the confidence floor to 0.7; the interposer's `think` and `steps` extensions, which crash the engine.
- Open items are listed at the [end](#open-items).

## Automated checks

- `npm run lint`: TypeScript strict checking and Biome passed.
- `npm test`: 45 tests passed, covering the original request/retrieval/cache behavior plus adaptive thinking, explicit parameter preservation, local endpoint selection, turn/model lifecycle, direct command delivery, built-in tool output focusing, actual Pi-to-HTTP integration against a mock provider, and the self-hosted server options (base URL, request extensions, confidence floor).
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

The aggregate is written to `results/tps-benchmark.json` (ignored by Git). Because these are single-machine runs with uncontrolled server cache state, read them as evidence for or against the hypothesis, not as a stable speedup estimate.

## Built-in tool output focusing (`--jev-tools`)

The paired `bash`/`focus` benchmark used from here on: `PI_BENCH_MODES=bash,focus npm run bench:tps`, hosted `opencode-go/deepseek-v4.1-flash` generator, rotated order, answers checked against the frozen current values. The fixture has five files of about 15 KB each; `incident-policy` needs one fact from each of three files with two distractors, `rate-limits` one fact from each of two files with three distractors, and every file carries an archived value next to the current one.

It compares identical prompts and the same single `bash` tool; only `--jev-tools` differs. The model is told to `cat` one file per call, so every result is a ~15 KB output of which two lines matter or none do. The local Qwen server was unreachable from this Mac at the time (the cause, macOS local-network privacy, is recorded under the self-hosted server below), so both runs used the hosted generator, with two repetitions. All 16 answers were correct.

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

## Judgment server: hosted Jev and self-hosted DiffusionGemma

### Hosted reachability decides the hosted result

Two reruns of the withholding benchmark on 2026-09-19, same code, three repetitions each, differed only in whether the hosted service answered within the 3-second deadline. With 22 of 30 calls timing out (`results/tps-withhold-v3-benchmark.json`) the run saved 26% of input tokens; with 33 of 39 answered (`results/tps-withhold-v4-benchmark.json`) it saved 79%, with a median TTFT below the baseline for the first time (1,303 ms against 1,851 ms). Direct probes of `api.typesafe.ai` between the runs showed TLS handshakes of 1.1 s, 4.9 s and 7.6 s and one outright timeout. The network path, not the ranking, decides the hosted outcome from this network. That is the motivation for a server on the LAN.

### Self-hosted DiffusionGemma

[vllm-project/vllm#57250](https://github.com/vllm-project/vllm/pull/57250) adds structured reads to DiffusionGemma: a seeded canvas, one denoise step, and logprobs at the answer slots give a probability distribution per question. Its example interposer speaks the Jev `/v1/systemone` contract. Deployment on the DGX Spark (GB10, 121 GB unified memory): the PR's Python-only diff overlaid on the arm64 nightly image at commit `a8d1aa9c` (eight commits past the PR's merge base, none touching the patched files); `nvidia/diffusiongemma-26B-A4B-it-NVFP4` with a 32-row canvas, about 24 GB beside the running Qwen engine's 55 GB; the interposer on port 8011 without authentication, LAN only. A 12-passage request splits into two reads on that canvas. The interposer maps the extension's choice and score questions to single-letter slots itself, and its responses pass the client's validator unchanged, so the extension needed only `TYPESAFE_BASE_URL`.

Practical findings from bringing it up, each of which cost a restart:

- macOS local-network privacy blocks Homebrew Node, Python and curl from the Spark's ports (`EHOSTUNREACH`) while Apple's own `ssh` and `curl` connect. On this Mac the client reaches the server through an SSH tunnel to loopback. This also explains the "local Qwen server unreachable" note above.
- The first engine start failed inside the NVIDIA driver (`NV_ERR_NO_MEMORY`, then `cudaErrorMemoryAllocation` before vLLM measured anything) with 7 GB of unused host RAM and 47 GB of page cache left by the 19 GB download. Dropping the page cache fixed it. About 4 GB of host RAM is unused with both engines loaded.
- The first judgment after an engine start takes about 8 s while Triton JIT-compiles the logprob kernels, beyond the extension's 3-second deadline. A warm-up request at start-up pays that once.
- The interposer reports the top label's probability as `confidence`, not the hosted service's calibrated estimate.

First results, same paired benchmark, three repetitions, all answers correct:

| Measurement (2 tasks, 3 repetitions) | `bash` | `focus`, cold engine (`tps-dgemma-v1`) | `focus`, warm engine (`tps-dgemma-v2`) | `focus`, hosted Jev v4 |
| --- | ---: | ---: | ---: | ---: |
| Tool executions | 30 | 31 | 32 | 39 |
| Results condensed / withheld / unchanged | — | 4 / 13 / 14 | 5 / 12 / 15 | 18 / 15 / 6 |
| Total input tokens | 93,915–94,006 | 46,670 (−50%) | 52,372 (−44%) | 17,612 (−79%) |
| Median end-to-end wall time | 5.6–6.5 s | 8.0 s | 8.9 s | 9.2 s |
| Judgment latency (interposer log) | — | 7.7–7.9 s first batch, then 0.4–1.7 s | median ~0.7 s | 0.4–1.1 s when answered, else timeout |

Latency was solved at once: warm, no judgment missed the deadline, against 6 to 22 timeouts per hosted run. Decisiveness was not: the model condensed 5 results where hosted Jev condensed 18 and passed 15 through unchanged, so the saving was 44% against 79%. A probe with the extension's exact ranking question showed why. On five hand-picked passages for the rate-limits query, the current public-limit passage scored 1.99 at confidence 0.99 and a padding note 0.05 at 0.96, both decisive; but the archived-limit passage landed at 0.76 confidence on "unrelated", under the 0.8 withhold bar, and the internal-limit passage, which answers the second half of the question, was split 0.31 / 0.46 / 0.23 across the three levels.

### Token and context saving, paired runs

The axis that matters for this extension is how much generator context a judgment server removes, so this isolates it. Each `focus` run is paired with the `bash` baseline run of the same task and repetition; hosted Jev is its good-network run (`tps-withhold-v4`), DiffusionGemma is shown before tuning (`tps-dgemma-v2`) and after (`tps-dgemma-v3`, single-sample reads, next section). All 36 answers were correct.

**Input tokens per run** (all requests in the run, the cumulative context the generator prefilled; where two baselines are shown, they belong to the hosted and the DiffusionGemma runs respectively, and in hosted rate-limits 1 the baseline model itself read fewer files):

| Task, repetition | `bash` baseline | Hosted Jev | saving | DiffusionGemma, untuned | saving | DiffusionGemma, tuned | saving |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| incident-policy 0 | 15,649 | 2,116 | −86% | 10,084 | −36% | 1,710 | −89% |
| incident-policy 1 | 15,653 / 15,610 | 2,213 | −86% | 10,094 | −35% | 4,487 | −71% |
| incident-policy 2 | 15,649 / 15,647 | 2,143 | −86% | 10,056 | −36% | 1,740 | −89% |
| rate-limits 0 | 15,675 / 15,709 | 1,698 | −89% | 4,467 | −72% | 3,052 | −80% |
| rate-limits 1 | 6,881 / 15,633 | 1,717 | −75% | 13,101 | −16% | 4,470 | −71% |
| rate-limits 2 | 15,633 / 15,758 | 7,725 | −51% | 4,570 | −71% | 4,934 | −69% |
| **Total** | **85,140 / 94,006** | **17,612** | **−79%** | **52,372** | **−44%** | **20,393** | **−78%** |

**Context per generator request:**

| | `bash` baseline | Hosted Jev | DiffusionGemma, untuned | DiffusionGemma, tuned |
| --- | ---: | ---: | ---: | ---: |
| Median input tokens per request | 5,884–7,821 | 790 | 933 | 926 |
| p95 input tokens per request | 14,717–14,741 | 3,054 | 11,949 | 3,575 |
| Tool results condensed / withheld / passed through | — | 18 / 15 / 6 | 5 / 12 / 15 | 12 / 15 / 5 |
| Output tokens, total | 1,748–2,111 | 3,027 | 2,602 | 2,637 |

When a judgment is confident, both servers produce the same shape of saving: a relevant 15 KB file collapses to about 570 bytes of excerpt and an unrelated one to a two-line notice, and a run that judged every file that way used 1,700–2,200 input tokens against 15,600 (−86% to −89%) with either server. The difference is how often that happens; every pass-through costs the full file, which is why the untuned p95 request context stayed near the baseline. Untuned, the gap sat on the three-fact task: 35–36% saved against hosted Jev's 86%, with three of five files passed through in every run, because the withhold rule needs every shortlisted excerpt confidently unrelated and the condense rule needs confident direct evidence, so one uncertain distractor or one hedged partial answer sends the whole file through. `focus` raises output tokens over the baseline with either server (notices, re-reads after a withheld result) by 900–1,300 tokens per six runs.

### Tuning: single-sample reads close the gap; a lower floor does not

`npm run tune:focus` (`scripts/tune-focus.ts`) sweeps the server's request extensions (`TYPESAFE_REQUEST_EXTENSIONS`) and the client's confidence floor (`TYPESAFE_CONFIDENCE`) over the same fixture through the extension's real `focusOutput` path and 3-second deadline, with no generator in the loop: each of the five files, for each task, is one `cat` output, ten decisions per configuration. A decision is ideal when a relevant file is condensed and still carries its current value or a distractor is withheld; a relevant file that loses its current value is a failure whatever the byte saving. Reports: `results/tune-focus-dgemma*.json`.

**Server-side sweep, floor 0.8** (first pass on a freshly warmed engine, then three repeats after an engine restart):

| Request extension | Ideal decisions of 10 | Condensed / withheld / passed | Bytes saved | Judgment ms, median / max |
| --- | ---: | ---: | ---: | ---: |
| default (`samples: "auto"`, re-read when uncertain, up to 4 draws) | 8, then 8 / 8 / 8 | 3 / 5 / 2 | −76% | 430–510 / 670–1,130 |
| `samples: 1` | 10, then 8 / 8 / 8 | 5 / 5 / 0, then 3 / 5 / 2 | −96%, then −76% | 195–350 / 265–1,470 |
| `samples: 4` | 8 | 3 / 5 / 2 | −77% | 336 / 405 |
| `samples: 8` | 7 | 2 / 5 / 3 | −67% | 416 / 647 |
| `think: 32` or `96`, `steps: 2` | 0 | — | 0% | crashed the engine |

Every configuration withheld all five distractors and lost no fact. Averaging over more noise draws makes the model *less* decisive: the mean pulls the top probability down, so a passage a single read scores 1.9 at 0.95 confidence lands at 1.3 at 0.65 after four draws, under both bars. A single read is also two to four times faster. `think` and `steps`, which go through the engine's generation path, killed the engine core every time with `Index put requires the source and destination dtypes match, got Float for the destination and BFloat16 for the source` in the diffusion sampler; they are unusable on this build. The one decision that stays imperfect with a single read is the passage answering only part of a multi-part question, scored around 1.3–1.6 at 0.65–0.77 confidence.

**Client-side floor, with `samples: 1`, three repeats:** 0.8 gave 8 of 10 ideal each time; 0.7 and 0.6 gave 9 of 10 each time, catching that partial-answer passage, and never lost a fact or kept an archived value.

**End-to-end confirmation**, same paired benchmark, three repetitions per run, all answers correct in every run:

| Configuration | Report | Input tokens vs baseline | Per-run saving | p95 request context | `focus` tool calls | Condensed / withheld / passed | `focus` output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| default reads, floor 0.8 | `tps-dgemma-v2` | −44% | 16–72% | 11,949 | 32 | 4 / 11 / 17 | 2,602 |
| `samples: 1`, floor 0.8 | `tps-dgemma-v3` | **−78%** | 69–89% | 3,575 | 32 | 12 / 15 / 5 | 2,637 |
| `samples: 1`, floor 0.8, repeat | `tps-dgemma-v3b` | **−76%** | 67–87% | 3,592 | 34 | 11 / 15 / 8 | 3,304 |
| `samples: 1`, floor 0.7 | `tps-dgemma-v4` | −56% | −3–89% | 8,909 | 40 | 15 / 15 / 10 | 3,435 |
| `samples: 1`, floor 0.7, repeat | `tps-dgemma-v4b` | −73% | 34–89% | 3,574 | 37 | 16 / 12 / 9 | 3,780 |
| hosted Jev, good network (reference) | `tps-withhold-v4` | −79% | 51–89% | 3,054 | 39 | 18 / 15 / 6 | 3,027 |

Single-sample reads take the self-hosted server from −44% to −76/−78%, level with hosted Jev's best run, and its median TTFT fell below the baseline in both runs (1,301 and 1,315 ms against 1,841 and 1,461 ms). The 0.7 floor did not carry over: it condensed more results (15–16 against 11–12) but the generator repeated more calls to get complete output (37–40 tool calls against 32–34) and wrote more, and one run of six saved nothing, so the totals were lower and noisier. The harness's extra ideal decision is real but small; the end-to-end cost of a marginal condensation the generator then re-requests outweighs it. The floor stays at 0.8.

**Adopted:** `TYPESAFE_REQUEST_EXTENSIONS='{"samples":1}'`, `TYPESAFE_CONFIDENCE` unset. Limits: two benchmark runs per configuration on a shared hosted generator whose own variance spans 67–89% per run with identical settings; the fixture has one partial-answer case and no adversarial passages; the `samples` field is specific to this interposer; the PR is unmerged, so the overlay pins one revision.

### jeff (GLiFormer): negative result

[logan-markewich/jeff](https://github.com/logan-markewich/jeff) wraps the 400M-parameter GLiFormer encoder in the same wire format. Run on this Mac's MPS with the pinned model name added to its aliases (`results/tps-jeff-v1-benchmark.json`), it produced 0 usable judgments out of 28: only four requests completed at all, because the extension's real payloads (twelve passages from a 15 KB file) queued past the 3-second deadline, so every result passed through and the saving was zero. Speed aside, the judgments were noise for this task. With the extension's exact batched question on five hand-picked passages, the passage holding the direct answer scored lowest (0.41) and the archived value highest (0.73), every confidence between 0.07 and 0.20; one passage per request with plain-text state still scored the answer 0.67 at confidence 0.20 and preferred the archived passage. This matches its author's benchmarks, where it trails jev most on reading comprehension (BoolQ 0.75 against 0.95 AUROC). It is built for flat classification of short text, not for ranking passages against a question.

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

## Open items

- **Wall time.** Every `--jev-tools` configuration, hosted or self-hosted, still finishes later than the `bash` baseline against the fast hosted generator: a judgment per tool result adds a round trip, and the shorter prefill has not removed a model turn. Whether the token saving becomes a time saving on a prefill-bound local generator is unmeasured for focusing; the `read`/`local`/`jev` throughput run above is the only local-generator evidence and it favoured retrieval.
- **Adaptive thinking on a local generator.** `PI_BENCH_SPEED=1 npm run bench:coding` and `PI_BENCH_SPEED=1 npm run bench:tps` are prepared and have not been completed against Qwen.
- **Multi-part questions.** A passage answering only part of a question is the one decision the tuned self-hosted server still passes through; the fixture has a single such case and no adversarial passages.
- **Self-hosted server maintenance.** The vLLM PR is unmerged and the overlay pins one revision; the interposer is an example script without authentication; the Spark runs both engines with about 4 GB of host RAM to spare.
- **Generator variance.** Two or three repetitions per configuration on a shared hosted endpoint, whose per-run saving spans 67–89% with identical settings. Read every table as evidence, not as a stable estimate.
