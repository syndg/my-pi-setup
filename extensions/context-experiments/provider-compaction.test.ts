import assert from "node:assert/strict";
import test from "node:test";
import { noopBaselineStrategy } from "./src/baseline.ts";
import { FIXED_SYNTHETIC_CORPUS } from "./src/corpus.ts";
import { runBenchmark } from "./src/runner.ts";
import {
  LOCAL_STRUCTURED_COMPACTION_FALLBACK,
  PROVIDER_COMPACTION_MANIFEST,
  createProviderCompactionStrategy,
  type ProviderCompactionClient,
  type ProviderCompactionCompletedResponse,
  type ProviderCompactionResponse,
  type ProviderCompactionSupport,
} from "./src/adapters/provider-compaction.ts";
import type {
  BenchmarkCase,
  BenchmarkCorpus,
  BenchmarkEnvironment,
  ExperimentRequest,
} from "./src/types.ts";

function fixture(id = "state-and-tool-structure"): BenchmarkCase {
  const found = FIXED_SYNTHETIC_CORPUS.cases.find((item) => item.id === id);
  assert.ok(found, `fixture ${id} must exist`);
  return found;
}

function corpus(item: BenchmarkCase): BenchmarkCorpus {
  return {
    schemaVersion: "context-experiment-corpus/v1",
    id: `provider-compaction-test:${item.id}`,
    description: "Provider compaction adapter test corpus.",
    cases: [item],
  };
}

const supported: ProviderCompactionSupport = {
  capabilityAvailable: true,
  authenticated: true,
  modelSupported: true,
};

function completed(item: BenchmarkCase): ProviderCompactionCompletedResponse {
  return {
    status: "compacted",
    evidence: {
      preservedFacts: item.facts.map((fact) => ({
        factId: fact.id,
        value: fact.value,
        evidenceRefs: [...fact.evidenceMessageIds],
      })),
      structural: {
        messageOrder: item.messages.map((message) => message.id),
        toolPairs: item.structural.toolPairs.map((pair) => ({ ...pair })),
        artifactUris: [...item.structural.artifactUris],
        unresolvedErrorFactIds: [...item.structural.unresolvedErrorFactIds],
      },
    },
    continuation: {
      answers: item.continuation.probes.map((probe) => ({
        probeId: probe.id,
        answer: probe.expectedAnswer,
        supportingFactIds: [...probe.expectedFactIds],
      })),
      nextAction: item.continuation.exactNextAction,
    },
    latencyMs: 37.5,
    usage: {
      inputTokens: 1_250,
      outputTokens: 180,
      cachedInputTokens: 400,
      imageTokens: null,
    },
    cache: {
      cacheablePrefixTokens: 900,
      cacheReadTokens: 400,
      cacheWriteTokens: 500,
      invalidations: 1,
      epochId: "provider-epoch-7",
    },
    cost: { estimatedCostUsd: 0.0042 },
  };
}

function clientWith(
  response: ProviderCompactionResponse | null | undefined,
  support: ProviderCompactionSupport = supported,
): ProviderCompactionClient {
  return {
    detectSupport() {
      return support;
    },
    async compact() {
      return response;
    },
  };
}

function directRequest(
  item: BenchmarkCase,
  environment = item.defaultEnvironment,
): ExperimentRequest {
  return {
    fixture: item,
    environment,
    providerCallsAllowed: true,
  };
}

function failureOf(
  execution: Awaited<
    ReturnType<ReturnType<typeof createProviderCompactionStrategy>["execute"]>
  >,
) {
  assert.ok(
    execution.outcome === "failed" || execution.outcome === "unsupported",
  );
  return execution.failure;
}

test("manifest is provider-gated and has no default network client", () => {
  assert.equal(PROVIDER_COMPACTION_MANIFEST.execution, "provider");
  assert.equal(PROVIDER_COMPACTION_MANIFEST.acceptsImages, false);
  assert.deepEqual(
    PROVIDER_COMPACTION_MANIFEST.requirements.map((item) => item.capability),
    ["provider-compaction"],
  );
  assert.equal(typeof createProviderCompactionStrategy, "function");
});

test("runner capability gating prevents support detection and provider invocation", async () => {
  const item = fixture();
  let supportChecks = 0;
  let providerCalls = 0;
  const client: ProviderCompactionClient = {
    detectSupport() {
      supportChecks += 1;
      return supported;
    },
    async compact() {
      providerCalls += 1;
      return completed(item);
    },
  };
  const environment: BenchmarkEnvironment = {
    ...item.defaultEnvironment,
    capabilities: item.defaultEnvironment.capabilities.filter(
      (capability) => capability !== "provider-compaction",
    ),
  };
  const report = await runBenchmark({
    strategy: createProviderCompactionStrategy(client),
    corpus: corpus(item),
    providerCallsAllowed: true,
    environmentForCase: () => environment,
  });

  assert.equal(supportChecks, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(
    report.results[0]?.providerCompatibility.missingCapabilities,
    ["provider-compaction"],
  );
  assert.equal(report.results[0]?.failureFallback.primaryOutcome, "blocked");
  assert.equal(
    report.results[0]?.failureFallback.failureCode,
    "missing-provider-capability",
  );
});

test("runner provider-call opt-in blocks the adapter before client detection", async () => {
  const item = fixture();
  let supportChecks = 0;
  let providerCalls = 0;
  const client: ProviderCompactionClient = {
    detectSupport() {
      supportChecks += 1;
      return supported;
    },
    async compact() {
      providerCalls += 1;
      return completed(item);
    },
  };
  const report = await runBenchmark({
    strategy: createProviderCompactionStrategy(client),
    corpus: corpus(item),
  });

  assert.equal(supportChecks, 0);
  assert.equal(providerCalls, 0);
  assert.equal(
    report.results[0]?.providerCompatibility.providerCallsBlocked,
    true,
  );
  assert.equal(
    report.results[0]?.failureFallback.failureCode,
    "provider-calls-disabled",
  );
});

test("successful response maps evidence, continuation, usage, cache, and cost", async () => {
  const item = fixture();
  const fixtureBefore = JSON.stringify(item);
  let providerCalls = 0;
  const client: ProviderCompactionClient = {
    detectSupport(request) {
      assert.equal(request.providerId, item.defaultEnvironment.providerId);
      assert.equal(request.modelId, item.defaultEnvironment.modelId);
      assert.equal(Object.isFrozen(request.environmentCapabilities), true);
      return supported;
    },
    async compact(request) {
      providerCalls += 1;
      assert.equal(request.schemaVersion, "provider-compaction-request/v1");
      assert.notEqual(request.transcript, item.messages);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.transcript), true);
      assert.equal(Object.isFrozen(request.transcript[0]), true);
      const call = request.transcript.flatMap(
        (message) => message.toolCalls ?? [],
      )[0];
      assert.ok(call);
      assert.equal(Object.isFrozen(call.arguments), true);
      assert.deepEqual(
        request.continuationProbes,
        item.continuation.probes.map((probe) => ({
          id: probe.id,
          prompt: probe.prompt,
        })),
      );
      return completed(item);
    },
  };
  const execution = await createProviderCompactionStrategy(client).execute(
    directRequest(item),
  );

  assert.equal(providerCalls, 1);
  assert.equal(JSON.stringify(item), fixtureBefore);
  assert.equal(execution.outcome, "completed");
  assert.ok(execution.output);
  assert.equal(execution.output.preservedFacts.length, item.facts.length);
  assert.equal(execution.output.nextAction, item.continuation.exactNextAction);
  assert.deepEqual(execution.measurements, {
    latencyMs: 37.5,
    cost: {
      inputTokens: 1_250,
      outputTokens: 180,
      cachedInputTokens: 400,
      imageCount: 0,
      imageBytes: 0,
      imageTokens: null,
      estimatedCostUsd: 0.0042,
    },
    cache: {
      cacheablePrefixTokens: 900,
      cacheReadTokens: 400,
      cacheWriteTokens: 500,
      invalidations: 1,
      epochId: "provider-epoch-7",
    },
  });
  assert.equal(Object.isFrozen(execution.output), true);
  assert.equal(Object.isFrozen(execution.output.preservedFacts), true);
});

test("empty and malformed provider results return stable input-preserving failures", async (t) => {
  const item = fixture();
  await t.test("empty", async () => {
    const execution = await createProviderCompactionStrategy(
      clientWith(null),
    ).execute(directRequest(item));
    const failure = failureOf(execution);
    assert.equal(execution.outcome, "failed");
    assert.equal(failure.code, "provider-compaction-empty-response");
    assert.equal(failure.inputPreserved, true);
    assert.equal(
      failure.suggestedFallback,
      LOCAL_STRUCTURED_COMPACTION_FALLBACK,
    );
  });

  await t.test("malformed", async () => {
    const malformed = {
      ...completed(item),
      usage: { ...completed(item).usage, inputTokens: -1 },
    } as unknown as ProviderCompactionResponse;
    const execution = await createProviderCompactionStrategy(
      clientWith(malformed),
    ).execute(directRequest(item));
    const failure = failureOf(execution);
    assert.equal(execution.outcome, "failed");
    assert.equal(failure.code, "provider-compaction-malformed-response");
    assert.equal(failure.inputPreserved, true);
    assert.equal(
      failure.suggestedFallback,
      LOCAL_STRUCTURED_COMPACTION_FALLBACK,
    );
  });
});

test("client capability, auth, model, and unsupported response detection never compacts", async (t) => {
  const item = fixture();
  const cases = [
    [
      { ...supported, capabilityAvailable: false },
      "provider-compaction-unavailable",
    ],
    [
      { ...supported, authenticated: false },
      "provider-compaction-auth-unavailable",
    ],
    [
      { ...supported, modelSupported: false },
      "provider-compaction-model-unsupported",
    ],
  ] as const;

  for (const [support, expectedCode] of cases) {
    await t.test(expectedCode, async () => {
      let calls = 0;
      const client: ProviderCompactionClient = {
        detectSupport() {
          return support;
        },
        async compact() {
          calls += 1;
          return completed(item);
        },
      };
      const execution = await createProviderCompactionStrategy(client).execute(
        directRequest(item),
      );
      assert.equal(calls, 0);
      assert.equal(execution.outcome, "unsupported");
      assert.equal(failureOf(execution).code, expectedCode);
      assert.equal(failureOf(execution).inputPreserved, true);
    });
  }

  await t.test("provider unsupported result", async () => {
    const execution = await createProviderCompactionStrategy(
      clientWith({
        status: "unsupported",
        reason: "native compaction disabled for this account",
      }),
    ).execute(directRequest(item));
    assert.equal(execution.outcome, "unsupported");
    assert.equal(failureOf(execution).code, "provider-compaction-unsupported");
    assert.equal(
      failureOf(execution).suggestedFallback,
      LOCAL_STRUCTURED_COMPACTION_FALLBACK,
    );
  });
});

test("provider rejection is stable and explicit runner fallback receives the preserved fixture", async () => {
  const item = fixture();
  const client: ProviderCompactionClient = {
    detectSupport() {
      return supported;
    },
    async compact() {
      throw new Error("synthetic provider refusal");
    },
  };
  const strategy = createProviderCompactionStrategy(client);
  const direct = await strategy.execute(directRequest(item));
  assert.equal(direct.outcome, "failed");
  assert.equal(failureOf(direct).code, "provider-compaction-rejected");
  assert.equal(failureOf(direct).inputPreserved, true);
  assert.equal(
    failureOf(direct).suggestedFallback,
    LOCAL_STRUCTURED_COMPACTION_FALLBACK,
  );

  const report = await runBenchmark({
    strategy,
    corpus: corpus(item),
    fallbackStrategy: noopBaselineStrategy,
    providerCallsAllowed: true,
  });
  const result = report.results[0];
  assert.equal(result?.failureFallback.primaryOutcome, "failed");
  assert.equal(result?.failureFallback.fallbackAttempted, true);
  assert.equal(result?.failureFallback.fallbackStrategyId, "baseline.noop");
  assert.equal(result?.failureFallback.inputPreserved, true);
  assert.equal(
    result?.failureFallback.failureCode,
    "provider-compaction-rejected",
  );
  assert.equal(result?.structuralFidelity.score, 100);
  assert.equal(result?.continuationQuality.score, 100);
});

test("runner reports provider accounting without inventing image accounting", async () => {
  const item = fixture();
  const report = await runBenchmark({
    strategy: createProviderCompactionStrategy(clientWith(completed(item))),
    corpus: corpus(item),
    providerCallsAllowed: true,
  });

  assert.equal(report.aggregate.completedCaseCount, 1);
  assert.equal(report.aggregate.totalLatencyMs, 37.5);
  assert.equal(report.aggregate.totalInputTokens, 1_250);
  assert.equal(report.aggregate.totalOutputTokens, 180);
  assert.equal(report.aggregate.totalEstimatedCostUsd, 0.0042);
  assert.deepEqual(report.results[0]?.cacheInput, completed(item).cache);
  assert.equal(report.results[0]?.structuralFidelity.score, 100);
  assert.equal(report.results[0]?.continuationQuality.score, 100);
});
