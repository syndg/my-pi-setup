# Context Governor

Advisory-only context pressure telemetry for Pi.

## Behavior

The extension tracks:

- current context usage and measurement provenance;
- the active runtime-resolved native compaction threshold/provenance when available, with settings-file fallback for older Pi distributions;
- a fallback advisory limit used only when native proactive compaction is disabled or unavailable;
- latest and EWMA run growth, plus P95 after enough clean samples;
- projected similar runs remaining, with Orange/Red runway escalation gated on enough clean samples;
- pressure level and reasons;
- tool-result bytes by tool for the latest settled run.

Request-time pressure instructions are retired. The footer and `/context-status` provide observability without adding model-visible messages.

The extension does not compact, prune, block, cap, or rewrite stored history.

A run settlement contributes growth only when it has a trustworthy positive run-start comparison baseline. A rejected warm-up still establishes an endpoint baseline for a later run. Compaction starts a new comparison generation and clears pre-compaction latest/EWMA/P95 velocity and runway; occupancy, headroom, and accepted large-run signals remain immediate.

## Commands

```text
/context-status
```

Shows the current governor report without adding a model-visible or durable session message.

## Configuration

Optional private configuration:

```text
~/.pi/agent/context-governor/config.private.json
```

Example:

```json
{
  "advisorySafePercent": 70,
  "historyLength": 20,
  "ewmaAlpha": 0.35,
  "conservativeQuantile": 0.95,
  "minimumP95Samples": 5,
  "minimumRunwaySamples": 3,
  "yellowContextRatio": 0.5,
  "yellowAbsoluteTokens": 150000,
  "largeRunTokens": 20000,
  "largeRunSafeFraction": 0.1,
  "orangeRunwayBelow": 2,
  "orangeSafeLimitRatio": 0.85,
  "redRunwayBelow": 1,
  "redSafeLimitRatio": 0.95,
  "emergencyMarginTokens": 8192,
  "recoveryRuns": 2,
  "notice": {
    "enabled": false,
    "maxCharacters": 320
  },
  "footer": {
    "enabled": true,
    "mode": "compact"
  },
  "telemetry": {
    "enabled": true,
    "maxRecords": 200,
    "maxBytes": 524288
  }
}
```

Malformed or missing values fall back independently to defaults.

## Limits

The governor duck-types `getContextUsage().compactionThreshold` and `source` so a newly rebuilt Pi can provide the active resolved threshold and usage provenance without making this extension incompatible with an older installed distribution. Runtime threshold data wins over settings reconstruction when structurally valid; otherwise merged global/project settings are read through a read-only `SettingsManager` and labeled `settings-file-derived`. Malformed settings remain unavailable.

`pi-usage` is Pi's composite usage measurement. When a newer runtime supplies `source`, `/context-status` includes that bounded provenance label. Immediately after compaction or model changes, the governor uses a separately labeled `message-estimate` when Pi's measurement is unavailable or stale.

## Telemetry

Bounded metrics-only JSONL files are written under:

```text
~/.pi/agent/context-governor/telemetry/
```

Files are scoped by session and writer process. Records contain event kind, comparison generation/reset reason, run-start baseline, peak, endpoint, sample acceptance, and aggregate governor metrics. They contain no message bodies, tool arguments, result content, credentials, or raw paths.

## Development

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
