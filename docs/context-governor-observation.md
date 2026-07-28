# Context Governor real-telemetry observation

## Decision

**Gate B is not satisfied; keep the downstream gate closed.** Do not enable adaptive limits, Phase 2 caps, or Phase 4 decay from this evidence.

The telemetry is small, private, structurally valid, and the hidden advisory did not persist. However, first-settle growth is usually the entire resident context, the small-sample P95 preserves that warm-up outlier, post-compaction sessions remain Red at 5.6–7.8% context occupancy, and there is no model-switch, resume, or true branch evidence. The resulting runway forecast substantially overpredicts the next observed growth.

## Scope and method

Snapshot cutoff: **2026-07-28 21:41:43 UTC**. Telemetry records ranged from 18:15:29 to 21:40:19 UTC on that date.

- Parsed metrics-only records under `/Users/syndg/.pi/agent/context-governor/telemetry`.
- Mapped each telemetry session ID to its session JSONL and extracted only structural metadata: record types, roles, model IDs, usage totals, tool names, parent/child shape, compaction metadata, and exact custom-message identity. Message text, tool arguments, tool-result content, summaries, credentials, and raw content bodies were not reported.
- Audited all **592** session JSONL files for the exact advisory identity without loading unmatched bodies.
- “Next observed growth” means the next telemetry record in the same writer file with an incremented growth sample count. Only one file supplied such a sequence.

The directory was active while observed, so this is a timestamped snapshot rather than an immutable corpus.

## Corpus and overhead

| Measure | Result |
|---|---:|
| Distinct telemetry session IDs | 46 |
| Telemetry writer files | 46 |
| Telemetry records | 51 |
| Records per file | 45 files × 1; 1 file × 6 |
| PID-scoped files | 38: PID `47171` × 34; PID `23008` × 4 |
| Legacy unsuffixed files | 8 |
| Session IDs spanning multiple writer files | 0 |
| Logical telemetry size | 45,930 B (44.9 KiB) |
| Allocated telemetry size | 192,512 B (188 KiB) |
| Average logical bytes/session | 998.5 B |
| Relevant session JSONL size | 34,990,721 B logical; 37,289,984 B allocated |
| Telemetry/session ratio | 0.131% logical; 0.516% allocated |
| File mode | 46/46 were `0600` |
| Malformed telemetry records | 0/51 |
| Malformed relevant session records | 0/4,711 |

The largest observed writer file had six records and was about 5.1 KiB, far below the configured 200-record/512-KiB bounds. Disk overhead is low. CPU latency and atomic-rewrite cost were not instrumented, so runtime overhead is not validated.

## Models, windows, measurements, and budgets

All 51 records used one combination:

- provider/model: `openai-codex` / `gpt-5.6-sol`
- context window: **272,000 tokens**
- native limit: **255,616** (`reserve-tokens`)
- advisory limit: **190,400** (70% of the window)
- effective safe limit: **190,400** (`minimum-of-governor-and-native`)

Measurement provenance:

| Source | Records | Cross-check |
|---|---:|---|
| `pi-usage` | 48 | 48/48 exactly equaled the nearest preceding assistant `usage.totalTokens` in session metadata |
| `message-estimate` | 3 | All were immediate post-compaction estimates; no same-state post-compaction `pi-usage` record exists |

Thus `pi-usage` is internally consistent with persisted provider-usage metadata, but Gate B’s provider-usage-versus-resident-estimate comparison remains unsupported: the only estimates occur after compaction and have no paired observed measurement.

Across all records, measured tokens ranged **5,481–249,237** (median **154,302**); signed headroom ranged **−58,837 to 184,919** (median **36,098**).

## Growth, EWMA, P95, and runway

### Warm-up contamination

Of 43 first-sample records with non-null `latestTokens`:

- **42/43** reported latest growth exactly equal to the entire post-run measurement;
- the remaining record reported measurement +2,730 tokens.

This indicates an absent/effectively zero first-run baseline, not a useful before/after run delta. It also folds fixed prompt/schema/session reconstruction into “run growth.” Forty-five files contain only one record, so they cannot independently validate a next run.

Recorded distributions:

| Metric | Non-null | Min | Median | Max |
|---|---:|---:|---:|---:|
| latest growth | 48 | 106 | 138,773.5 | 249,237 |
| EWMA | 51 | 5,481 | 154,302 | 277,645 |
| P95 | 51 | 5,481 | 154,302 | 277,645 |
| conservative growth | 51 | 5,481 | 154,302 | 277,645 |
| runway (runs) | 51 | −0.236 | 0.244 | 33.738 |

Only one session accumulated more than one sample (sample counts 1 through 6). Its P95 and conservative forecast remained **143,740** for every subsequent record, while later runs were much smaller. With nearest-rank P95 and fewer than 20 samples, a single maximum remains P95; taking `max(latest, EWMA, P95)` prevents recovery.

### Observed before/after deltas

The only five comparable adjacent pairs were:

| Before | After | Endpoint delta | Reported latest | Latest − endpoint | Pressure |
|---:|---:|---:|---:|---:|---|
| 143,740 | 150,888 | 7,148 | 7,148 | 0 | Red → Red |
| 150,888 | 150,994 | 106 | 106 | 0 | Red → Red |
| 150,994 | 155,377 | 4,383 | 4,383 | 0 | Red → Red |
| 155,377 | 155,652 | 275 | 1,333 | +1,058 | Red → Red |
| 155,652 | 157,226 | 1,574 | 1,574 | 0 | Red → Red |

Four endpoint deltas match exactly. The fifth is 1,058 tokens higher, which is compatible with the implementation’s peak-minus-baseline definition, but telemetry does not record the baseline and peak separately, so that explanation cannot be verified.

### Projection error against next observed growth

For each of those five pairs, the forecast in record N was compared with `latestTokens` in record N+1:

| Predictor | MAE | Sum(predictions) / sum(actuals) |
|---|---:|---:|
| Previous latest | 30,240 tokens | 10.77× |
| EWMA | 71,487 tokens | 25.58× |
| P95 | 140,831 tokens | 49.42× |
| Conservative (`max`) | 140,831 tokens | 49.42× |

Conservative forecast errors (forecast − actual) were **+136,592, +143,634, +139,357, +142,407, and +142,166 tokens**.

Runway in this sequence fell from **0.325** to **0.231** “similar runs,” yet five additional, smaller runs completed while headroom remained positive (46,660 → 33,174). Because the subsequent runs were not similar to the contaminated first sample, this does not disprove the formula; it does show that the recorded predictor made runway operationally unhelpful for heterogeneous real work.

## Pressure levels and transitions

| Level | Records |
|---|---:|
| Green | 1 |
| Yellow | 4 |
| Orange | 7 |
| Red | 39 |
| Emergency/unknown | 0 |

Only five transitions were observable, all **Red → Red**. There is no downgrade/hysteresis evidence.

Reason totals:

- runway below Red: 39
- safe-limit ratio at Red: 17
- headroom within emergency margin: 16
- headroom exhausted: 13
- runway below Orange: 7
- latest growth large: 4

Notable likely false-positive signals:

- 22 records were Red solely because runway was below the Red threshold.
- 10 Red records were below 50% of the context window.
- 19 Red records were below the Orange occupancy ratio (`safeLimitRatio < 0.85`).
- 23 Red records still had more than the 8,192-token emergency margin.
- 34/39 Red records had only one growth sample.

Occupancy-driven Red states above the safe limit are plausible; runway-only Red states are not trustworthy until warm-up and compaction behavior are corrected.

## Tool-result byte classes

Telemetry recorded **23,457,550 bytes** across 257 per-tool entries; 50/51 records had a non-empty tool map.

By functional class:

| Class | Bytes | Share |
|---|---:|---:|
| Read/recall/memory | 13,139,647 | 56.0% |
| Search (`rg`, `fd`) | 7,981,651 | 34.0% |
| Shell command | 2,031,769 | 8.7% |
| Edit/write | 275,191 | 1.2% |
| Subagent/orchestrator | 28,541 | 0.12% |
| Background | 495 | 0.002% |
| MCP | 256 | 0.001% |

Top individual tools were `read` 13,139,041 B, `rg` 7,478,634 B, `bash` 2,031,769 B, `fd` 503,017 B, `edit` 261,290 B, and `subagent_wait` 22,446 B. Read plus search produced about 90% of recorded bytes.

Per-tool-entry size classes (descriptive buckets, not governor-defined classes):

| Entry size | Entries | Bytes |
|---|---:|---:|
| <1 KiB | 60 | 17,985 |
| 1–10 KiB | 63 | 275,431 |
| 10–100 KiB | 57 | 2,255,574 |
| ≥100 KiB | 77 | 20,908,560 |

The ≥100-KiB entries account for 89.1% of result bytes, supporting bounded reads/search output as the highest-leverage operational mitigation.

## Compaction evidence

Three structurally persisted session compaction records matched three `message-estimate` telemetry records:

| Session | Before | Estimated after | Delta | Reduction | Post headroom | Runway | Pressure |
|---|---:|---:|---:|---:|---:|---:|---|
| `019faa87-e579-7f25-adc8-1bf58eefcf19` | 256,225 | 21,139 | −235,086 | 91.75% | 169,261 | 0.661 | Red |
| `019faa87-e57d-7bf2-8a73-9581b9d29261` | 271,415 | 21,274 | −250,141 | 92.16% | 169,126 | 0.623 | Red |
| `019faa5d-948e-7779-9b58-faeb65d9ba97` | 277,645 | 15,247 | −262,398 | 94.51% | 175,153 | 0.631 | Red |

Compaction clearly reduced estimated resident context, but EWMA/P95 history survived and made all three low-occupancy post-compaction states Red solely on runway. There is no later settled telemetry in those files to validate rebasing or recovery. This is evidence that compaction pressure reset is currently unsuitable, not evidence that Gate B’s reset criterion passes.

Relevant metadata-only paths:

- `/Users/syndg/.pi/agent/sessions/--Users-syndg-.pi-agent-extensions--/2026-07-28T21-01-00-665Z_019faa87-e579-7f25-adc8-1bf58eefcf19.jsonl`
- `/Users/syndg/.pi/agent/sessions/--Volumes-External-Coding-pi-mono-fullscreen--/2026-07-28T21-01-00-669Z_019faa87-e57d-7bf2-8a73-9581b9d29261.jsonl`
- `/Users/syndg/.pi/agent/sessions/--Volumes-External-Coding-pi-mono-fullscreen--/2026-07-28T20-14-47-438Z_019faa5d-948e-7779-9b58-faeb65d9ba97.jsonl`

## Advisory persistence audit

Exact advisory identity audited:

- `role`: `custom`
- `customType`: `context-governor-advisory`

Across all **592** session JSONL files, exact persisted matches: **0**. Paths containing a match: **none**.

The 46 relevant sessions did contain three unrelated `custom_message` records (`subagent-message` × 2 and `subagent-result` × 1), demonstrating that the structural audit can distinguish persisted custom records without reporting their bodies. Notice non-persistence therefore passes the observed check.

## Representative-scenario coverage

Evidence is based on session structure and tool names, not message content.

| Required scenario | Evidence | Verdict |
|---|---|---|
| Normal editing | 29/46 relevant sessions used `edit` or `write`; telemetry contains 261,290 B from `edit` and 13,901 B from `write` | **Supported** |
| Broad file searches | 45/46 used `rg` or `fd`; 7.98 MB recorded | **Supported** |
| Subagent-heavy work | One session used `subagent_spawn/check/wait/cancel`; three spawn calls were structurally present | **Supported, narrow (one session)** |
| Background process work | One session used one `bg_start` and one `bg_status` | **Supported, narrow (one session)** |
| Compaction | Three session compaction records with matching estimated telemetry | **Supported; behavior problematic** |
| Model switching | Every session has one initial `model_change`, but all assistant and telemetry records use the same model/window and no session has a second model identity | **Unsupported** |
| Session resume | No explicit resume marker and no session ID spans multiple telemetry writer files | **Unsupported** |
| Branching | Parent-ID graphs have zero fork points and no branch-summary/tree record; changing leaf IDs merely tracks an advancing linear tip | **Unsupported** |

The single subagent/background evidence path is:

`/Users/syndg/.pi/agent/sessions/--Volumes-External-Coding-resumatchweb--/2026-07-28T19-41-41-618Z_019faa3f-4772-705a-8654-469a75bbcf28.jsonl`

## Tuning recommendations

1. **Fix warm-up semantics before tuning occupancy thresholds.** When no trustworthy run-start baseline exists, leave first-settle growth/runway unknown or record fixed overhead separately. Do not treat the full first provider usage as run growth.
2. **Gate percentile use on clean history.** Exclude warm-up samples and do not let nearest-rank P95 participate until a minimum clean sample count is reached. With fewer than 20 samples, current P95 is effectively the maximum.
3. **Reset or quarantine velocity after compaction.** Clear EWMA/P95 history, or suppress runway-derived pressure until at least one valid post-compaction settlement. Post-compaction occupancy of 5.6–7.8% must not remain Red solely because of pre-compaction velocity.
4. **Keep the 70% advisory cap and occupancy thresholds (0.85 Orange, 0.95 Red) unchanged for now.** The observed defect is estimator contamination, not evidence that these occupancy limits are wrong.
5. **Temporarily disable runway escalation if only configuration can change.** For another observation window, `orangeRunwayBelow = 0` and `redRunwayBelow = 0` would retain headroom/ratio protection while avoiding positive-runway false escalation. Restore and retune 2/1 only after clean multi-run evidence. Prefer code-level sample gating over this workaround.
6. **Do not tune EWMA alpha from this corpus.** Only one session has a sequence, and its initial outlier dominates. More clean sequences are required.
7. **Add observation fields, still metrics-only:** event kind (`run-settled`, `compaction`, reset), run-start baseline, captured peak, settled endpoint, writer/process start, and reset generation. These make delta and resume/model/branch attribution testable without bodies.
8. **Collect the missing scenarios deliberately:** at least one within-session model/window switch, one resumed session producing a second writer file, and one actual tree branch/fork. Also collect post-compaction follow-up runs and several heterogeneous multi-run sessions.
9. **Retain bounded read/search discipline.** Read and search account for ~90% of tool bytes; ≥100-KiB entries account for 89.1% of all result bytes.

## Gate B criterion matrix

| Criterion | Status | Evidence |
|---|---|---|
| Provider usage vs estimated resident usage | **Partial** | 48/48 `pi-usage` values match session usage metadata; no paired estimate/observed state |
| Latest-run delta accuracy | **Partial/failing warm-up** | 4/5 adjacent endpoint deltas exact; one peak-compatible +1,058; 42/43 first samples equal full context |
| Compaction reset behavior | **Fail** | Three low-occupancy post-compaction records remain runway-only Red |
| Context-window/model changes | **Unsupported** | One model/window only; initial selections are not switches |
| Runway usefulness | **Fail on available sequence** | Conservative forecast MAE 140,831 tokens and 49.42× aggregate overprediction |
| Notice persistence | **Pass** | 0 exact persisted advisories across 592 session files |
| Telemetry overhead | **Partial/pass for disk only** | 0.131% logical storage; runtime latency not measured |
| Representative observation set | **Incomplete** | Model switch, resume, and branch unsupported; subagent/background each only one session |

**Conclusion:** keep Gate B **closed/not passed** and run a second observation window after warm-up, P95, and post-compaction velocity handling are corrected.

## Implemented remediation / second-window requirements — 2026-07-28 22:00:16 UTC

This is a post-observation implementation review. It does not revise any observed number, verdict, or conclusion above. The current governor source, runtime configuration path, and focused tests were read at the timestamp in this heading; no build or test command was run for this documentation-only update. `/Users/syndg/.pi/agent/context-governor/config.private.json` was absent, so the fail-open loader uses the checked defaults (`src/config.ts:227-233`; lifecycle loading is at `index.ts:368-390`).

### Recommendation-to-implementation map

| Original telemetry recommendation | Implemented remediation/current setting | Exact code and test references | Required second-window evidence |
|---|---|---|---|
| 1. Reject contaminated warm-up growth | A comparison baseline is trustworthy only when it is known and greater than zero. A run with no such run-start or previous-endpoint baseline cannot add a growth sample; its endpoint can establish the next comparison baseline. Accepted growth remains peak minus baseline, so the first settled resident total is no longer automatically treated as run growth. | Code: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:259-264`, `:447-464`, `:632-667`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:303-318`; `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:746-789`. | Show rejected zero/unavailable-baseline settlements with `growthSampleAccepted: false`, `sampleCount: 0`, and no EWMA/P95/runway contamination, followed by an accepted next comparison whose growth equals `peakTokens - runStartBaselineTokens`. |
| 2. Gate percentile use on clean history | `minimumP95Samples` defaults to **5** and `minimumRunwaySamples` defaults to **3**. P95 is `null` before five accepted samples. A numeric runway may be displayed earlier from latest/EWMA growth, but Orange/Red **runway pressure** cannot participate before three accepted samples. | Config: `/Users/syndg/.pi/agent/extensions/context-governor/src/config.ts:3-19`, `:35-51`, `:103-141`. Code: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:539-549`, `:699-739`; status exposure: `/Users/syndg/.pi/agent/extensions/context-governor/src/status-report.ts:28-30`, `:111-113`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/config.test.ts:12-37`, `:39-84`, `:86-132`; `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:347-359`, `:455-486`; `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:334-346`. | Confirm P95 stays absent for `n < 5` and appears at `n >= 5`; confirm neither runway reason appears for `n < 3`, while occupancy/headroom reasons remain immediate. Count only records with `growthSampleAccepted: true`. |
| 3. Reset/quarantine velocity after compaction | Compaction starts a new comparison generation, invalidates an open run, clears history/latest/EWMA and held pressure, leaves P95/conservative growth/runway unknown, and seeds only a trustworthy post-compaction comparison baseline. The lifecycle rebases a retrying umbrella run after compaction. | Code: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:488-491`, `:602-614`; `/Users/syndg/.pi/agent/extensions/context-governor/index.ts:430-453`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:546-624`; `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:562-650`. | For every compaction, the compaction record must have a new generation, `sampleCount: 0`, null latest/EWMA/P95/conservative/runway, and no low-occupancy Red caused solely by pre-compaction runway. Then collect at least five accepted same-generation follow-up runs so both the three-sample runway-pressure gate and five-sample P95 gate are observed after reset. |
| 4. Retain the advisory cap and occupancy thresholds | The cap remains **70%**; Orange safe-limit ratio remains **0.85** and Red remains **0.95**. No private override was present at this timestamp. | Defaults: `/Users/syndg/.pi/agent/extensions/context-governor/src/config.ts:35-50`. Budget application: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:86-200`; occupancy pressure: `:699-739`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/config.test.ts:12-33`; `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:22-121`, `:386-422`. | Keep these values fixed throughout the second window and report occupancy-triggered pressure separately from runway-triggered pressure. |
| 5. Prefer code gating over temporarily disabling runway | The preferred code-level gate was implemented, so the original runway thresholds were retained: Orange below **2** similar runs and Red below **1**, with strict `<` comparisons. They were not temporarily changed to zero. | Defaults: `/Users/syndg/.pi/agent/extensions/context-governor/src/config.ts:46-49`. Gate and comparisons: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:709-730`. Boundary test: `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:455-486`. | Demonstrate no runway-only escalation before three accepted samples, then evaluate the retained 2/1 boundaries on clean sequences rather than changing them during collection. |
| 6. Do not tune EWMA alpha from the first corpus | EWMA alpha remains **0.35** and history remains bounded at **20**; the remediation changes sample admission/reset semantics, not alpha. | Defaults: `/Users/syndg/.pi/agent/extensions/context-governor/src/config.ts:35-41`. Calculation/bounds: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:657-666`. Test: `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:320-345`. | Keep alpha/history length fixed and compare forecasts with later accepted growth across several heterogeneous clean multi-run sessions. |
| 7. Add metrics-only comparison audit fields | Telemetry now records `eventKind`, `comparisonGeneration`, `comparisonResetReason`, `runStartBaselineTokens`, `baselineSource`, `peakTokens`, `endpointTokens`, and `growthSampleAccepted`. Writer attribution is the PID/writer-scoped filename plus the timestamped `session-start` record; there is no separate `writerStartedAt` field. Records remain bounded and body-free. | Audit contract/population: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:44-53`, `:509-518`. Telemetry schema/projection: `/Users/syndg/.pi/agent/extensions/context-governor/src/telemetry.ts:28-53`, `:66-74`, `:86-127`. Lifecycle emission: `/Users/syndg/.pi/agent/extensions/context-governor/index.ts:368-392`, `:440-497`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/telemetry.test.ts:74-196`; `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:369-390`, `:775-789`. | Require all new fields on relevant records, monotonic generation changes at reset events, a timestamped `session-start` per writer file, and no message body, arguments, result content, credentials, or raw paths. |
| 8. Deliberately collect missing lifecycle scenarios | Reset paths exist for model identity/window changes, session start/resume, tree changes, and compaction, but unit/lifecycle fixtures are not substitutes for real evidence. Writer-scoped files avoid clobbering when one session has multiple writers. | Code: `/Users/syndg/.pi/agent/extensions/context-governor/src/governor.ts:403-435`, `:587-614`; `/Users/syndg/.pi/agent/extensions/context-governor/index.ts:368-392`, `:473-497`; `/Users/syndg/.pi/agent/extensions/context-governor/src/telemetry.ts:66-74`. Tests: `/Users/syndg/.pi/agent/extensions/context-governor/governor.test.ts:626-668`; `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:349-390`, `:652-684`; `/Users/syndg/.pi/agent/extensions/context-governor/telemetry.test.ts:112-156`. | Obtain real telemetry for one within-session model/window switch, one resumed session producing a second writer file for the same session ID, one actual tree fork/branch, and post-compaction follow-up runs. Each reset must increment generation, clear incomparable history, and admit only new-generation growth. |
| 9. Retain bounded read/search discipline | No output cap was added in this remediation. The advisory still tells the model to avoid broad parent-session searches and request bounded slices; this remains an operational requirement rather than evidence for Phase 2 enforcement. | Advisory text: `/Users/syndg/.pi/agent/extensions/context-governor/index.ts:162-169`. Non-enforcement statement: `/Users/syndg/.pi/agent/extensions/context-governor/README.md:17-21`. Notice test: `/Users/syndg/.pi/agent/extensions/context-governor/lifecycle.test.ts:142-219`. | Continue reporting tool-result bytes by tool and the ≥100-KiB class during the second window; verify bounded practice without enabling caps or decay. |

### Suggested acceptance criteria for the second real observation

1. **Warm-up admission:** an initial missing/zero-baseline settlement is rejected and keeps velocity at `n=0`; every accepted sample is reproducible from its recorded positive baseline and peak. No accepted first sample may equal the full resident context merely because a baseline was absent.
2. **Estimator gates:** P95 is absent through four accepted samples and present from the fifth; Orange/Red runway reasons are absent through two accepted samples and eligible from the third. Occupancy and emergency-headroom protection must continue to work during warm-up.
3. **Compaction recovery:** each compaction creates a new generation with all pre-compaction velocity removed. At low post-compaction occupancy, pressure must not remain Red solely because of pre-compaction runway. Collect at least five accepted post-compaction runs in that generation and compare each forecast with the next accepted growth.
4. **Lifecycle coverage:** capture, in real use, (a) a provider/model or context-window switch, (b) a process restart/resume that creates a second writer file for the same session ID, and (c) an actual branch/fork. Verify reset records, generation changes, branch/model identity, writer separation, and clean post-reset baselines.
5. **Forecast usefulness:** use several heterogeneous sessions with at least five accepted samples each; report next-growth MAE, aggregate prediction/actual ratio, and runway-only false positives using only clean same-generation samples. As a suggested pre-registered bar, aggregate conservative prediction should be no more than **2×** aggregate actual growth and there should be **zero** low-occupancy runway-only Red states before the three-sample gate.
6. **Threshold/config stability:** leave the 70% cap, 0.85/0.95 occupancy ratios, 2/1 runway thresholds, 0.35 EWMA alpha, and 20-sample history unchanged for the full window; archive the effective config state with the observation.
7. **Privacy and overhead:** preserve metrics-only records, `0600` files, per-writer separation, and the 200-record/524,288-byte bounds; repeat the exact advisory-persistence audit and report disk plus any available runtime-latency evidence.

A second real observation is still required for **model switch, resume, branch, and post-compaction follow-up** behavior; synthetic and lifecycle tests do not close those evidence gaps. **Gate B remains open (not passed), and all downstream enforcement/adaptive-limit/decay gates remain closed.**
