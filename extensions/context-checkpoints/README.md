# Context Checkpoints

Phase 5A checkpoint core for controlled context handoffs and future checkpoint-shaped compaction summaries. This is an isolated, in-process deep module: callers cross one pure interface while schema validation, normalization, recap consolidation, merge policy, bounds, and canonical serialization stay behind the seam.

There is intentionally no root extension entrypoint. The package does not register commands, create sessions, intercept lifecycle or compaction events, call a model, or persist files.

## Interface

```ts
import { checkpointCore } from "./src/index.ts";

const result = checkpointCore.merge({
  previous: priorCheckpoint,
  recaps: [{ recap: "Added validation.", next: "Run tests." }],
  updates: {
    goal: "Finish the checkpoint core.",
    blockers: [],
    nextActions: ["Run focused tests."],
    contextPolicyState,
  },
});

if (!result.ok) {
  // Each issue has a JSON path, stable code, and repair instruction.
  console.error(result.issues);
} else {
  const json = checkpointCore.serialize(result.checkpoint);
}
```

The public operations are:

- `validate(unknown)` — strict exact-key runtime validation, returning a normalized checkpoint or actionable issues;
- `parse(string)` — JSON parsing plus validation (no model-output guessing or fence extraction);
- `merge(input)` — previous checkpoint + UI recap inputs + current updates;
- `serialize(unknown)` — validation plus deterministic canonical JSON, or `CheckpointValidationError`.

Standalone named functions and schema types are also exported from `src/index.ts`.

## Schema v1

`context-checkpoint/v1` requires these sections:

- `goal`;
- `constraintsAndPreferences`;
- `completedWork`;
- `workingSet`;
- `decisions` with rationale;
- `changedFiles`;
- `testsAndOutcomes`;
- `unresolvedQuestions`;
- `blockers`;
- `nextActions`;
- `criticalReferences` for session entries and artifacts;
- `contextPolicyState` with governor-compatible pressure/provenance and future resident/wire dual accounting.

`originalSession` is optional and carries the original session ID plus optional branch leaf and transcript path. Required list sections may be explicitly empty; omission is invalid. `goal` must contain text.

See `fixtures/continuation-checkpoint.v1.json` for the complete shape.

## Merge policy

Merge behavior distinguishes durable history from current snapshots:

- current `goal` and `contextPolicyState` replace previous values;
- constraints, completed work, decisions, changed files, tests, and critical references accumulate and de-duplicate;
- summaries-extension `{ recap, next }` inputs append recap text to completed work;
- only the newest actionable recap `next` becomes a fallback next action, avoiding stale intermediate suggestions;
- current working set, unresolved questions, blockers, and next actions replace prior snapshots when supplied (including explicit empty arrays);
- changed files merge by normalized path and references by `(kind, id)`, with current details winning;
- malformed previous checkpoints fail the merge instead of being ignored.

## Determinism and bounds

Normalization removes ANSI/OSC and unsafe terminal controls, normalizes line endings, trims trailing whitespace, and de-duplicates without reordering meaningful lists. Serialization always emits schema fields in canonical order, two-space JSON, and one final newline.

`CHECKPOINT_LIMITS` defines UTF-8 byte, item-count, reference-count, and total-document ceilings. Oversized input is rejected with instructions to move full detail into an artifact; the core never silently truncates checkpoint state.

## Development

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
