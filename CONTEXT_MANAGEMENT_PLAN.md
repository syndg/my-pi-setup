# Pi Context Management Plan

## Status

- **Phases 2–9 are implemented in source**, alongside the Phase 1 governor. This is source/contract-test completion, not authorization to enable gated enforcement or a claim of representative real-provider validation.
- Safe rollout defaults remain in force: Phase 2 output budgeting is **shadow**; Phase 4 automatic mutation and explicit apply are **disabled**; Phase 5 automatic checkpoints are **disabled** while manual `/checkpoint` and `/handoff` are available; Phase 6 uses **native compaction by default** with all custom reasons disabled; Phase 8 memory mutations are **human-only**; and Phase 9 has offline adapters/benchmarks with **no production default**.
- **Phase 3 deferred activation is enabled:** background and subagent control tools load additively after their starter tool is used, and `workflow` activates only for `ultracode` or an explicit workflow request. Offline measurement shows reduced initial schema/catalog overhead; it does not establish provider cache, billing, or latency gains.
- The first representative Governor observation was completed and **did not pass Gate B**. It found warm-up growth contamination, premature P95/runway use, and stale pre-compaction velocity. Source fixes and metrics-only audit fields are implemented, but Gate B remains open pending a second observation window covering clean multi-run sequences, post-compaction follow-up, model switching, resume, and branching.
- **Core Phases 0 and 7 are implemented and built in the personalized fork.** Phase 0 provides percentage thresholds. Phase 7 adds independent proactive/overflow controls, resolved threshold and usage provenance, post-compaction local estimates, extension-compaction validation/native fallback, and oversized overflow-retry protection. The built `dist/cli.js` passed a startup smoke test; reload is required for the running Pi process to use it.
- Local focused tests/type checks documented by the source packages are distinct from the still-open real-session and integrated rollout gates. Do not infer Gate B or final integration validation from source completion.
- Existing unrelated fullscreen/selection worktree changes were preserved and included in the authorized fork publication.

## Repositories and ownership

- Personalized Pi fork: `/Users/syndg/Coding/syn-pi`
- User extensions: `/Users/syndg/Coding/my-pi-setup/extensions` (loaded through the local Pi package)
- Setup/plan source of truth: `/Users/syndg/Coding/my-pi-setup/CONTEXT_MANAGEMENT_PLAN.md`
- Reference implementation: `/Volumes/External/Coding/oh-my-pi`

## Problem statement

Native Pi exposes context occupancy to the human footer, but the model does not see that UI and receives no runtime context budget. Native proactive compaction historically triggered at `contextWindow - reserveTokens`; on a 272K model with the default 16,384 reserve this is about 94%, too late for tool-heavy turns. Large tool outputs are the dominant growth source: broad `rg`, `fd`, and `read` results can add tens of thousands of tokens in seconds. Fixed prompt overhead also matters: model-visible skill descriptions and active extension tool schemas consume several thousand tokens before the user says anything.

The goal is not merely earlier summarization. The goal is a context management system that makes pressure visible, prevents avoidable growth, decays stale payloads without deleting the audit trail, supports retrieval, and offers controlled handoffs before lossy compaction becomes necessary.

## Target architecture

Maintain three distinct representations:

1. **Durable transcript** — append-only JSONL remains complete and auditable.
2. **Active provider context** — a bounded, deterministic working view sent to the model.
3. **External artifacts and memory** — full oversized outputs, checkpoints, and stable cross-session facts live outside the always-on prompt and are retrieved on demand.

Track two context sizes:

- **Resident context:** estimated size of everything retained by the active session reconstruction.
- **Effective wire context:** estimated size after request-time elision/compression.

Use remaining safe runway rather than percentage alone:

```text
safeLimit = configured compaction threshold or legacy reserve threshold
headroom = safeLimit - effectiveWireTokens
projectedTurns = headroom / recent high-percentile per-run growth
```

## Non-negotiable invariants

- Never silently delete the durable transcript.
- Request-time filtering must be deterministic and non-destructive.
- Preserve tool-call/tool-result pairing and provider-valid message ordering.
- Keep a protected recent working set and explicitly pinned content.
- Make every automated reduction observable and reversible through recall.
- Preserve overflow recovery even when proactive compaction policy changes.
- Avoid repeated deep-prefix rewrites that destroy provider prompt-cache hits.
- Full outputs go to artifacts before a context-bearing response is shortened.
- Long-term memory is complementary; it must not become a hidden permanent transcript.
- Roll out enforcement only after advisory telemetry is trustworthy.

---

## Phase 0 — Percentage-based auto-compaction threshold

### Scope

- Add optional `compaction.thresholdPercent`.
- Percentage takes precedence over reserve-based proactive threshold checks.
- Keep `reserveTokens` for summary output budgeting and legacy fallback.
- Add `/settings` selector matching OMP’s choices.
- Document behavior and test threshold, persistence, and selector wiring.

### State

Implemented, covered, built into the personalized fork, and startup-smoke-tested. A Pi reload is required for the current process to observe it.

### Exit criteria

- Selected percentage persists to settings.
- Compaction triggers only after crossing the selected percentage.
- Default exactly preserves legacy behavior.
- Provider overflow recovery still works.

---

## Phase 1 — Advisory Context Governor

### Objective

Make the model and user aware of context pressure before enforcing any reductions.

### Location

Create a dedicated `context-governor` extension under `/Users/syndg/.pi/agent/extensions`, sharing state with the existing `model-info` and `ui-customization` extensions where appropriate.

### Measurements

Track per session and per settled agent run:

- observed provider context tokens from `ctx.getContextUsage()`;
- model context window;
- active threshold and resolved safe limit;
- current headroom;
- tokens added by the latest run;
- recent run growth history, EWMA, and conservative percentile/max;
- estimated number of similarly sized runs remaining;
- resident message estimate when provider usage is unavailable;
- later, effective wire estimate after context decay;
- top growth classes: tool results, assistant output, user/custom messages, fixed prompt/tool/skill overhead when available.

### Pressure levels

Initial configurable levels:

- **Green:** healthy runway; no model injection.
- **Yellow:** elevated percentage, absolute token usage, or one unusually large run.
- **Orange:** fewer than roughly two recent-large runs remain before the safe limit.
- **Red:** insufficient runway for another normal tool-heavy run.
- **Emergency:** provider overflow or failed proactive maintenance.

Use percentage, absolute tokens, and growth velocity together. Do not rely on percentage alone.

### Model-visible notice

Use Pi’s `context` event to append a tiny ephemeral message only at Yellow or above. It must not persist in JSONL. Example:

```text
Context budget: 157K/272K resident; safe limit 190K; +31K last run; ~1 similar run remains.
For this turn: avoid broad parent-session searches, delegate exploration, request bounded slices, and keep combined tool output below 12K tokens.
```

Requirements:

- concise and actionable;
- current before every provider request;
- absent at Green;
- no changing system prompt each turn;
- no persistent warning-message accumulation;
- no automatic compaction, pruning, blocking, or cap changes in Phase 1.

### Human UI

Extend the custom footer or statuses to show a compact form:

```text
157K/272K · safe 190K · +31K · ~1.1 runs · orange
```

Add `/context-status` with a detailed report including the measurement source and whether values are observed or estimated.

### Configuration

Use a small private configuration file or extension defaults for:

- pressure thresholds;
- emergency margin;
- growth history length;
- model notice enabled/disabled;
- footer format;
- debug telemetry.

### Telemetry

Record bounded local metrics, not message bodies or secrets:

- timestamp/session ID;
- model/window;
- context before/after;
- run delta;
- pressure level;
- tool-result byte totals by tool name;
- actions recommended.

### Tests

- context percentage and headroom calculations;
- unknown post-compaction usage;
- run-delta tracking;
- runway estimation;
- pressure transitions;
- ephemeral notice inclusion/exclusion;
- no persistent custom message;
- model switch and session reset;
- footer formatting and narrow terminal behavior.

### State

Implemented and locally validated as advisory-only source. The first real-telemetry window confirmed notice non-persistence but failed Gate B because growth/runway and post-compaction behavior were not trustworthy. Warm-up rejection, minimum clean-sample gates, compaction velocity reset, and richer metrics-only audit fields are now implemented; a second representative observation window is required before enforcement is enabled.

### Exit criteria

- Governor measurements agree closely with provider usage over real sessions.
- The model receives a useful warning before dangerous broad operations.
- No transcript growth is caused by governor notices.
- No regressions in compaction, custom footer, subagent, or workflow behavior.

---

## Phase 2 — Output Budgeting and Artifact Offload

### Objective

Prevent one tool call or asynchronous completion from consuming a large fraction of the remaining context.

### Shared output broker

Create a reusable output-budget utility used by context-heavy extensions. It should:

- accept tool name, pressure level, requested/explicit limit, raw output, and metadata;
- preserve small results unchanged;
- save oversized full output to a session-scoped artifact before shortening;
- return a synopsis, counts, truncation reason, artifact path, and retrieval instructions;
- be UTF-8 safe and terminal safe;
- redact secrets where applicable;
- expose bytes/tokens saved to governor telemetry.

### Initial budgets

Start conservatively and make them configurable. Example byte ceilings:

| Source | Green | Yellow | Orange | Red |
|---|---:|---:|---:|---:|
| `read` | 20KB | 14KB | 8KB | 4KB |
| `rg` / `fd` | 16KB | 10KB | 6KB | 3KB |
| MCP result | 16KB | 10KB | 6KB | 3KB |
| automatic subagent final | 8KB | 6KB | 4KB | 2KB |
| child live message | 4KB | 3KB | 2KB | 1KB |
| background completion | 2KB | 1KB | 1KB | status only |

Explicit user limits may override defaults up to a hard safety ceiling. The model should be encouraged to request slices rather than raising limits reflexively.

### Tool-specific work

- **Hashline read:** lower default output ceiling and line count; keep explicit selectors; full oversized reads become artifacts.
- **File search:** summarize counts and top paths first; avoid per-file floods; save complete output.
- **MCP:** keep gateway mode; default schema inclusion off; apply output broker to calls/search.
- **Subagents:** require bounded final reports; store full child transcript/result externally; reduce automatic delivery size.
- **Background terminals:** successful completion sends status only; detailed tail requires `bg_status`; full logs remain external.
- **Workflows:** bounded synthesis enters parent context; full agent outputs remain workflow artifacts.

### Async behavior

Routine successful background/subagent/workflow completion should not always force a new parent turn. Wake the model only when:

- the parent explicitly waits;
- completion is required for blocked work;
- the process failed;
- the child marks the result urgent.

### Tests

- exact boundary behavior;
- artifact written before truncation;
- retrieval path correctness;
- failure to write artifact fails safely without losing output silently;
- secret redaction;
- pressure-adaptive caps;
- explicit override behavior;
- asynchronous completion trigger policy.

### State

Implemented in `context-archive` and the `context-output` Pi adapter, including durable bounded recall and completion routing. The adapter defaults to **shadow** mode, so it observes pressure-adaptive budgets without shortening outputs or creating enforcement artifacts. Adaptive caps remain gated by Gate B and artifact/recall rollout review.

### Exit criteria

- No automatic result can inject tens of thousands of tokens.
- Full output remains recoverable.
- Typical coding tasks do not feel artificially starved.
- P95 per-run growth drops materially from the pre-governor baseline.

---

## Phase 3 — Deferred Tool Loading and Fixed-Overhead Reduction

### Objective

Reduce the fixed prompt paid on every request without harming tool discoverability.

### Deferred tools

Use Pi’s additive dynamic tool loading and native OpenAI deferred-tool support:

- Initially expose `subagent_spawn`; activate wait/send/inbox/check/list/cancel after the first spawn.
- Initially expose `bg_start`; activate status/list/kill after the first background process.
- Activate `workflow` only when raw input contains `ultracode` or explicitly requests a workflow.
- Keep the single MCP gateway; never expose every remote schema up front.
- Once a tool is activated in a session, leave it active unless there is a strong reason to remove it; additive loading preserves prompt-cache behavior better than replacement.

### Tool metadata cleanup

Audit descriptions, parameter descriptions, `promptSnippet`, and `promptGuidelines` for duplication. Preserve safety-critical Hashline constraints, but remove repeated prose that does not change model behavior.

### Skill catalog cleanup

Measure visible skill-description token cost. For genuinely manual-only skills, set `disable-model-invocation: true`; keep automatic invocation for file/domain skills where trigger behavior matters. Do not hide skills merely because their descriptions are long.

### Child profiles

Replace child-session “everything except denylist” behavior with explicit profiles:

- `research`;
- `coding`;
- `review`;
- `minimal`.

Each profile receives only the schemas it needs.

### Measurements

Before and after:

- first-request prompt tokens;
- tool-schema tokens;
- skill-description tokens;
- cache-hit rate after dynamic activation;
- tool discovery success.

### State

Implemented and enabled for deferred orchestration tools. Background/subagent controls activate additively after `bg_start`/`subagent_spawn`; `workflow` activates only on `ultracode` or an explicit workflow request and branch activation state is restored. The offline baseline/post-change measurement records a 29.02% reduction in initial canonical tool payload and a 13.67% reduction in combined tool-plus-visible-skill estimate; no provider cache or latency claim is made. Explicit child tool profiles are implemented for scoped delegation.

### Exit criteria

- Fixed baseline drops substantially, ideally 25–40% from the measured extension/skill overhead.
- Workflow remains available exactly when requested.
- Child agents no longer inherit irrelevant orchestration tools.
- No degradation in tool selection or safety behavior.

---

## Phase 4 — Non-destructive Context Decay and Recall

### Objective

Bound effective provider context by eliding stale payloads while retaining the complete transcript.

### Request-time context view

Use the `context` event’s deep copy. Never mutate persisted session entries. Build a deterministic outgoing view with stable placeholders.

### Candidate classes

- superseded reads of the same file/selector;
- older broad reads replaced by a newer authoritative read;
- consumed search results;
- empty or uneventful searches/commands;
- successful background completion notices already acknowledged;
- consumed subagent messages/results;
- old large tool results outside the protected working set;
- duplicated generated context.

### Protected content

Always protect:

- the most recent configurable working set, initially 16–24K tokens;
- the latest relevant read per active file;
- current user goal and constraints;
- unresolved errors/blockers;
- explicitly pinned entries;
- skill content needed for the active workflow;
- the latest checkpoint/handoff state;
- tool-call/result structural validity.

### Stable placeholders

Example:

```text
[Context-elided tool result: rg, 18,420 tokens, session entry 01ABC…, artifact context://01ABC…]
```

The placeholder must remain byte-stable across subsequent requests.

### Recall tool

Add `context_recall` supporting:

- session entry ID;
- artifact URI/path;
- query over archived metadata;
- optional bounded slice/line range.

Recall should return a bounded result and should not permanently rehydrate the entire old payload. Full rehydration requires an explicit request.

### Cache-aware epochs

Do not rewrite one deep message every turn. Apply decay at discrete epochs, such as:

- transition to Orange;
- a minimum savings threshold;
- provider cache known/assumed cold;
- explicit `/context-decay` command;
- immediately before a controlled maintenance action.

Record the epoch and replacement map so the same wire view is reproduced deterministically.

### Dual accounting

Governor UI must show both resident and effective wire estimates after Phase 4. Native provider usage alone is not sufficient because request-time filtering lowers reported usage while resident history continues to grow.

### Tests

- supersession rules;
- protected-tail behavior;
- pairing/order invariants;
- deterministic output across repeated calls;
- recall by ID and query;
- no persisted transcript mutation;
- cache epoch stability;
- compaction interaction and model switch behavior;
- oversized single-turn dead-end handling.

### State

The deterministic decay engine, lifecycle adapter, dual resident/wire accounting, shadow reports, stable epochs, and bounded `context_recall` path are implemented. Default behavior remains non-mutating: automatic mutation is disabled, explicit preview is available, and explicit apply requires a separate private opt-in that is disabled by default.

### Exit criteria

- Effective wire context remains bounded over long tool-heavy sessions.
- Old detail is recoverable with one bounded recall call.
- No invalid provider message sequences.
- Cache-hit rate does not collapse from continual rewrites.

---

## Phase 5 — Structured Checkpoints and Controlled Handoffs

### Objective

Offer a predictable fresh-session continuation before lossy compaction is necessary.

### Checkpoint schema

Extend or reuse the summaries extension to maintain a structured, non-context state document:

```text
Goal
Constraints and preferences
Completed work
Current working set
Key decisions and rationale
Changed files
Commands/tests and outcomes
Unresolved questions
Blockers
Next actions
Critical session entry/artifact IDs
Context policy state
```

Keep run recaps UI-only. Consolidate them into checkpoints only at meaningful boundaries instead of adding every recap to model context.

### Triggering

Checkpoint creation can occur:

- manually with `/checkpoint`;
- when entering Orange/Red;
- before manual compaction;
- before a handoff;
- after a major task milestone.

### Handoff flow

At Red, present a choice rather than silently compacting:

1. continue with context decay;
2. create checkpoint only;
3. create a fresh handoff session;
4. run custom compaction;
5. ignore once.

A handoff session should be seeded with:

- validated checkpoint;
- pointer to original session;
- relevant artifact IDs;
- selected small working-set material;
- explicit next action.

The original session stays untouched and browsable.

### Validation

Before creating the new session, validate that the checkpoint includes goal, constraints, modified files, decisions, blockers, and next steps. Surface omissions to the user.

### Tests

- checkpoint schema parsing;
- omitted-field validation;
- session pointer and artifact linkage;
- new-session bootstrap content;
- cancellation and rollback;
- handoff while child/background work is active;
- continuation quality fixture.

### State

Checkpoint schema/validation/persistence and explicit fresh-session handoff are implemented. Manual `/checkpoint <next action>` and `/handoff <next action>` are available; pressure events only recommend action. Automatic pressure checkpoints remain disabled by default, and handoff never auto-runs a new session turn.

### Exit criteria

- A new session can resume work without rereading the full old transcript.
- Handoff is explicit and reversible.
- No silent loss of current goals, decisions, or file state.

---

## Phase 6 — Custom Compaction Policy

### Objective

Replace native summary generation when compaction is chosen, while retaining native overflow recovery as a safety net.

### Extension seam

Use `session_before_compact` and branch on reason:

- `manual`;
- `threshold`;
- `overflow`.

Observe completion with `session_compact`. Never cancel overflow recovery without a tested alternative.

### Summary generation

Use a dedicated, configurable summarization model rather than the main coding model. Reuse the existing summaries model configuration where sensible.

Generate structured output matching the checkpoint schema, with:

- file lists;
- key decisions and rationale;
- exact blockers/errors;
- current code/test state;
- next action;
- important entry/artifact references;
- prior checkpoint/summary merged explicitly.

### Retained working set

Choose a smaller, configurable retained tail than native’s default 20K when safe, initially around 8–12K. Compute a valid `firstKeptEntryId`; never split tool-call/result structure incorrectly.

### Validation and fallback

- Validate required sections and length.
- Reject empty or malformed summaries.
- Optionally run a cheap second-pass verifier for critical sessions.
- On failure, preserve the original context and either retry or fall back to native compaction.
- Store summary-model usage in the compaction entry.

### Threshold behavior

The Phase 0 percentage selector decides when proactive compaction pressure is reached. The governor may recommend handoff or decay before allowing compaction. Policy must remain explicit and configurable.

### Tests

- all compaction reasons;
- previous-summary merge;
- split-turn handling;
- custom boundary validity;
- usage persistence;
- verifier failure/fallback;
- overflow recovery;
- queued messages during compaction;
- post-compaction context reconstruction.

### State

The checkpoint-shaped summary engine and production lifecycle adapter are implemented. Manual, threshold, and overflow custom compaction all default **off**, so native Pi compaction remains the default and every custom failure falls back to native behavior. Activation remains gated; no representative custom-compaction validation is claimed.

### Exit criteria

- Custom summaries reliably preserve the state needed to continue.
- Threshold selection behaves predictably.
- Overflow recovery remains functional.
- Native compaction remains an available fallback.

---

## Phase 7 — Fork API and Core Hardening

### Objective

Move only the generally useful primitives that extensions cannot implement reliably into the personalized Pi fork.

### Candidate additions

1. **First-class context breakdown API**
   - system prompt;
   - context files;
   - tool schemas;
   - skills;
   - messages/tool results;
   - resolved compaction threshold/buffer;
   - free headroom;
   - observed versus estimated provenance.

   Proposed extension surface: `ctx.getContextBreakdown()`.

2. **Separate proactive threshold and overflow recovery switches**

   ```json
   {
     "compaction": {
       "thresholdEnabled": true,
       "overflowRecoveryEnabled": true
     }
   }
   ```

3. **Resolved threshold helper**
   - one source of truth for percentage versus reserve behavior;
   - exposed to footer, governor, RPC, and tests.

4. **Post-compaction estimate continuity**
   - improve the current temporary unknown occupancy when a defensible local estimate exists;
   - preserve provenance so UI distinguishes estimate from provider observation.

5. **Wire-context observability seam**
   - allow a context transformer to report estimated before/after size and action metadata without rewriting provider payloads itself.

6. **Dead-end rescue**
   - detect when one retained tail/tool result is itself too large to fit after compaction;
   - fall back to deterministic payload reduction or handoff rather than looping.

### Upstream/fork discipline

- Keep fullscreen and personalization patches isolated.
- Prefer extension APIs over permanent core policy.
- Add focused contract tests and changelog entries.
- Do not port OMP’s full maintenance subsystem wholesale.

### State

Implemented and built in the personalized fork where proven core gaps required it: independent proactive threshold and overflow-recovery controls, one resolved-threshold helper, context-usage provenance and post-compaction local estimates, validation of extension compaction results with native fallback, and dead-end overflow retry protection. The rebuilt launcher passed a startup smoke test; broader items in the candidate list above remain design requirements where they are not present in current source.

### Exit criteria

- Extensions no longer duplicate inaccurate token accounting.
- Overflow and proactive maintenance are independently configurable.
- Long sessions cannot enter an endless compact-but-still-overflow cycle.

---

## Phase 8 — Memory, Delegation, and Prompt-Cache Optimization

### Objective

Improve long-running continuity without turning memory into permanent prompt bloat.

### Memory policy

Store only stable cross-session information:

- user preferences;
- project conventions;
- durable architectural decisions;
- known environment facts.

Do not use long-term memory as the live task transcript. Recall should be bounded, relevant, and injected for one turn. Retention/consolidation runs separately from provider context.

### Context-aware delegation

At Yellow or above, governor guidance should encourage:

- scoped subagents for broad exploration;
- concise structured child outputs;
- artifact references instead of source dumps;
- parent synthesis from bounded findings.

Children should receive explicit tool profiles and context/output budgets.

### Prompt-cache stability

- Keep system/tool prefix stable.
- Prefer additive tool activation.
- Batch context-decay changes into epochs.
- Measure cache-hit rate before and after every phase.
- Avoid adding dynamic per-turn text to the system prompt; use ephemeral message context instead.

### State

Implemented in source across stable-fact memory, scoped delegation profiles/guidance, and a metrics-only cache observer. `memory_search` is the only model-facing memory operation; remember, forget, and consolidate mutations are available only through human-executed slash commands. Cache recommendations are advisory and apply nothing automatically.

### Exit criteria

- Memory improves continuation without measurable baseline growth.
- Delegated exploration produces bounded parent context.
- Cache-hit rate remains healthy after pruning and dynamic loading.

---

## Phase 9 — Experimental OMP Techniques

### Objective

Evaluate advanced techniques only if Phases 1–8 leave a demonstrated gap.

### Snapcompact evaluation

Potentially test bitmap-frame archival of old text/tool results for vision-capable models. Treat as experimental because it:

- depends on image input and model visual attention/OCR;
- consumes image budget;
- complicates provider accounting;
- has fidelity and archive-migration risks;
- is substantially more complex than deterministic text elision plus recall.

### Remote/provider compaction

Evaluate provider-native compaction only behind capability detection and with local fallback. Compare fidelity, latency, cost, and cache behavior against custom structured compaction.

### Promotion to larger context

Optional policy: switch to a larger-window compatible model before destructive maintenance when cost and provider availability permit. This must be explicit and must preserve model/tool compatibility.

### State

All three experimental adapters—Snapcompact, provider-native compaction, and larger-context model promotion—are implemented behind injected interfaces and exercised with deterministic offline fakes. The package has no Pi entrypoint, blocks provider-backed execution unless explicitly allowed, and adopts no strategy as a production default. Real provider advantage has not been demonstrated.

### Exit criteria

Adopt an experimental strategy only if benchmarks show a material advantage over handoff, decay, and custom structured compaction.

---

## Cross-phase validation strategy

For every phase:

1. Add contract-level unit tests.
2. Run focused package tests.
3. Run `npm run check` for fork changes.
4. Use controlled TUI smoke tests for UI/session lifecycle behavior.
5. Test with synthetic large tool results and real representative sessions.
6. Compare baseline prompt size, per-run growth, wire size, cache hits, cost, and continuation quality.
7. Preserve all unrelated dirty worktree changes.
8. Do not build or commit unless explicitly requested.

## Success metrics

- Model receives actionable warning before dangerous context growth.
- No ordinary tool result can unexpectedly consume tens of thousands of tokens.
- Full large outputs remain recoverable from artifacts.
- Fixed schema/skill overhead is materially reduced.
- Effective wire context stays bounded over long sessions.
- Resident and wire context are both visible.
- P95 per-run growth is reduced and predictable.
- Compaction triggers at the selected percentage, not near an accidental absolute-reserve cliff.
- Handoff resumes successfully without rereading the full old session.
- Custom compaction preserves goals, constraints, decisions, changed files, blockers, and next actions.
- Overflow recovery and prompt caching do not regress.

## Recommended rollout order

Source implementation is complete through Phase 9; the remaining order is for **build, observation, and controlled activation**, not additional phase fan-out:

1. Explicitly authorize and build the personalized fork so Phase 0/7 runtime seams are actually present; preserve native proactive and overflow defaults during the build smoke test.
2. Run a second Governor observation window with the implemented fixes. Include heterogeneous multi-run sessions, post-compaction follow-up, a model/window switch, session resume with a second writer, and a real tree branch.
3. Keep Gate B closed unless that evidence validates growth deltas, reset behavior, runway usefulness, notice persistence, and acceptable telemetry overhead.
4. After Gate B, review Phase 2 shadow metrics and artifact/recall durability, then opt into output enforcement conservatively.
5. Retain the already-enabled additive Phase 3 deferred loading and collect provider-request/cache measurements before making further metadata or skill-catalog changes.
6. Validate Phase 4 shadow proposals and bounded recall before separately opting into explicit decay, then automatic decay.
7. Exercise manual checkpoint and handoff continuation before enabling automatic checkpoints or any custom compaction reason.
8. Opt into Phase 6 manual custom compaction first; evaluate threshold custom compaction later; keep overflow custom compaction experimental with native fallback.
9. Evaluate Phase 8 memory/delegation/cache behavior without granting model memory mutation, then run Phase 9 provider-backed experiments only by explicit opt-in. Adopt no experiment without a material measured advantage.

## Resume instruction

Use this file, [`CONTEXT_MANAGEMENT_ORCHESTRATION.md`](./CONTEXT_MANAGEMENT_ORCHESTRATION.md), [`docs/context-overhead-baseline.md`](./docs/context-overhead-baseline.md), and [`docs/context-governor-observation.md`](./docs/context-governor-observation.md) as the current source of truth. Re-check source, tests, private configuration, installed `dist` age, and worktree state before acting. Phases 0–9 source exists and Phase 0/7 core has been built: **do not restart implementation waves and do not enable enforcement until the applicable gates pass**. After reload, the next evidence step is the second Governor observation window.
