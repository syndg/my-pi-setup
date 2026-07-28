# Context Experiments — Phase 9 / Wave 6 benchmark core

Contract-first, provider-neutral benchmark package for comparing experimental context strategies against the established decay/recall/checkpoint/structured-compaction baseline. It contains a fixed synthetic corpus, one deep strategy seam, deterministic scoring/reporting, an offline no-op control, and completed Snapcompact, provider-compaction, and model-promotion adapters.

This package is **not a Pi extension entrypoint**. It registers no lifecycle hooks or commands, changes no compaction/decay policy, selects no provider/model, persists no production state, and makes no provider call unless a caller both supplies a provider-backed strategy and sets `providerCallsAllowed: true`.

## Deep strategy seam

```ts
interface ExperimentStrategy {
  readonly manifest: ExperimentStrategyManifest;
  execute(request: ExperimentRequest): Promise<StrategyExecution>;
}
```

The interface includes more than the TypeScript shape. Its contract is:

1. `manifest` is stable for an implementation/version and declares execution mode, image acceptance, capability requirements, and operational-complexity inputs.
2. `execute` receives one immutable, provider-neutral fixture and an already-selected environment. The adapter owns all conversion to bitmap/provider/model/Pi forms.
3. The adapter returns evidence, not a self-assigned score: exact preserved facts with evidence references, structural observations, continuation answers, an exact next action, and measured latency/cost/cache inputs. The runner owns scoring.
4. Provider-backed strategies must declare `execution: "provider"`. The runner blocks them by default.
5. Unsupported and failed executions must preserve input when possible and return a stable failure code. An explicit fallback is supplied to `runBenchmark`; there is no hidden fallback or default strategy.
6. Latency is adapter-supplied. The runner deliberately does not add wall-clock timing to deterministic reports.

This keeps bitmap rendering, remote APIs, model selection, retries, and migration mechanics behind one operation while capability gating, fallback, scoring, and reporting remain local to the benchmark module.

## Capability requirements

A strategy declares zero or more requirements from:

- `image-input`;
- `provider-compaction`;
- `model-promotion`;
- `larger-context-window`;
- `token-usage`;
- `cache-metrics`.

The runner checks requirements against each fixture's `BenchmarkEnvironment`, separately checks image-bearing input against `acceptsImages`, and separately enforces the provider-call opt-in. A missing capability never reaches `execute`. With an explicit fallback, the same untouched fixture is routed to that fallback; otherwise the case is reported as unsupported.

## Fixed synthetic corpus

`FIXED_SYNTHETIC_CORPUS` is I/O-free and contains five deterministic cases:

1. goals, ownership constraints, transcript preservation, decision/rationale, changed file, exact test error, paired multi-tool calls/results, artifact references, and next action;
2. a recoverable tool result larger than 75KB with an exact buried blocker and artifact URI;
3. checkpoint-shaped continuation after compaction, including cache epoch policy, changed files, blocker, artifact, and exact continuation action;
4. image-bearing context on a text-only provider;
5. a legacy provider with neither provider-native compaction nor model-promotion capability.

Every case carries weighted ground-truth facts, required message order/tool pairs/artifact/error structure, and exact continuation probes. The corpus uses a provider-neutral transcript representation so follow-on adapters do not import production lifecycle state.

## Metrics

Each case and aggregate report contains:

- **Structural fidelity:** weighted exact fact preservation plus required message order, tool-call/result pairing, artifact references, and unresolved errors.
- **Continuation fixture quality:** weighted exact probe answers with supporting fact IDs plus the exact next action.
- **Latency:** adapter-supplied milliseconds.
- **Token/image cost input:** input/output/cached tokens, image count/bytes, optional image tokens, and optional estimated USD.
- **Cache behavior input:** cacheable prefix, read/write tokens, invalidations, and epoch ID.
- **Provider compatibility:** provider/model, missing capabilities, image support, and provider-call policy.
- **Operational complexity:** declared setup/dependency/runtime/artifact/migration inputs and a transparent burden-point total.
- **Failure/fallback:** primary/final outcomes, explicit fallback, stable failure code, and whether input remained preserved.

Scores are evidence checks, not model judging. Resource, cache, and complexity values remain labeled inputs; the core does not invent unavailable provider accounting.

## Deterministic reports

```ts
const report = await runBenchmark({
  strategy: noopBaselineStrategy,
  corpus: FIXED_SYNTHETIC_CORPUS,
});

const json = renderBenchmarkJson(report);
const markdown = renderBenchmarkMarkdown(report);
```

JSON recursively sorts object keys, uses two-space indentation, and ends with one newline. Markdown follows corpus order and contains no clock/host metadata. The benchmark ID hashes the corpus, manifests, provider-call policy, and selected environments. Identical inputs and adapter observations produce byte-identical reports.

The no-op control retains all material and makes no provider calls. It should score 100/100 for structural fidelity and continuation quality; it is a comparison control, not a production default.

## Existing Phase 4–6 contract alignment

Follow-on adapters should convert at their edge rather than changing these packages:

- `context-decay`: `DecayContext` / `DecayPlan` / `DecayedContext` can be projected into `StrategyOutput`; retain tool identities, ordering, recall URIs, and cache epoch IDs.
- `context-checkpoints`: `ContextCheckpoint` fields map directly to goal/constraint/decision/file/error-or-blocker/next-action/reference facts and continuation evidence.
- `context-compaction`: `CompactionPrototypeInput` is an adapter input source; `CompactionPrototypeDecision` supplies checkpoint, boundary, usage, and native-fallback evidence. Queued messages remain outside the experiment seam, matching the production contract.

The benchmark must not call these production modules through lifecycle hooks. A follow-on adapter may import their pure types/functions and perform conversion inside `execute`.

## Integrated Phase 9 adapters

The package index exports all three completed adapters and their public injected seams:

```ts
import {
  createSnapcompactStrategy,
  createProviderCompactionStrategy,
  createModelPromotionStrategy,
  type VisionEvaluator,
  type ProviderCompactionClient,
  type PromotionClient,
} from "context-experiments";
```

- **Snapcompact** renders deterministic PNG frames and injects a `VisionEvaluator`; callers may also inject a `SnapcompactFrameRenderer`. See [`docs/snapcompact.md`](docs/snapcompact.md).
- **Provider-native compaction** injects a `ProviderCompactionClient` for support detection and one compaction request. See [`docs/provider-compaction.md`](docs/provider-compaction.md).
- **Larger-context promotion** injects a `PromotionClient` and explicit `PromotionTargetDescriptor` for a one-shot target invocation. See [`docs/model-promotion.md`](docs/model-promotion.md).

Factories, manifests, request/result types, renderer controls, and client/evaluator interfaces are exported through `src/index.ts`. There are no client singletons or default transports. Importing the package performs no I/O, and the runner still blocks every provider-backed adapter unless `providerCallsAllowed: true`.

`phase9-integration.test.ts` runs the complete fixed corpus through deterministic offline fakes for every adapter, verifies byte-deterministic reports, explicit fallback and accounting, and compares results with the no-op control. The measured contract-validation results and their limits are documented in [`docs/EVALUATION.md`](docs/EVALUATION.md). No adapter is adopted as a production default.

## Development

No install or build is required:

```bash
npm test
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH npm run check
```
