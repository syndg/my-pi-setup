# Context Cache Observer (retired runtime)

The live extension adapter is intentionally a no-op. It registers no commands, lifecycle hooks, telemetry writers, or model-visible messages.

Prompt-cache observation did not provide enough day-to-day value to justify another user-facing status command or continuous runtime telemetry. The pure evaluator, prefix, status, telemetry, and usage modules remain available for offline tests and reference.

## Validation

```bash
node --test --experimental-strip-types *.test.ts
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
