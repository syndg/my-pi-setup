# Context Cache Observer

Metrics-only, advisory prompt-cache observation for Phase 8 / Wave 5's cache lane.

## Behavior

- Aggregates each settled agent run's provider-reported `input`, `output`, `cacheRead`, and `cacheWrite` values. Unknown APIs retain input/output while cache fields remain explicitly unavailable rather than being treated as zero.
- Computes cache-read ratio as `cacheRead / (uncached input + cacheRead + cacheWrite)` where the API reports cache counters.
- Audits the system/tool prefix with process-keyed HMAC fingerprints and byte counts. Prompt text, schemas, message bodies, tool arguments/results, credentials, and HMAC keys are never persisted.
- Detects additive active-tool changes, emits/correlates metadata on `context-cache:tool-activation`, and does not classify correlated additive activation as churn.
- Consumes `context-decay:wire-accounting` and tracks bounded `cacheEpochId` metadata. Stable repeated epochs are healthy; epochs changing sooner than three settled runs are flagged.
- Publishes the pure evaluation on `context-cache:audit`. The evaluator only recommends tuning; this extension never calls `setActiveTools`, modifies a `context` event, changes a system prompt, arms decay, or mutates session state.

## Command

```text
/context-cache-status
```

Shows observed cache ratio, provider availability, prefix/epoch flags, latest decay cache epoch, additive activation count, recommendation, and telemetry path. It adds no model-visible message.

## Telemetry and privacy

Bounded JSONL is written to `~/.pi/agent/context-cache/telemetry/`. Files are isolated by session and process, directories are mode `0700`, and files are mode `0600`. Default bounds are 200 records and 512 KiB. Writes are queued, atomic, and fail-open.

Telemetry contains only numeric usage, bounded provider/model/API labels, prefix counts/bytes, tool names added through activation, and decay cache epoch IDs. It contains no prompt or message bodies, system prompt text, tool input/output, raw provider payloads/headers, paths from messages, or secrets. Process-keyed prefix fingerprints are intentionally not comparable across Pi processes.

## Advisory interpretation

- `observe-more`: provider cache fields are unavailable or fewer than two observable settled runs exist.
- `stabilize-prefix`: non-additive tool removal/replacement or an unexplained system/tool prefix change was observed.
- `increase-decay-epoch-lifetime`: applied decay cache epochs changed too frequently; batch replacements and keep an epoch stable longer.
- `investigate-cache-hit-regression`: reported reads remain below the default 35% ratio after warmup.

No recommendation is applied automatically.

## Development

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
