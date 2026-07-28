# Context Archive

Isolated Wave 2 / Phase 2 library for pressure-aware output budgeting and durable, session-scoped artifact recall. It has no Pi extension entry point, registers no tools, changes no existing adapters, and enables no caps globally.

## Deep-module interfaces

```ts
interface OutputBroker {
  process(request: OutputRequest): Promise<OutputEnvelope>;
}

interface ContextArchive {
  store(output: ArchivableOutput): Promise<StoredArtifact>;
  recall(request: RecallRequest): Promise<RecallResult>;
  query(request?: ArchiveQuery): Promise<ArchiveQueryResult>;
}
```

`OutputBroker.process` hides pressure policy, hard-ceiling enforcement, durability ordering, shortening, retrieval-envelope formatting, and savings metrics. `ContextArchive` hides redaction, safe names, atomic filesystem commits, integrity checks, indexing, query bounds, and UTF-8/terminal-safe recall slices.

## Invariants and failure behavior

- Results at or below the selected byte cap are returned byte-for-byte unchanged.
- Before any oversized result is replaced, the complete redacted artifact, metadata, and index entry are durably written. Artifact content and metadata are staged, synced, and atomically renamed as one directory; the query index is appended and synced last.
- If store or required preview recall fails, the broker **fails open** and returns the exact raw output with `disposition: "fail-open"` and `persistenceError`. It never reports a shortened result without a recoverable artifact.
- Requests may opt into the bounded `error` presentation and name an adapter recall tool. This changes only the replacement envelope: stored content, durability ordering, hard ceilings, and fail-open behavior are identical.
- Artifact IDs are strict filename-safe identifiers. Session directory names are one-way SHA-256 scopes, so untrusted session IDs never become path segments.
- URIs use `context://<session-scope>/<artifact-id>`. Recall accepts only a safe ID from the current archive or a same-session URI; it does not accept arbitrary paths.
- Stored content is integrity-checked on recall. Recall is always bounded by configured byte and line ceilings and never permanently rehydrates provider context.
- The built-in conservative redactor covers common bearer/API/token/password forms. Inject `redactor` for domain-specific policy or `identityRedactor` only where raw persistence is explicitly acceptable. Redaction is the sole intentional difference between original and stored oversized content.
- Broker metrics contain counts only: input/delivered/artifact bytes plus estimated input/delivered/saved tokens. `onMetrics` is the future governor-adapter seam.

## Default budgets

Values are binary KiB. `emergency` uses Red; unknown pressure uses Green.

| Output class | Green | Yellow | Orange | Red |
|---|---:|---:|---:|---:|
| `read` | 20 KiB | 14 KiB | 8 KiB | 4 KiB |
| `search` (`rg` / `fd`) | 16 KiB | 10 KiB | 6 KiB | 3 KiB |
| `mcp-result` | 16 KiB | 10 KiB | 6 KiB | 3 KiB |
| `subagent-final` | 8 KiB | 6 KiB | 4 KiB | 2 KiB |
| `child-live-message` | 4 KiB | 3 KiB | 2 KiB | 1 KiB |
| `background-completion` | 2 KiB | 1 KiB | 1 KiB | status only (0 detail bytes) |

The default explicit-override hard ceiling is 64 KiB. An explicit limit can lower or raise a default but cannot exceed that ceiling. Invalid explicit limits fall back to policy. All defaults are configurable per output class and pressure.

## Example

```ts
import {
  createContextArchive,
  createOutputBroker,
} from "./src/index.ts";

const archive = createContextArchive({
  rootDirectory: "/absolute/private/artifact/root",
  sessionId: currentSessionId,
});
const broker = createOutputBroker({
  archive,
  onMetrics: (metrics) => governorTelemetry.record(metrics),
});

const envelope = await broker.process({
  toolName: "rg",
  outputClass: "search",
  pressure: governorState.pressure.level,
  rawOutput,
  metadata: { queryKind: "symbols" },
  tags: ["search"],
});
```

Adapters should return `envelope.output` and surface the structured artifact/retrieval fields in any UI that can represent them. A Red background completion has zero detail bytes; its adapter is responsible for rendering status from the structured envelope rather than injecting the log.

For oversized Pi error results, the adapter sets `presentation: "error"` and `recallToolName: "context_recall"`; the broker then prioritizes an explicit error label, bounded synopsis, artifact URI, and bounded-recall instruction even when it must use the compact marker.

## Artifact layout

```text
<root>/<session-scope>/
  index.jsonl
  artifacts/<artifact-id>/
    content.txt
    metadata.json
```

Directories are mode `0700`; files are mode `0600`. The index contains redacted metadata only, never artifact bodies.

## Development

Use the fork toolchain without installing or building:

```bash
node --test --experimental-strip-types *.test.ts
/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin/tsc --noEmit -p .
```
