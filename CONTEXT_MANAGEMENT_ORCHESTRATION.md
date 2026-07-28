# Pi Context Management Orchestration

## Purpose

This document defines how to execute the implementation in [`CONTEXT_MANAGEMENT_PLAN.md`](./CONTEXT_MANAGEMENT_PLAN.md): dependency order, parallel workstreams, integration ownership, validation gates, and fresh-session resume instructions.

The plan document defines **what** to build. This document defines **how to coordinate the work**.

## Current status

- Waves 0–6 and Phases 2–9 are **implemented in source**. This means modules, adapters, and focused contract tests exist; it does not mean gated enforcement or real-provider rollout validation has passed.
- Phase 3 additive deferred activation is enabled. Phase 2 remains shadow; Phase 4 mutation and explicit apply remain disabled; Phase 5 manual checkpoint/handoff is available while automatic checkpoints are disabled; Phase 6 remains native by default with custom reasons disabled; Phase 8 memory mutations are human-only; Phase 9 adapters are offline/no-default.
- The first real Governor observation window completed and failed Gate B. Governor fixes for warm-up sampling, minimum P95/runway history, post-compaction velocity reset, and auditable telemetry fields are implemented. **Gate B remains open until a second observation window validates those fixes and missing model-switch/resume/branch scenarios.**
- Phase 0 and required Phase 7 core hardening are implemented and built in the personalized fork. The rebuilt `pi-mono-fullscreen/packages/coding-agent/dist/cli.js` passed a startup smoke test; reload is required for the running process to observe it.
- The personalized fork's pre-existing fullscreen/selection work was preserved and published with the authorized changes.
- The explicit build and publication authorization has been consumed; future builds or policy activation still require their own instruction.

## Repositories

- Plan and orchestration: `/Volumes/External/Coding/my-pi-setup`
- Personalized Pi fork: `/Volumes/External/Coding/pi-mono-fullscreen`
- User extensions: `/Users/syndg/.pi/agent/extensions`
- OMP reference: `/Volumes/External/Coding/oh-my-pi`

## Parallelization summary

Historical implementation estimate (retained for future change planning):

- **60–70%** of coding and testing can run in parallel after shared interfaces are fixed.
- **30–40%** lies on the sequential critical path.
- Use at most **three implementation lanes plus one review lane**.
- Expect roughly **1.5–1.8× elapsed-time improvement**, not linear speedup.

The remaining sequential spine is rollout and evidence, not source implementation:

```text
authorize/build Phase 0 + Phase 7 core source
  → smoke-test native defaults and extension compatibility
  → run the second Governor observation window
  → close Gate B only on trustworthy measurements
  → review Phase 2 shadow output and artifact durability
  → opt into decay/checkpoint/compaction in reversible order
  → validate memory/cache behavior
  → opt into provider-backed experiments only if justified
```

## Dependency graph

```text
Source implementation
  Phase 0 ✓ (core, built)
  Phase 1 ✓ + first observation ✗ + fixes ✓
  Phases 2–6 ✓ (safe defaults)
  Phase 7 ✓ (core, built)
  Phases 8–9 ✓ (advisory/offline defaults)
                 │
                 ▼
Reload rebuilt Pi runtime
                 │
                 ▼
Second Governor observation → Gate B remains OPEN until passed
                 │
        ┌────────┴────────┐
        ▼                 ▼
 Phase 2 shadow      Phase 3 deferred activation
 review/recall       already enabled; measure provider effects
        │
        ▼
 Conservative output enforcement opt-in
        │
        ▼
 Phase 4 shadow review → explicit decay → automatic decay
        │
        ▼
 Manual checkpoint/handoff continuation validation
        │
        ▼
 Manual custom compaction → threshold custom compaction
        │
        ▼
 Phase 8 rollout checks → explicit Phase 9 provider experiments
```

Dependencies still constrain **activation and validation** even though downstream source was developed behind shadow/native/disabled defaults. Source completion does not close Gates B–H.

## Orchestration principles

### One integration owner

The main agent owns:

- shared interfaces;
- architectural decisions;
- shared configuration;
- event ordering;
- final wiring;
- cross-module tests;
- validation commands;
- updates to the plan and orchestration documents.

Subagents must not independently change shared contracts after implementation begins. Proposed contract changes return to the integration owner for approval.

### Disjoint writer ownership

Agents may write concurrently only when they own disjoint files or directories. Avoid two agents editing:

- the same extension entry point;
- shared configuration;
- the same tests;
- interactive mode wiring;
- changelog sections;
- the existing dirty fullscreen files.

When file ownership cannot be separated, one agent implements and another performs a read-only review.

### Contract-first fan-out

Before parallel implementation, define the smallest deep-module interfaces needed by callers and tests. Candidate interfaces:

```ts
type PressureLevel = "green" | "yellow" | "orange" | "red" | "emergency";

interface ContextGovernor {
  observe(snapshot: GovernorSnapshot): GovernorState;
}

interface OutputBroker {
  process(request: OutputRequest): Promise<OutputEnvelope>;
}

interface ContextArchive {
  store(output: ArchivableOutput): Promise<ArtifactReference>;
  recall(request: RecallRequest): Promise<RecallResult>;
}

interface ContextDecay {
  transform(context: ActiveContext, policy: DecayPolicy): DecayedContext;
}

interface CheckpointManager {
  create(source: CheckpointSource): Promise<Checkpoint>;
  validate(checkpoint: Checkpoint): CheckpointValidation;
}
```

These are conceptual starting points, not pre-approved final TypeScript. The implementation owner must inspect existing extension conventions before fixing exact types.

### Deep modules, thin adapters

Keep policy and calculations behind small interfaces. Pi lifecycle, TUI, tool, filesystem, and provider integrations should be adapters at clean seams. Unit tests exercise the same interface callers use.

### Bounded agent reports

Every delegated task should request:

- concise findings;
- exact files changed or reviewed;
- decisions and unresolved risks;
- validation commands and outcomes;
- no pasted broad source listings;
- no unrelated edits;
- no commit or build unless authorized.

### Parent-controlled synthesis

Subagents cannot coordinate directly. The parent integrates outputs, resolves conflicts, and starts the next dependency wave.

## Mandatory sequential gates

The gates below now govern build/activation/promotion rather than whether downstream source files may exist. Later-phase infrastructure may be implemented behind safe defaults; **do not enable enforcement until its prerequisite gates pass**.

### Gate A — Shared vocabulary and contracts

Before Phase 1 fan-out, define:

- `GovernorSnapshot`;
- `GovernorState`;
- `ContextMeasurement` and provenance;
- `PressureLevel`;
- pressure threshold semantics;
- session reset and model-switch behavior;
- public-versus-private configuration.

No UI or event adapter should invent separate pressure calculations.

### Gate B — Advisory measurement validation

Phase 1 must run in advisory mode through representative sessions before enforcement is enabled. Validate:

- provider usage versus estimated resident usage;
- latest-run delta accuracy;
- compaction reset behavior;
- context-window and model changes;
- runway usefulness;
- notice persistence behavior;
- telemetry overhead.

Phase 2 infrastructure has been implemented behind shadow/default-disabled enforcement during this period; adaptive limits must not be enabled until Gate B passes.

**Current Gate B status:** open/not passed. The first window is recorded in [`docs/context-governor-observation.md`](./docs/context-governor-observation.md). Implemented governor fixes require a second representative window before adaptive limits or decay are enabled.

### Gate C — Baseline capture

Record fixed prompt and schema overhead before Phase 3 changes tool/skill exposure. Without this baseline, Phase 3 cannot be evaluated.

**Current Gate C status:** the reproducible offline schema/catalog baseline and Phase 3 post-change measurement are recorded in [`docs/context-overhead-baseline.md`](./docs/context-overhead-baseline.md). Provider tokenizer, cache, billing, and latency measurements remain rollout evidence, not completed validation.

### Gate D — Artifact durability

Before Phase 4 can elide content, Phase 2 must guarantee that complete oversized output is written and recallable. No outgoing-context replacement may point at a nonexistent artifact.

### Gate E — Checkpoint schema stability

Phase 5 handoffs and Phase 6 compaction must share one checkpoint representation. Stabilize and test the schema before building production orchestration around it.

### Gate F — Handoff before compaction replacement

A validated fresh-session handoff must exist before replacing native compaction. Handoff is the non-lossy escape route and rollback path.

### Gate G — Integrated maintenance policy

Only after decay, recall, checkpoint, handoff, and summarization interfaces are stable should Red-pressure choices be integrated into one policy.

### Gate H — Final integration validation

The integration owner verifies:

- event order;
- transcript invariants;
- tool-call/result pairing;
- provider-valid context ordering;
- configuration migrations;
- footer and command behavior;
- compaction interactions;
- prompt-cache stability;
- overflow fallback;
- unrelated dirty changes remain intact.

## Execution waves

---

## Wave 0 — Re-ground and lock Phase 1 contracts

**Source state:** complete. The implementation brief and ownership map were produced; retain this wave as historical execution context, not a restart instruction.

### Sequential owner

Main agent.

### Work

1. Read both planning documents completely.
2. Read relevant Pi extension documentation completely and follow cross-references.
3. Audit current `model-info`, `ui-customization`, `summaries`, and shared context-utilization modules.
4. Decide whether the governor should have a new shared module or extend the existing shared context utility.
5. Define the Phase 1 interface, event lifecycle, configuration, and test seam.
6. Assign disjoint file ownership for Wave 1.

### Deliverable

A short implementation brief listing:

- exact module/interface;
- exact event sources;
- exact configuration path;
- exact output adapters;
- exact test files;
- file ownership by lane.

### Exit gate

No unresolved disagreement about pressure semantics or measurement provenance.

---

## Wave 1 — Phase 1 Advisory Context Governor

**Source state:** complete in advisory-only mode. The first observation failed Gate B, subsequent governor fixes are in source, and the required next step is the second observation window—not another Wave 1 implementation pass.

### Lane 1 — Pure governor engine

Owns a new isolated module and unit tests.

Responsibilities:

- utilization and headroom;
- resolved safe limit input;
- recent growth history;
- EWMA and conservative growth estimate;
- runway calculation;
- pressure transitions;
- observed/estimated provenance;
- post-compaction unknown state;
- model/session reset;
- configuration normalization.

Must not edit TUI or lifecycle wiring.

### Lane 2 — Pi lifecycle adapter

Owns extension event integration.

Responsibilities:

- session start/switch/reset;
- agent run start/end;
- provider usage observation;
- tool-result byte totals;
- non-persistent `context` notice;
- bounded telemetry persistence;
- confirmation that notices never enter JSONL.

Must consume governor state rather than recalculate it.

### Lane 3 — Human UI adapter

Owns custom footer and command integration.

Responsibilities:

- compact footer state;
- narrow-terminal behavior;
- `/context-status`;
- observed-versus-estimated labels;
- status colors and wording;
- UI tests.

Must consume governor state rather than recalculate it.

### Lane 4 — Read-only review and fixtures

Responsibilities:

- inspect Pi lifecycle edge cases;
- enumerate tests for model switching, compaction, branching, and session resume;
- review interfaces for depth and locality;
- report risks without editing shared implementation files.

### Sequential integration

The main agent:

1. reviews all lane outputs;
2. reconciles lifecycle assumptions;
3. wires shared state;
4. runs focused tests and type checks;
5. performs transcript-persistence verification;
6. documents configuration and behavior.

### Wave 1 exit criteria

- Governor calculations, notices, footer, command, and telemetry source are implemented.
- Model warning appears only at Yellow or above and is non-persistent.
- Footer and `/context-status` use the same governor state.
- Phase 1 contains no enforcement.
- The first observation window completed but did not validate measurement quality; the second window is now required for Gate B.

---

## Second observation window — mandatory sequential gate

Run the fixed Phase 1 governor through a second set of representative sessions. The first window is historical evidence and did not pass Gate B:

- normal editing;
- broad file searches;
- subagent-heavy work;
- background process work;
- compaction;
- model switching;
- session resume and branching.

Record:

- context before/after each run;
- tool-result bytes by source;
- pressure level;
- projected versus actual runway;
- false-positive and false-negative warnings;
- prompt-cache behavior where visible.
- explicit confirmation that warm-up settlements are rejected, P95/runway wait for clean samples, and pre-compaction velocity does not contaminate post-compaction pressure;
- at least one real model/window switch, resumed session with another writer, actual branch/fork, and post-compaction follow-up sequence.

Do not enable Phase 2 caps or Phase 4 decay during this window.

---

## Wave 2 — Parallel foundations

**Source state:** complete behind safe defaults. Gate B and Gate C now govern rollout/evaluation, not whether this source may exist.

### Lane 1 — Phase 2 output broker and artifact store

Responsibilities:

- artifact path and metadata format;
- atomic write behavior;
- UTF-8-safe shortening;
- synopsis and retrieval envelope;
- secret-redaction seam;
- pressure-to-budget policy;
- failure behavior;
- unit tests.

Adapter fan-out was intentionally deferred until the broker contract was fixed.

### Lane 2 — Phase 3 fixed-overhead reduction

Responsibilities:

- deferred orchestration tool audit;
- tool-schema and prompt-description measurement;
- skill-catalog measurement;
- child tool-profile design;
- baseline comparison.

Initial changes should remain narrowly scoped and independently reversible.

### Lane 3 — Phase 5A checkpoint core

Responsibilities:

- checkpoint schema;
- validator;
- serialization;
- summary recap consolidation input;
- fixtures;
- omission and malformed-output tests.

Do not create sessions or intercept compaction yet.

### Lane 4 — Early Phase 7 investigation

Read-only unless a core gap is proven.

Investigate:

- resolved-threshold helper reuse;
- context-breakdown availability;
- usage provenance;
- post-compaction continuity.

Recommend only the smallest core change extensions cannot implement reliably.

### Sequential integration

- Approve artifact and checkpoint formats.
- Confirm Phase 3 baseline measurements.
- Decide whether any Phase 7A core work is necessary.
- Keep all enforcement disabled by default.

---

## Wave 3 — Parallel adapters and prototypes

**Source state:** complete. Phase 2 adapters run in shadow, Phase 4 emits shadow accounting with mutation disabled, manual Phase 5 checkpoint/handoff is available, and Phase 6 source remains disconnected from custom behavior by native-default configuration.

### Lane 1 — Phase 2 tool adapters

After the output-broker interface is stable, split adapters by disjoint files:

- `read`;
- `rg`/`fd`;
- MCP;
- subagents;
- background terminals;
- workflows.

If file ownership overlaps, process adapters in batches instead of concurrently.

### Lane 2 — Phase 4 decay and recall in shadow mode

Responsibilities:

- candidate classification;
- protected working set;
- deterministic placeholders;
- stable decay epochs;
- pairing/order invariants;
- `context_recall`;
- resident/wire accounting;
- shadow report of proposed elisions.

No automatic wire-context mutation until shadow results pass review.

### Lane 3 — Phase 5B handoff

Responsibilities:

- checkpoint triggers;
- fresh-session bootstrap;
- original-session pointer;
- artifact references;
- cancellation and rollback;
- active child/background handling;
- continuation-quality fixtures.

### Lane 4 — Phase 6A summary-engine prototype

Responsibilities:

- checkpoint-shaped summary prompt;
- dedicated model adapter;
- previous-summary merge;
- validation and optional verifier;
- malformed-output fallback;
- fixture-based continuation evaluation.

The Phase 6A prototype did not intercept native compaction; the later production adapter is registered but all custom reasons default off.

### Sequential rollout integration

- After Gate B, enable Phase 2 conservatively and compare growth metrics against the Phase 1 baseline.
- Review Phase 4 shadow output before privately enabling explicit `/context-decay apply`; automatic decay is a later, separate opt-in.
- Validate manual checkpoint/handoff continuation before any custom compaction reason is enabled.
- Keep Phase 6 on native compaction until manual custom-compaction rollout is explicitly authorized.

---

## Wave 4 — Integrated maintenance policy

**Source state:** complete. `/context-maintain` integrates explicit choices without autonomous action; automatic checkpoints are disabled, explicit decay is denied without private opt-in, and custom compaction reasons remain disabled so native Pi owns compaction. The order below is the recommended activation order.

This wave is integration-heavy and mostly sequential.

### Recommended activation order

1. Enable explicit/manual context decay only after shadow and recall review.
2. Validate bounded recall.
3. Privately enable checkpoint creation at pressure transitions only after manual checkpoint evidence.
4. Validate fresh-session handoff continuation.
5. Exercise the Red-pressure choice UI/policy without auto-selecting an action.
6. Enable custom compaction for manual reason first.
7. Add threshold-triggered custom compaction only after manual evidence.
8. Keep overflow custom handling experimental and preserve native fallback.
9. Build and validate required Phase 7 core hardening under explicit authorization.

### Phase 7 split

- **7A:** resolved threshold/context breakdown, only if needed by governor.
- **7B:** proactive threshold versus overflow-recovery switches, alongside Phase 6.
- **7C:** wire-transform observability, after Phase 4 interface stabilizes.
- **7D:** dead-end rescue, after concrete oversized-tail tests.

### Exit criteria

- Red-pressure choices are explicit and reversible.
- Durable transcript remains complete.
- Recall succeeds.
- Handoff succeeds.
- Custom compaction validates output and falls back safely.
- Overflow cannot enter a compaction loop.

---

## Wave 5 — Phase 8 optimization

**Source state:** complete. Stable-fact memory, scoped delegation profiles/guidance, and the cache observer are implemented. Memory mutation remains available only through human slash commands; cache findings remain advisory.

Parallel lanes:

### Memory lane

- stable facts only;
- bounded one-turn recall;
- no live task transcript in memory;
- retention and consolidation policy.

### Delegation lane

- child research/coding/review/minimal profiles;
- context-aware delegation guidance;
- bounded child outputs;
- artifact references.

### Cache lane

- cache-hit measurement;
- additive tool activation;
- stable prefixes;
- decay epoch tuning;
- regression analysis.

Sequential integration verifies that memory, delegation, and cache policy do not contradict governor pressure guidance.

---

## Wave 6 — Phase 9 experiments

**Source state:** complete as offline benchmark infrastructure. Snapcompact, provider-native compaction, and larger-context promotion adapters use injected seams, provider calls are blocked by default, and no adapter is a production default.

Run independent evaluations against one shared benchmark corpus:

- Snapcompact;
- provider-native compaction;
- larger-context model promotion.

Each experiment must report:

- fidelity;
- continuation quality;
- latency;
- token/image cost;
- cache behavior;
- provider compatibility;
- operational complexity;
- failure and fallback behavior.

No experiment becomes a default without a material measured advantage over decay, recall, handoff, and structured compaction.

## Phase dependency and rollout matrix

| Work | Source state | Default/current exposure | Prerequisite for broader activation |
|---|---|---|---|
| Phase 1 governor | Implemented; post-window fixes implemented | Advisory only | Second observation must pass Gate B |
| Phase 2 broker/adapters | Implemented | Shadow; recall available | Gate B plus artifact/recall durability review |
| Phase 3 overhead | Implemented | Additive deferred activation enabled | Provider/cache measurement before further optimization claims |
| Phase 4 decay | Implemented | Shadow; explicit apply and automatic mutation disabled | Stable recall/invariants, shadow review, then separate explicit/automatic opt-ins |
| Phase 5 checkpoint/handoff | Implemented | Manual commands available; automatic checkpoints disabled | Manual continuation evidence before automatic pressure behavior |
| Phase 6 compaction | Implemented | Native default; manual/threshold/overflow custom reasons disabled | Handoff validation; manual first, threshold later, overflow experimental |
| Phase 7 core | Implemented and built in fork | Rebuilt runtime startup-smoke-tested; reload pending | Focused smoke/integration validation after reload |
| Phase 8 memory/delegation/cache | Implemented | Human-only memory mutation; advisory cache observer | Stable maintenance policy and bounded continuity evidence |
| Phase 9 experiments | Implemented with offline adapters/fakes | No Pi entrypoint, provider calls blocked, no default | Explicit provider opt-in and material benchmark advantage |

## File and workspace safety

Before every wave:

1. Capture `git status --short` in affected repositories.
2. Identify pre-existing dirty files.
3. Assign file ownership explicitly.
4. Never overwrite unrelated changes.
5. Use `read` before `edit` for Hashline-safe edits.
6. Prefer new isolated modules over adding logic to shared entry points.
7. Let only the integration owner modify shared wiring and changelogs.
8. Run `git diff --check` after integration.
9. Do not commit, reset, clean, stash, or build without explicit authorization.

## Validation protocol

For every wave:

1. Module-level contract tests.
2. Focused extension/package tests.
3. Type/lint checks.
4. `npm run check` for fork changes.
5. Controlled lifecycle smoke tests.
6. Synthetic large-output tests.
7. Representative real-session tests.
8. Transcript audit confirming no hidden persistence.
9. Before/after metrics comparison.
10. Review of unrelated worktree changes.

## Metrics dashboard

Track across waves:

- fixed prompt tokens;
- tool-schema tokens;
- skill-description tokens;
- observed resident context;
- estimated effective wire context;
- last-run growth;
- P50/P95 run growth;
- output bytes by tool;
- artifact bytes and successful recalls;
- elided tokens per epoch;
- checkpoint validation rate;
- handoff continuation success;
- custom-compaction validation/fallback rate;
- provider overflow count;
- prompt-cache hits where observable;
- cost and latency.

## Agent assignment template

Every delegated prompt should include:

```text
Task:
Repository/working directory:
Owned files/directories:
Read-only dependencies:
Interfaces that must not change:
Behavioral requirements:
Tests required:
Validation commands:
Existing dirty changes to preserve:
Forbidden actions: no commit, build, reset, clean, or unrelated edits.
Report: concise summary, files changed, tests, risks, unresolved questions.
```

## Fresh-start and resume instructions

At the beginning of a new session:

1. Read completely:
   - `/Volumes/External/Coding/my-pi-setup/CONTEXT_MANAGEMENT_PLAN.md`
   - `/Volumes/External/Coding/my-pi-setup/CONTEXT_MANAGEMENT_ORCHESTRATION.md`
   - `/Volumes/External/Coding/my-pi-setup/docs/context-overhead-baseline.md`
   - `/Volumes/External/Coding/my-pi-setup/docs/context-governor-observation.md`
2. Inspect setup, extension, and personalized-fork worktree state before editing.
3. Reconcile source with private configs and verify whether the installed `dist/cli.js` has been rebuilt since these documents were written.
4. Treat Waves 0–6 and Phases 2–9 as source-complete; do not restart implementation lanes solely because Gate B is open.
5. Preserve shadow/native/disabled defaults and human-only memory mutation. Do not enable enforcement until the applicable gates pass.
6. If the user explicitly authorizes a build, build/smoke-test Phase 0/7 core changes without altering rollout defaults; otherwise make no build.
7. Run the second Governor observation window and update Gate B evidence before any adaptive output or decay activation.

Recommended fresh-session prompt:

```text
Read @my-pi-setup/CONTEXT_MANAGEMENT_PLAN.md, @my-pi-setup/CONTEXT_MANAGEMENT_ORCHESTRATION.md, @my-pi-setup/docs/context-overhead-baseline.md, and @my-pi-setup/docs/context-governor-observation.md completely. Re-ground in current source, tests, private defaults, installed-dist age, and worktree state. Phases 2–9 source is already implemented. Preserve shadow/native/disabled enforcement defaults and human-only memory mutation; do not enable enforcement until gates pass. Gate B remains open after the first observation and governor fixes require a second window. Do not build or commit without explicit authorization.
```
