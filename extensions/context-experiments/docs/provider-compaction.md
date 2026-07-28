# Provider-native compaction experiment adapter

`src/adapters/provider-compaction.ts` implements the Phase 9 provider-native compaction experiment at the existing `ExperimentStrategy` seam. It is benchmark-only: it does not register production session hooks, participate in overflow recovery, mutate a fixture, or choose a provider.

## Safety and execution policy

- The manifest has `execution: "provider"`, so `runBenchmark` blocks it unless `providerCallsAllowed: true`.
- The manifest requires `provider-compaction`; the runner capability-gates a case before the client is inspected or invoked.
- There is no default client or transport. Importing the adapter performs no I/O, and creating a strategy requires an explicitly injected `ProviderCompactionClient`.
- `execute` defensively repeats provider-call and environment-capability checks for callers that bypass the runner.
- The adapter is text-only (`acceptsImages: false`). Image-bearing cases are rejected by the runner rather than silently losing image context.
- Every adapter failure preserves the original input and suggests `local structured-compaction`. The runner, not the adapter, decides whether to invoke a supplied fallback strategy.

## Client contract

```ts
interface ProviderCompactionClient {
  detectSupport(request: ProviderCompactionSupportRequest):
    ProviderCompactionSupport | Promise<ProviderCompactionSupport>;

  compact(
    request: ProviderCompactionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderCompactionResponse | null | undefined>;
}

const strategy = createProviderCompactionStrategy(client);
```

`detectSupport` must report three independent facts:

1. `capabilityAvailable`: the client/provider currently exposes native compaction;
2. `authenticated`: usable credentials are present;
3. `modelSupported`: the selected provider/model combination supports the operation.

This second layer is intentional. The benchmark environment declares expected capability for runner gating, while the injected client verifies actual runtime availability, auth, and provider/model support immediately before invocation.

## Immutable request conversion

`createProviderCompactionRequest` creates a detached, recursively frozen `provider-compaction-request/v1` value. It contains:

- fixture, provider, and model IDs;
- a cloned transcript, including tool calls/results, artifacts, and image metadata;
- continuation probe IDs and prompts.

It does **not** include expected fact values, expected probe answers, or the expected next action. Ground truth is retained locally for runner scoring and cannot leak into the provider request. The original fixture remains available unchanged for explicit local fallback.

## Response and accounting mapping

A successful client response has `status: "compacted"` and supplies:

- preserved facts with source-message evidence references;
- observed message order, tool pairs, artifacts, and unresolved errors;
- continuation answers with supporting fact IDs and the next action;
- measured latency;
- input, output, cached-input, and optional image-token usage;
- cache prefix/read/write/invalidation/epoch observations;
- optional estimated USD cost.

The adapter validates finite non-negative accounting, input-owned evidence IDs, unique observations, and the complete runtime shape before mapping to `StrategyOutput` and `StrategyMeasurements`. Fact values and continuation answers are not required to match ground truth during validation; differences remain valid observations and are scored by the runner. Image count and bytes come from the immutable fixture rather than provider claims.

The adapter does not estimate unavailable pricing or image tokens. Clients use `null` for those fields when the provider cannot supply defensible values.

## Stable failures

All failures have `inputPreserved: true` and `suggestedFallback: "local structured-compaction"`.

| Condition | Outcome | Code |
| --- | --- | --- |
| Direct execution without opt-in | `unsupported` | `provider-calls-disabled` |
| Environment lacks declared capability | `unsupported` | `missing-provider-capability` |
| Malformed support inspection | `failed` | `provider-compaction-malformed-support` |
| Support inspection throws | `failed` | `provider-compaction-support-check-failed` |
| Runtime capability unavailable | `unsupported` | `provider-compaction-unavailable` |
| Authentication unavailable | `unsupported` | `provider-compaction-auth-unavailable` |
| Provider/model unsupported | `unsupported` | `provider-compaction-model-unsupported` |
| Provider reports unsupported | `unsupported` | `provider-compaction-unsupported` |
| Provider rejects or throws | `failed` | `provider-compaction-rejected` |
| Empty result | `failed` | `provider-compaction-empty-response` |
| Invalid response/evidence/accounting | `failed` | `provider-compaction-malformed-response` |

Runner-level blocks use the runner's existing stable codes and never enter adapter execution.

## Explicit fallback

```ts
const report = await runBenchmark({
  strategy: createProviderCompactionStrategy(client),
  fallbackStrategy: localStructuredCompactionStrategy,
  corpus,
  providerCallsAllowed: true,
});
```

The adapter only returns fallback metadata. It never invokes local compaction itself, never calls `session_before_compact`, and never changes production native-overflow behavior.
