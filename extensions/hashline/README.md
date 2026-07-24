# Strict Hashline adaptation for Pi

Production v1 overrides Pi's `read` and `edit` as a pair. Successful safe text reads emit a session-local `[path#16_HEX_TAG]` header and numbered rows. `edit` accepts structured line operations against that exact snapshot and rejects unknown, stale, unseen, overlapping, invalid, and no-op requests. A successful edit returns a fresh actionable tag plus bounded numbered context; re-ground from those visible rows or call `read` when the next target is outside them or context was truncated.

This release intentionally has no fuzzy recovery, text DSL, search anchors, block operations, multi-file transaction, or filesystem crash atomicity. It performs complete in-memory preflight and one direct write inside Pi's per-file mutation queue, matching Pi 0.82.0's write semantics.

The bounded preview is latest-only and rate-limited. It safely degrades to complete-argument preview; provider-specific partial-argument cadence is not claimed until a supervised provider canary verifies it.

Child integration tests use production `DefaultResourceLoader` package discovery plus `createAgentSession`/`bindExtensions`, the same resource seam used by the Pi subagents backend. They do not invoke that backend's model-starting Effect scope without a live model; exact backend spawning remains a supervised canary.

## Rollback

Remove or disable the paired extension, restart Pi (or reload extensions), start a new session, and re-read files. Pi's built-in `read` and `edit` return as a pair; do not continue a session containing the old Hashline protocol.

## Development

```sh
npm install
npm run format:check
npm run check
npm test
```

See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for adapted-source provenance and licenses.
