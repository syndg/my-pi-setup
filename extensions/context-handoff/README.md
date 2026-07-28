# Context Handoff

Phase 5B adapter over `context-checkpoints`: deterministic checkpoint persistence and explicit fresh-session handoff.

## Commands

- `/checkpoint <exact next action>` derives a strict checkpoint from the active branch, up to eight recent `summary-recap` entries, tool/file/test evidence, artifact references, and the published governor snapshot. It never trusts hidden model output; the local deterministic path is the implementation.
- `/handoff <exact next action>` waits for idle, blocks on active/uncertain child or background work, confirms in UI, validates and atomically prewrites the checkpoint and recovery manifest, appends a non-context checkpoint entry, then calls `ctx.newSession({ parentSession, setup })`. Setup adds a non-context seed plus one bounded context bootstrap. It does not call `sendUserMessage`, set editor text, or auto-run a turn.

Pressure events only recommend `/checkpoint`; they never checkpoint or hand off automatically.

Artifacts live under `~/.pi/agent/context-handoff/` (or the configured agent directory), mode `0600`, with atomic temp-file + rename + directory sync commits.

## Safety and recovery

- Cancellation before confirmation writes nothing. A Pi session gate may cancel after prewrite; prepared artifacts remain valid and the original stays active.
- A leaf/session change during async preflight aborts before `newSession`; use the reported prepared manifest if desired.
- Child/background status is reconstructed from bounded recent tool results and bounded in-memory lifecycle state. Unknown/running work blocks safely; settle/cancel it and retry.
- The original conversation tree is never rewritten or compacted. Only the expected non-context checkpoint marker is appended.

If setup or runtime replacement fails after Pi begins replacement, open `~/.pi/agent/context-handoff/handoffs/<session-id>/<checkpoint-id>.prepared.json`, then resume the original with `pi --session <originalSessionFile>`. The manifest points to the complete checkpoint and contains the bounded bootstrap. A partially created child can be deleted from `/resume`; no rollback mutates the original.

## Development

```bash
node --test --experimental-strip-types *.test.ts
/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin/tsc --noEmit -p .
```
