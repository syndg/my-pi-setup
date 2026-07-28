# Context Maintenance

Wave 4 integration policy for explicit Red-pressure/manual maintenance. The module keeps Pi overflow recovery native and never autonomously decays, compacts, hands off, or replaces a session.

## Command

```text
/context-maintain
/context-maintain decay
/context-maintain checkpoint <exact next action>
/context-maintain handoff <exact next action>
/context-maintain compact [instructions]
/context-maintain ignore-once
```

With dialog-capable UI, the argument-free command presents the Phase 5 choices in contract order. Escape/input cancellation has no side effects. In print/JSON modes an explicit action argument is required; the command never invokes a dialog. `checkpoint` and `handoff` require an exact next action. Checkpoint, handoff, and compact wait for idle and reject active or uncertain background/subagent work.

- **Decay** requests the authoritative context-decay controller over a validated event-bus seam. It is denied unless `context-decay` privately opts in; no duplicate controller is installed.
- **Checkpoint** reuses the `context-handoff` deep manager to validate and atomically persist a non-context checkpoint.
- **Handoff** remains explicit and uses the existing controlled handoff manager, confirmation, prewrite, and rollback behavior.
- **Compact** calls `ctx.compact()` only from that explicit command action. The installed `context-compaction` adapter owns checkpoint-shaped manual compaction and native fallback; this policy never intercepts threshold or overflow reasons.
- **Ignore once** appends only a small `context-maintenance/ignore-once-v1` custom entry, which is not sent to the model. It suppresses the current high-pressure episode and resets after configured settled-run hysteresis or pressure escalation.

## Pressure transitions

Governor state is sampled only at `agent_settled`. Upward Orange/Red transitions are edge-triggered; downward recovery requires multiple settled observations. A Red/Emergency transition recommends `/context-maintain`, but selects nothing.

Automatic pressure checkpoints are implemented but **off by default**. When explicitly enabled, they are validated, durable, bounded, non-context, and fail open.

## Private configuration

Path: `~/.pi/agent/context-maintenance/config.private.json`

```json
{
  "choices": {
    "decay": true,
    "checkpoint": true,
    "handoff": true,
    "compact": true,
    "ignore-once": true
  },
  "automaticCheckpoint": {
    "enabled": false,
    "levels": ["orange", "red"],
    "minimumIntervalMs": 900000,
    "maximumPerSession": 4
  },
  "recoverySettledRuns": 2,
  "decay": {
    "protectedRecentTokens": 20000,
    "oldLargeResultTokens": 4000,
    "minimumReplacementSavingsTokens": 128,
    "maximumWireTokens": null,
    "pinnedIdentities": []
  }
}
```

Automatic decay is hard-disabled. Explicit decay requires `allowExplicitApply: true` in `~/.pi/agent/context-decay/config.private.json`. Invalid fields fall back independently to safe defaults.

## Validation

No install or build is required:

```bash
node --test --experimental-strip-types *.test.ts
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
