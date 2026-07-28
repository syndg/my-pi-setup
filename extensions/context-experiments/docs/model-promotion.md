# Larger-context model-promotion experiment adapter

`src/adapters/model-promotion.ts` adapts one benchmark fixture to one explicitly supplied larger-context model. It is an experiment adapter, not a model router: it does not select a target, switch the active production model, update a session, or persist a default.

There is no built-in provider client and therefore no network path by default. A caller must inject both a `PromotionClient` and a `PromotionTargetDescriptor`, then separately opt into provider execution in `runBenchmark`.

## Manifest and runner gate

The factory returns an `ExperimentStrategy` whose manifest declares:

- `execution: "provider"`;
- required `model-promotion` capability;
- required `larger-context-window` capability;
- image acceptance at the adapter boundary (the explicit target is checked separately).

Consequently, `runBenchmark` blocks execution unless `providerCallsAllowed: true`, and blocks environments missing either capability before any client method runs.

## Construction

Import the adapter directly; the shared package index is intentionally unchanged.

```ts
import { createModelPromotionStrategy } from "./src/adapters/model-promotion.ts";

const strategy = createModelPromotionStrategy({
  target: {
    providerId: "example-provider",
    modelId: "example-1m",
    contextWindowTokens: 1_000_000,
    acceptsImages: true,
    tools: [
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  },
  client: {
    hasProviderAuth: async (target, signal) => checkLocalCredential(target.providerId, signal),
    isModelAvailable: async (target, signal) => lookupModel(target, signal),
    promote: async (request) => invokeExperimentContinuation(request),
  },
});
```

`promote` is a one-shot invocation against `request.target`. A `PromotionClient` implementation must not interpret it as permission to change a live session or provider default.

## Preflight order

Before `PromotionClient.promote` can run, the adapter checks:

1. the target and source descriptors contain valid provider/model/window values;
2. the target window is strictly larger than the source window;
3. an optional `compatibleSourceProviderIds` allowlist accepts the source provider;
4. the injected client reports target-provider authentication;
5. every concrete fixture tool call has a target tool with a compatible JSON input schema;
6. an image-bearing fixture is supported by the target;
7. estimated input tokens fit the target window;
8. the injected client reports the target model available.

The default estimator uses the benchmark convention of `ceil(JSON UTF-8 bytes / 4)`. Tests or provider integrations may inject a more exact deterministic estimator through `estimateInputTokens`. The estimate must be a non-negative safe integer.

The supported schema checks cover boolean schemas, primitive/object/array types, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `allOf`, `anyOf`, and `oneOf`. This validates the concrete calls in the fixture; it does not claim general JSON Schema equivalence.

## Non-destructive invocation

Immediately before invocation, the adapter makes detached structured clones of the fixture and target. The injected client receives the copy, so accidental client mutation cannot alter the fixed corpus or source fixture. The client API contains no operation for setting a model or persisting a default.

Continuation evidence returned by the client is copied into an immutable `StrategyOutput`:

- preserved facts and evidence references;
- message order, tool pairs, artifacts, and unresolved errors;
- continuation answers and supporting facts;
- exact next action.

The benchmark runner remains responsible for scoring this evidence.

## Accounting

`PromotionInvocationResult` maps provider observations to `StrategyMeasurements`:

- provider-observed latency;
- input, output, and cached input tokens;
- fixture image count/bytes plus optional provider image tokens;
- optional estimated USD cost;
- cacheable prefix, cache reads/writes, and target epoch.

Promotion changes the model and therefore invalidates the source prompt-cache epoch. The adapter adds **one** source-to-target invalidation to any additional provider-observed invalidations. If cache observations are absent, it still records that one known invalidation; unknown monetary and image-token estimates remain `null`.

## Stable failures and fallback

Pre-invocation incompatibilities return `outcome: "unsupported"`, do not invoke the target, and set `inputPreserved: true`:

| Code | Meaning |
| --- | --- |
| `provider-calls-disabled` | Defense-in-depth direct-execution gate. |
| `promotion-target-invalid` | Invalid explicit target descriptor. |
| `promotion-source-invalid` | Invalid source provider/model descriptor. |
| `promotion-target-not-larger` | Target window is not strictly larger. |
| `promotion-provider-incompatible` | Source provider is outside the target allowlist. |
| `promotion-provider-auth-missing` | Target-provider authentication is absent. |
| `promotion-tool-schema-incompatible` | A tool is missing or rejects concrete arguments. |
| `promotion-image-unsupported` | The target cannot accept fixture images. |
| `promotion-context-does-not-fit` | Estimated input exceeds the target window. |
| `promotion-model-unavailable` | The explicit target model is unavailable. |

Credential/model inspection exceptions, estimator failures, invocation failures, and malformed responses return `outcome: "failed"` with stable `promotion-*` codes. Invocation and post-invocation failures explicitly state that no production model/default changed, the detached source remains available, and the caller should continue on the source model or let `runBenchmark` invoke its configured explicit fallback.

The adapter never invokes a hidden fallback. Supply one to the runner when desired:

```ts
const report = await runBenchmark({
  strategy,
  fallbackStrategy: noopBaselineStrategy,
  corpus: FIXED_SYNTHETIC_CORPUS,
  providerCallsAllowed: true,
});
```

## Offline tests

The tests use only injected fakes and make no network requests:

```bash
node --test --experimental-strip-types model-promotion.test.ts
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH tsc --noEmit -p .
```
