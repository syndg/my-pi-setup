# Context Memory

Wave 5 / Phase 8 stable-facts-only cross-session memory. The implementation is a deep module behind four methods (`remember`, `search`, `forget`, `consolidate`) plus a thin Pi lifecycle/tool/command adapter.

## Policy

Memory stores only these versioned schema categories:

- `user-preference`
- `project-convention`
- `architectural-decision`
- `environment-fact`

Every record is schema v1 and includes global/project scope, one or more source kind/reference pairs, creation/update/confirmation/expiry timestamps, confidence, and status. Project conventions and architectural decisions require project scope. Facts must be bounded, single-line, stable statements. Transcript-shaped content, live task state, checkpoints, tool outputs, and common secrets are rejected.

There are **no autonomous or model-authorized writes**: no message, tool-result, checkpoint, compaction, session hook, or model-facing tool can mutate memory. Durable mutation is available only through human-executed slash commands. The extension never adds memory to startup, system prompt, or every turn.

`memory_search` is the only model-facing tool. It has no misleading `authorization` parameter because recall is read-only. Its output is byte/result bounded. A request-time gate allows a newly returned search result into exactly one provider context call, then replaces that tool result with a stable placeholder while preserving tool-call/result structure. Slash-command search is UI-only and never enters provider context.

## Storage and retention

Default file: `~/.pi/agent/context-memory/memory.v1.json` (resolved with Pi's agent directory helper).

- parent directory mode `0700`; file and atomic staging files mode `0600`;
- same-directory write + file sync + atomic rename + directory sync;
- cross-process lock directory around the complete read-merge-atomic-write transaction;
- bounded lock acquisition wait, dead-owner stale-lock recovery, and lock-free snapshot reads;
- 500 records and 256 KiB serialized storage by default;
- 1 KiB facts, bounded references/sources, 8 KiB maximum recall;
- default retention 365 days, configurable per write up to 3,650 days;
- expired records are hidden from search and removed only during an explicit mutating operation;
- a full store rejects new writes rather than silently evicting active facts.

Dedup is deterministic and intentionally conservative: Unicode/case/spacing/punctuation-equivalent facts in the same category and scope share one key. `remember` merges exact duplicates, preserving bounded distinct sources, oldest creation time, newest confirmation, longest expiry, and highest confidence. `consolidate` applies the same exact policy plus expiry removal. It never fuzzily merges, resolves contradictions, summarizes, or synthesizes facts.

The default secret policy rejects common credential shapes before persistence. `MemorySecretPolicy` is the internal seam for a stricter domain policy or explicit redaction policy; `redactCommonSecrets` is provided. Raw-secret acceptance exists only as a named testing helper.

## Model tool

The only model-facing memory tool is read-only:

- `memory_search`

It supports bounded query/category/scope filtering and does not accept or imply a human-authorization value. Scopes `all` and `project` mean current project only plus global where applicable; another project's records are never returned through the current adapter. Durable remember, forget, and consolidate operations are intentionally absent from the model tool registry.

## Human commands

Mutations require actual slash-command execution:

- `/memory-remember {"category":"user-preference","scope":"global","fact":"Prefer concise reports.","source_kind":"user-statement","reference":"explicit request 2026-07-28","confidence":0.95}`
- `/memory-search {"query":"reports","scope":"all","limit":8,"max_bytes":4096}`
- `/memory-forget mem_abcd1234`
- `/memory-consolidate {"scope":"all"}`

Command names are consistently hyphenated. Command search reports via UI notification only and does not arm provider recall. Forget is limited to global/current-project scope.

## Deep-module interface

```ts
interface ContextMemory {
  remember(input: RememberMemoryInput): Promise<RememberMemoryResult>;
  search(input?: SearchMemoryInput): Promise<SearchMemoryResult>;
  forget(input: ForgetMemoryInput): Promise<ForgetMemoryResult>;
  consolidate(input?: ConsolidateMemoryInput): Promise<ConsolidateMemoryResult>;
}
```

The interface hides schema validation, stable-content policy, secret handling, project isolation, ranking, all bounds, retention, exact dedup, serialization, and commit ordering. `MemoryPersistence` is the local-substitutable seam: its `update` operation encloses the complete read-modify-write transaction. The production adapter adds a bounded, stale-recoverable cross-process lock plus atomic mode-`0600` filesystem replacement; lock-free reads see either the previous or next complete snapshot. Tests use both it and an in-memory/failing adapter.

## Development

No install or build is needed:

```bash
node --test --experimental-strip-types *.test.ts
/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin/tsc --noEmit -p .
```
