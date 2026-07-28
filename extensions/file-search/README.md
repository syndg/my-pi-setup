# file-search

`fd` and `rg` stream complete stdout to a process-temp file before shaping the model-facing preview. When the preview is truncated, the returned tool result follows Pi's standard spill contract:

- `details.truncated` is `true`.
- `details.fullOutputPath` is the absolute path to the complete, unmodified stdout capture.
- The text notice names the same path.
- No path or recoverability claim is returned when output is complete or persistence fails.

Consumers should treat `details.fullOutputPath` as the stable adapter field for local spill artifacts. This is also the compatible contract for externally supplied MCP results: MCP remains owned by its package/output guard, and adapters may preserve an optional `fullOutputPath` without changing the external package. Context-archive adapters can subsequently broker that file into their own `context://` artifact metadata.
