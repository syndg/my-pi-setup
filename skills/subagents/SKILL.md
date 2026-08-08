---
name: subagents
description: Delegate self-contained tasks to background Pi subagents. Use when parallel or independent work can proceed in its own context window and return a result later.
---

# Subagents

Each subagent is a headless Pi session with its own context window. It cannot see the parent conversation, ask the user, or spawn other agents/workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Spawn

Call `subagent_spawn` with:

- `harness`: `pi` (the only available harness)
- `prompt`: a complete, standalone task
- `name`: a short descriptive label
- optional `working_dir`: trusted child directory; defaults to the parent cwd
- optional `model`: Pi `provider/model-id` or a bare, unambiguous model id; omit to inherit the parent model
- optional `reasoning_effort`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; omit to inherit the parent level
- optional `profile`: `coding` (default), `research`, `review`, or `minimal`

Pi profile allowlists and the recursive-orchestration denylist are tool-policy controls, not OS sandboxing. Do not use models from the Anthropic provider even if one appears in the Pi model list.

## Manage

- `subagent_check({ id })`: peek without blocking or consuming the result.
- `subagent_list()`: list all tracked runs.
- `subagent_wait({ ids })`: wait until every listed child settles and consume those deliveries.
- `subagent_cancel({ ids })`: stop children while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. Continue useful parent work after spawning rather than immediately waiting. Use `subagent_wait` only when progress is blocked on child results: it is a synchronization barrier, and waiting immediately throws away fire-and-forget parallelism. Aborting a wait leaves the children running; use `subagent_cancel` to stop them. Explicit waits still honor each child’s pressure/profile output budget and normal context-output brokerage, while full material remains in the Pi transcript.
