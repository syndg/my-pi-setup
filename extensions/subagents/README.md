# Subagents

Background delegation to Pi child agents. Spawning is always an explicit parent decision; context pressure never auto-spawns or forces delegation.

## Context-aware delegation

The extension validates same-session `GovernorState` events. Fresh Green/Yellow/Orange/Red/Emergency state selects a pressure/profile output budget; missing, invalid, stale, wrong-session, or unknown-pressure state uses a conservative red-equivalent budget.

Profiles are `research`, `coding`, `review`, and `minimal`. Pi enforces profile tool-schema allowlists and blocks recursive orchestration. These are tool-policy controls, not OS sandboxing. Children run with the permissions described by `subagent_spawn`.

A structured report contract is appended to the child **user task**, never to the parent system prompt. Reports must name files, decisions/risks, validation, and artifacts. Live Pi-child messages are capped at 4,096 characters.

Final reports are capped by explicit pressure/profile byte budgets. Larger material stays in the child transcript; automatic completions continue through `context-output` with the transcript path as an external artifact reference. Explicit waits also honor each child's report budget and remain eligible for normal `context-output` brokerage.

## Waiting for results

`subagent_spawn` is fire-and-forget: the parent should normally keep working and let the settled result arrive automatically. `subagent_wait(ids)` is an explicit synchronization barrier for cases where the parent cannot continue without one or more child results. It blocks until every requested child settles, reports pending progress, respects cancellation of the wait, and consumes the waited-for deliveries so they are not injected a second time automatically. Cancelling the wait does not cancel the children. Returned output is pressure/profile-budgeted and context-brokered; full material remains in the Pi child transcript.

## Development

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
