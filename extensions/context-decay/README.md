# Context Decay (retired runtime)

The live extension adapter is intentionally a no-op. It registers no commands, lifecycle hooks, request transformations, or telemetry publishers.

Request-time decay overlapped with native percentage-based compaction and recoverable output bounding while adding another policy surface the user would need to understand. Native compaction now owns routine context reduction. The deterministic decay engine and policy modules remain available for offline tests and reference; durable JSONL history was never modified.

## Validation

```bash
node --test --experimental-strip-types *.test.ts
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
