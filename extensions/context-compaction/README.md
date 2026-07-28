# Context Compaction — Phase 6B Production Adapter

Production extension around the checkpoint-shaped Phase 6A engine. `index.ts` registers `session_before_compact` and observes `session_compact`; Pi remains the persistence, reconstruction, retry, and queued-message owner.

## Policy and fallback

Private configuration is `config.private.json` beside this README.

- Manual, threshold, and overflow custom compaction all default off, preserving Pi's native behavior until observation review.
- Manual custom compaction requires `manual.custom: true`. Threshold custom compaction requires both `threshold.custom` and `threshold.observationOptIn`; overflow requires `overflow.experimentalCustom`.
- Every custom failure returns `undefined` to native recovery; the extension never returns `{ cancel: true }`.

The dedicated summary model defaults to the same provider/model/reasoning shape used by the summaries extension. Optional verification uses the dedicated model and an exact JSON verdict contract.

For every unavailable model/auth failure, abort, malformed/empty output, verifier failure, invalid preparation/boundary/result, or adapter exception, the hook returns `undefined`, so Pi runs native compaction. No deterministic Phase 6A fallback is used in production.

## Data contracts

The adapter uses Pi's `preparation` for `tokensBefore`, prior summary, abort signal, and native boundary validation, and uses committed `branchEntries` for the smaller 8–12K retained boundary. The latest valid handoff checkpoint marker is merged as previous checkpoint state. Queued messages are neither visible to nor mutated by the adapter.

Before returning a `CompactionResult`, it validates a non-empty exact `context-checkpoint/v1` summary, matching `tokensBefore`, an existing structurally valid `firstKeptEntryId`, and a retained suffix with no orphan tool result. Summary/verifier usage is returned on the result and persisted by Pi.

`session_compact` emits count-only `context-compaction:metrics` and, by default, bounded non-context `context-compaction/metrics-v1` entries. Metrics include reason, retry/native-extension outcome, token/cost totals, fallback code, and post-reconstruction validation—never summary or transcript bodies.

## Development

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```

No install or build is required.
