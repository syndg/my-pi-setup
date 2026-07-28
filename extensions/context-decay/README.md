# Context Decay (Phase 4 cache-aware policy)

A deep, deterministic `ContextDecay` engine plus a thin Pi lifecycle adapter. It proposes and can apply non-destructive request-time elisions, validates provider ordering, and reports resident/effective-wire estimates. The durable JSONL transcript is never edited.

## Rollout state

- Automatic outgoing-context mutation is implemented but **off by default** (`automaticMutationEnabled: false`).
- When privately enabled, the pure automatic policy may arm an in-memory epoch only at a deterministic pressure, wire-target, or cache-advisory trigger after all savings and spacing gates pass. The same epoch is reused between boundaries; append-only growth does not cause per-turn rewriting.
- `/context-decay` and `/context-decay preview` produce an explicit bounded preview.
- `/context-decay apply` is a separate path, denied by default, and requires `allowExplicitApply: true`. It installs an **in-memory** explicit epoch applied only to future deep-copied `context` event messages.
- `/context-decay clear` drops only that explicit in-memory epoch.
- Compaction, tree navigation, model changes, session replacement, and reload clear both automatic and explicit epoch state.
- `context_recall` belongs to context-output and resolves both `context://...` artifacts and bounded `session-entry://<session>/<entry>` durable-branch references. Unresolvable candidates are protected from decay.

## Engine

```ts
const plan = planContextDecay(context, policy);
const outgoing = applyDecayEpoch(context, plan.epoch);
```

Candidate classes:

- superseded reads and repeated searches;
- consumed searches;
- acknowledged background/subagent/workflow results;
- empty outputs;
- duplicate payloads;
- old large results.

Conservative protections cover the configurable recent token working set, latest read per active file, latest user goal/constraints, unresolved errors, pins, latest checkpoint/handoff, and structural tool-call messages. Replacements keep every message, role, tool-call ID, tool-result ID/name, and assistant provider/model/API field in its original position. Only result payload content changes to a byte-stable placeholder.

The engine refuses replacement when input tool pairing is invalid or a candidate lacks a durable recall source. An oversized protected single turn is reported as a dead-end rather than silently violating the protected tail.

## Epochs and identity seam

Pi's `context` event provides a deep copy of `AgentMessage[]`, not session entry IDs. The adapter projects `buildContextEntries()` through `sessionEntryToContextMessages()` and performs ordered exact matching. Matches use `entry:<id>` identities and can emit session-entry recall references.

Unmatched provider/extension-generated messages use a deterministic identity:

```text
synthetic:<role>:<canonical-payload-sha256-prefix>:<prior-identical-ordinal>
```

Tool results additionally use `tool-result:<toolCallId>`. Synthetic identity is stable across append-only growth, but unmatched content is not elided unless it already carries a durable `context://` artifact URI. This matching function is the documented adapter seam for a future first-class Pi message-to-entry API.

Epoch IDs hash the session, model, compaction generation, ordered replacement identities, original digests, and placeholders. Applying an existing epoch never adds replacements for newly appended messages. Automatic rollover additionally requires a materially different replacement set plus the configured settled-run and wall-clock spacing.

## Automatic policy

The policy is pure: it receives a deterministic plan, current in-memory policy state, current identity, and optional validated advisory metadata. It can arm only when all applicable gates pass:

- `automaticMutationEnabled` is true;
- the input/output sequence is valid and at least one recoverable replacement remains after the normal protected-set rules;
- projected total savings meet `automaticMinimumProjectedSavingsTokens`;
- both `automaticMinimumSettledRuns` and `automaticMinimumEpochDurationMs` have elapsed since reset or the previous arm;
- at least one deterministic trigger exists: entry into Orange/Red/Emergency, resident context above `maximumWireTokens`, or a fresh cache-cold/prefix-churn/epoch-churn audit event;
- a rollover changes the replacement set rather than merely changing the planning-time context digest.

Governor events are accepted only after schema validation and exact session, branch, model, and generation matching, and only within `automaticSignalMaximumAgeMs` (with bounded future skew). Cache-audit events are schema-validated, reduced to flags, and stamped with the active session identity and receive time; they are discarded on every identity boundary. Missing or stale advisory data never triggers mutation. Automatic and explicit epochs are memory-only and transform only the deep-copied outgoing request.

## Accounting and shadow event

Both resident and effective-wire sizes are deterministic message estimates (`UTF-8 bytes / 4` plus per-message structural allowance). Reports contain counts and references only—never message bodies—and are emitted on:

```text
context-decay:shadow-report
```

Reports cap candidate records with `maximumReportedCandidates`; command text is capped by `maximumReportCharacters`.

## Private configuration

Path: `~/.pi/agent/context-decay/config.private.json`

```json
{
  "protectedRecentTokens": 20000,
  "oldLargeResultTokens": 4000,
  "minimumReplacementSavingsTokens": 128,
  "maximumWireTokens": null,
  "pinnedIdentities": [],
  "allowExplicitApply": false,
  "automaticMutationEnabled": false,
  "automaticMinimumProjectedSavingsTokens": 4000,
  "automaticMinimumSettledRuns": 3,
  "automaticMinimumEpochDurationMs": 120000,
  "automaticSignalMaximumAgeMs": 120000,
  "maximumReportedCandidates": 24,
  "maximumReportCharacters": 4000
}
```

Enabling `automaticMutationEnabled` does not enable `/context-decay apply`; the two opt-ins and their active epochs remain separate. `maximumWireTokens: null` disables only the wire-target trigger.

## Validation

Without installing or building:

```bash
node --test --experimental-strip-types *.test.ts
/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin/tsc --noEmit -p .
```
