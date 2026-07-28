# Context Output

Thin Phase 2 Pi adapter over `context-archive`.

- Subscribes only to validated, same-session Context Governor state.
- Intercepts configured ordinary textual tool results and every textual error result while preserving tool identity, `isError`, details, usage, images, and other non-text blocks.
- Defaults to **shadow** mode: pressure-adaptive caps (including error caps) are observed but never applied. Set `mode` to `enforce` in private `config.private.json` only after observation review. `off` disables observation and enforcement.
- Enforcement durably archives complete textual output before replacing it, adds the `context://` reference to tool-result details without dropping producer details or spill references, and fails open to the exact original result text.
- Small textual errors remain byte-for-byte exact. Oversized errors use their own pressure-adaptive budget and produce a bounded, explicitly labeled error synopsis with a `context_recall` instruction only after the archive commit succeeds.
- Emits count-only observations (including `isError`, byte counts, limits, artifact state, and fail-open state) on `context-output:metrics`. Optional bounded non-context JSONL custom entries (`context-output-metrics`) are disabled by default.
- Registers `context_recall`, which accepts a same-session artifact ID/`context://` URI, durable branch entry ID/`session-entry://` URI, or metadata query and always returns bounded safe slices.
- Artifacts live under `~/.pi/agent/context-output/artifacts/<session-scope>/`; resuming the same session reuses that scope, while new/forked sessions receive another scope.
- Completion producers use `context-output:completion`: routine successes are queued for the next user turn without waking the parent; failures (and explicit urgent/waited requests where exposed) use a waking follow-up. Existing child transcripts, terminal spill logs, and workflow artifacts remain authoritative and are referenced, not copied away.

## Private config

`~/.pi/agent/context-output/config.private.json` is optional and fail-open. Main fields: `mode`, `toolClasses`, `prefixClasses`, `explicitLimitBytes`, `broker`, `errors`, `recall`, `metrics`, and `completions`. Unknown/malformed values fall back independently. No project config is read.

```json
{
  "mode": "shadow",
  "errors": {
    "hardCeilingBytes": 65536,
    "limitsBytes": {
      "green": 32768,
      "yellow": 24576,
      "orange": 16384,
      "red": 8192
    }
  }
}
```

Error limits are UTF-8 byte limits. `emergency` uses Red and missing pressure uses Green. The default Green error cap (32 KiB) is larger than every normal Green source cap; limits then contract with pressure. Values are clamped to the error hard ceiling and a 256-byte minimum so a recall instruction remains representable. Per-tool `explicitLimitBytes` applies to normal results; error results use `errors`. The extension creates a dedicated error broker so a configured error hard ceiling remains independent of the normal broker ceiling.

## Validation

```bash
node --test --experimental-strip-types *.test.ts
/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin/tsc --noEmit -p .
```

Limitations: recall rejects arbitrary filesystem paths and foreign-session URIs. Shadow mode does not create archives because no output is shortened. Child-message urgency is not inferred because current producer schemas expose no urgency flag.
