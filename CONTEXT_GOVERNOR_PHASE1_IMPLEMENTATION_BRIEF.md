# Phase 1 Context Governor Implementation Brief

## Status

Wave 0 and Wave 1 implementation are complete. This brief preserves the historical Phase 1 contracts, ownership boundaries, and exit labels; it is no longer the program-wide implementation frontier.

The advisory Context Governor remains non-enforcing. The first real-telemetry observation window confirmed bounded private telemetry and notice non-persistence but **did not pass Gate B**: warm-up growth, early P95/runway use, and retained pre-compaction velocity produced untrustworthy pressure. Source fixes now reject untrustworthy warm-up samples, gate P95/runway on clean history, reset velocity at compaction, and record metrics-only comparison audit fields. A second representative observation window is required.

Phases 2–9 are now implemented in source behind safe defaults: output budgeting is shadow, decay mutation is disabled, checkpoint/handoff is manual, custom compaction remains native by default, memory mutation is human-only, and Phase 9 has offline adapters with no default. Phase 3 deferred activation is enabled. Phase 0/7 fork source has been built and startup-smoke-tested; reload is required for the running Pi process.

## Scope

**Historical Phase 1 boundary (preserved):** implement **Phase 1 — Advisory Context Governor only**:

- context usage, growth, safe headroom, and runway telemetry;
- one authoritative pressure calculation;
- a non-persistent model notice at Yellow and above;
- footer presentation;
- `/context-status`;
- bounded external telemetry;
- tests.

Later-phase source may be implemented behind safe defaults, but **do not enable output caps, automatic context decay, custom compaction, blocking, or automatic maintenance until their gates pass**. Artifact recall and explicit manual checkpoint/handoff may remain available without enabling enforcement.

## Architectural decision

Create a standalone global extension:

```text
/Users/syndg/.pi/agent/extensions/context-governor/
```

Do not expand `shared/context-utilization.ts`; it remains a narrow formatter used by child-agent extensions.

The governor is a deep in-process module with one state-transition interface. Pi lifecycle, settings, telemetry, model notice, and footer integration are thin adapters.

The authoritative mutable governor state remains inside the `context-governor` extension closure. Cross-extension sharing uses immutable snapshots over `pi.events`; imported mutable module state is not reliable because each extension is loaded through a fresh jiti loader.

## Core contract

```ts
export type PressureLevel =
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "emergency";

export type MeasurementSource =
  | "pi-usage"
  | "message-estimate"
  | "unknown";

export interface ContextMeasurement {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly source: MeasurementSource;
  readonly unknownReason?:
    | "post-compaction"
    | "model-changed"
    | "no-model"
    | "usage-unavailable";
}

export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

export interface ResolvedBudget {
  readonly nativeLimitTokens: number | null;
  readonly nativeSource:
    | "threshold-percent"
    | "reserve-tokens"
    | "disabled"
    | "unavailable";
  readonly nativeProactiveEnabled: boolean;
  readonly advisoryLimitTokens: number | null;
  readonly effectiveSafeLimitTokens: number | null;
  readonly effectiveSource:
    | "governor-percent"
    | "native-limit"
    | "minimum-of-governor-and-native"
    | "unavailable";
}

export type GovernorEvent =
  | { readonly kind: "session-start" }
  | { readonly kind: "run-start"; readonly runId: string }
  | { readonly kind: "sample" }
  | { readonly kind: "run-settled"; readonly runId: string }
  | { readonly kind: "compaction"; readonly reason: "manual" | "threshold" | "overflow" }
  | { readonly kind: "tree-reset" }
  | { readonly kind: "model-reset" }
  | { readonly kind: "emergency"; readonly reason: "provider-overflow" | "maintenance-failed" };

export interface GovernorSnapshot {
  readonly capturedAtMs: number;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly model: ModelIdentity | null;
  readonly measurement: ContextMeasurement;
  readonly budget: ResolvedBudget;
  readonly event: GovernorEvent;
  readonly toolResultBytesByTool?: Readonly<Record<string, number>>;
}

export interface GovernorState {
  readonly capturedAtMs: number;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly model: ModelIdentity | null;
  readonly measurement: ContextMeasurement;
  readonly budget: ResolvedBudget;
  readonly headroomTokens: number | null;
  readonly safeLimitRatio: number | null;
  readonly growth: {
    readonly latestTokens: number | null;
    readonly ewmaTokens: number | null;
    readonly p95Tokens: number | null;
    readonly conservativeTokens: number | null;
    readonly sampleCount: number;
  };
  readonly runwayRuns: number | null;
  readonly pressure: {
    readonly level: PressureLevel | null;
    readonly reasons: readonly string[];
  };
  readonly toolResultBytesByTool: Readonly<Record<string, number>>;
}

export interface ContextGovernor {
  observe(snapshot: GovernorSnapshot): Readonly<GovernorState>;
  current(): Readonly<GovernorState>;
}
```

The exact implementation may refine field names for TypeScript ergonomics, but adapters must not calculate pressure independently.

## Measurement semantics

`ctx.getContextUsage()` is not purely provider-observed. It uses the latest valid assistant usage and may add locally estimated trailing messages. Label it `pi-usage`, not `observed`.

When Pi reports `tokens: null`, estimate the current message payload with Pi's exported `estimateTokens()` and label it `message-estimate`. This estimate does not include the complete fixed system/tool/skill overhead and must remain visibly estimated.

Use `unknown` when neither measurement is defensible. Unknown pressure is `null`, never Green.

Reject stale usage across model identity or context-window changes. Compare provider, model ID, and context window at every sample instead of relying only on `model_select`.

## Budget resolution

Use a read-only settings adapter based on exported `SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })`. This preserves native global/project merge and normalization semantics without exposing `SettingsManager` through the governor interface.

Resolve the native proactive limit exactly:

```text
valid thresholdPercent:
  floor(contextWindow × clamp(percent, 1, 99) / 100)

otherwise:
  contextWindow - reserveTokens
```

The governor also has an independent advisory ceiling, default 70% of the model window. This allows early warning even while the installed native runtime still uses the legacy reserve cliff.

```text
advisoryLimit = floor(contextWindow × advisorySafePercent / 100)

effectiveSafeLimit =
  native proactive disabled ? advisoryLimit
  : min(advisoryLimit, nativeLimit)
```

`/context-status` must report native and advisory limits separately. Footer and pressure calculations use the effective safe limit.

## Growth and runway

An umbrella run opens at `before_agent_start`; `agent_start` is a fallback when no run is open. Subsequent retry/continuation `agent_start` events do not reset the baseline. The run closes only at `agent_settled`.

Capture measurements at each `context` call and at `agent_end` so a pre-compaction peak is not lost. Finalize growth only when baseline and peak are comparable within the same session/model context epoch.

```text
growth = maxKnownRunTokens - baselineTokens
```

Reject negative or cross-epoch deltas rather than recording zero.

Defaults:

```text
historyLength = 20
ewmaAlpha = 0.35
conservativeQuantile = 0.95

EWMA₁ = growth₁
EWMAₙ = alpha × growthₙ + (1 - alpha) × EWMAₙ₋₁
P95 = nearest-rank(history, 0.95)
conservativeGrowth = max(latest, EWMA, P95)

runway = headroom / conservativeGrowth
```

No valid growth samples means runway is unknown, not infinite.

## Pressure defaults

These are observation-window tuning defaults:

```text
yellowContextRatio = 0.50
yellowAbsoluteTokens = 150000
largeRunTokens = 20000
largeRunSafeFraction = 0.10

orangeRunwayBelow = 2
orangeSafeLimitRatio = 0.85

redRunwayBelow = 1
redSafeLimitRatio = 0.95
emergencyMarginTokens = 8192
recoveryRuns = 2
```

Highest severity wins:

```text
Emergency:
  explicit provider overflow or maintenance failure

Red:
  headroom <= 0
  OR headroom <= emergencyMarginTokens
  OR runway < 1
  OR safeLimitRatio >= 0.95

Orange:
  runway < 2
  OR safeLimitRatio >= 0.85

Yellow:
  contextWindowRatio >= 0.50
  OR tokens >= 150000
  OR latestGrowth >= min(20000, effectiveSafeLimit × 0.10)

Green:
  otherwise
```

Upgrades are immediate. Downgrades occur only after two consecutive settled runs producing a lower candidate. Emergency clears on successful compaction or a hard session/model/tree reset.

## Lifecycle mapping

| Pi seam | Governor action |
|---|---|
| `session_start` | Hard reset, load config, initialize identity and measurement |
| `before_agent_start` | Open umbrella run and capture baseline |
| `agent_start` | Fallback-open only; do not reset an open run |
| `context` | Refresh settings and measurement, sample state, append one advisory notice to this outgoing deep copy at Yellow+ |
| `turn_end` | Accumulate finalized tool-result UTF-8 bytes by tool |
| `agent_end` | Capture pre-maintenance peak usage |
| `session_before_compact` | Record overflow Emergency only; return nothing |
| `session_compact` | Mark successful context reset and post-compaction estimate/unknown state |
| `agent_settled` | Finalize one run, publish state, write one bounded telemetry record |
| `model_select` | Start a new model epoch and clear incomparable history |
| `session_tree` | Hard context/history reset for the new active branch |
| `session_shutdown` | Flush telemetry, clear UI state, release listeners |

Manual compaction may not produce `agent_settled`; publish immediately on `session_compact`.

Session replacement creates a fresh extension instance. Phase 1 does not restore growth forecasting from telemetry on resume/reload.

After compaction, preserve older growth history for forecasting but clear the current baseline and `latestGrowth`. First defensible post-compaction usage rebases the measurement.

**Post-observation amendment:** the first window showed that retaining pre-compaction velocity caused low-occupancy sessions to remain Red. Current source starts a new comparison generation at compaction and clears latest/EWMA/P95/runway history; clean post-compaction settlements rebuild forecasting. The historical rule above is preserved as the original Phase 1 boundary, not current behavior.

## Ephemeral notice

Use only the `context` event. Return a new messages array with one appended hidden custom message:

```ts
{
  role: "custom",
  customType: "context-governor-advisory",
  content: noticeText,
  display: false,
  timestamp: Date.now(),
}
```

Pi converts the custom message to a provider user message. The source context is a deep clone, so it does not enter agent state or JSONL.

Append one notice to every outgoing context copy at Yellow and above, as required by the plan. Do not use `before_agent_start.message`, `sendMessage()`, or system-prompt mutation.

Example:

```text
Context budget: 157k/272k; safe 190k; +31k last run; ~1.1 similar runs remain (orange).
For this turn: avoid broad parent-session searches, delegate exploration, and request bounded slices.
```

## Shared state and UI

Create:

```text
/Users/syndg/.pi/agent/extensions/shared/context-governor-state.ts
```

It owns only:

- state DTO types;
- channel constants;
- runtime validator;
- empty snapshot helper.

Channels:

```text
dashboard:context-governor
dashboard:refresh
```

The governor publishes immutable snapshots. `ui-customization` remains the sole custom-footer owner and subscribes to governor state. It must not recalculate pressure.

Keep `model-info` responsible for provider/model/thinking/cost/TPS/generation only. During Phase 1 integration, remove its context fields from the dashboard DTO to avoid two competing context sources.

Footer target:

```text
157k/272k · safe 190k · +31k · ~1.1 runs · orange
```

A pure formatter must degrade deterministically at narrow widths and never exceed the provided visible width.

## `/context-status`

Register in `context-governor/index.ts`. It reports from the same immutable state used by the notice and footer:

- model and window;
- current tokens, percent, and measurement source;
- native proactive threshold and source;
- advisory/effective safe limit;
- signed headroom;
- latest, EWMA, P95, and conservative growth;
- projected runway;
- pressure level and reasons;
- tool-result bytes by tool for the latest settled run;
- config and telemetry paths.

Use non-persistent UI output. Do not append a context-bearing message or durable session entry.

## Configuration

Exact path:

```text
~/.pi/agent/context-governor/config.private.json
```

Use `getAgentDir()`. Validate defensively and fall back to documented defaults. Writes, if later added, must be atomic and mode 0600. Phase 1 only needs read support.

Configuration sections:

- engine thresholds and history;
- advisory safe percentage;
- notice enabled and wording budget;
- footer enabled/format mode;
- telemetry enabled and bounds.

## Telemetry

Exact directory:

```text
~/.pi/agent/context-governor/telemetry/
```

Store session-ID-scoped JSONL. Default telemetry is enabled for the observation window.

Each record contains only:

- timestamp and session ID;
- branch leaf;
- model/window;
- measurement and provenance;
- safe limits/headroom;
- growth/runway;
- pressure and reasons;
- tool-result byte totals by tool.

Never store message bodies, tool arguments, result content, credentials, or raw paths. Bound each file by both record count and bytes; rotate or compact atomically. Telemetry failure is fail-open and never changes model behavior.

## Files and ownership

### Integration owner — shared contracts and wiring

- `shared/context-governor-state.ts`
- `shared/dashboard-state.ts`
- `model-info/index.ts`
- `ui-customization/index.ts`
- `/Users/syndg/.pi/agent/tsconfig.json` if required to make declared extension checks runnable
- final documentation and cross-extension validation

### Lane 1 — pure engine and config

- `context-governor/src/governor.ts`
- `context-governor/src/config.ts`
- `context-governor/governor.test.ts`
- `context-governor/config.test.ts`
- package manifest and package-local TypeScript config

Must not edit lifecycle or footer files.

### Lane 2 — lifecycle, measurement, notice, telemetry

- `context-governor/index.ts`
- `context-governor/src/measurement.ts`
- `context-governor/src/telemetry.ts`
- `context-governor/src/status-report.ts`
- `context-governor/lifecycle.test.ts`
- `context-governor/telemetry.test.ts`

Must consume the fixed governor contract and must not recalculate pressure.

### Lane 3 — footer formatter

- `ui-customization/src/context-footer.ts`
- `ui-customization/context-footer.test.ts`

Must consume the published governor state and must not edit the existing footer entry point.

### Lane 4 — read-only review

Review lifecycle ordering, persistence, model/compaction/tree resets, child-session behavior, and test coverage. No implementation edits.

## Required tests

### Engine contract

1. Percentage/reserve/native-disabled/advisory budget resolution.
2. Known, estimated, and unknown measurements.
3. First run, exact delta, zero growth, negative discontinuity, missing endpoint.
4. Duplicate settlement idempotency and bounded history.
5. EWMA, nearest-rank P95, and conservative growth.
6. Runway with positive, zero, negative, and unknown inputs.
7. All pressure boundaries and severity precedence.
8. Immediate upgrades and two-settle downgrade hysteresis.
9. Session/model/tree/compaction reset matrix.
10. Compaction during a run never creates a cross-epoch delta.

### Adapter contract

1. Green and unknown omit the notice.
2. Yellow+ appends exactly one notice to each outgoing copy.
3. Input messages remain unchanged and no session/custom entry is created.
4. Tool bytes are counted once independent of parallel completion order.
5. Retry/follow-up sequences produce one settled run sample.
6. Pre-compaction peak is captured; post-compaction state is estimated/unknown.
7. Model identity/window changes invalidate stale usage.
8. Config/telemetry failures are fail-open.

### UI contract

1. Footer and `/context-status` use the same published state.
2. Unknown and estimated labels are explicit.
3. Every rendered line fits narrow widths.
4. Pressure coloring/labels are deterministic.

## Validation commands

No build and no full test suite.

Run:

```text
node --test --experimental-strip-types *.test.ts
```

inside the new extension and affected extension packages, plus their declared TypeScript checks. The shared TypeScript configuration issue from the original brief has since been resolved.

For any fork test added later, run only the specific Vitest file according to repository rules. Run `npm run check` in the fork only if fork source is changed. Finish with worktree and diff review.

## Wave 1 exit gate

The historical Phase 1 boundary remains:

- Advisory telemetry is implemented and tested.
- Model-visible warnings are request-only and non-persistent.
- Footer and `/context-status` agree.
- Phase 1 itself performs no enforcement or automatic maintenance; later-phase source must retain gated defaults.
- Phase 0/7 fork source and the pre-existing fullscreen/selection changes were preserved, built, and included in the authorized publication.
- The rebuilt CLI passed a startup smoke test; reload is required for the current process.
- The first real-session observation failed Gate B; the implemented governor fixes require a second representative observation window before enforcement is enabled.
