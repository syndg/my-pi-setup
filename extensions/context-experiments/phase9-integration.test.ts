import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_SYNTHETIC_CORPUS,
  createModelPromotionStrategy,
  createProviderCompactionStrategy,
  createSnapcompactStrategy,
  noopBaselineStrategy,
  renderBenchmarkJson,
  runBenchmark,
  type BenchmarkCase,
  type BenchmarkReport,
  type PromotionClient,
  type PromotionInvocationResult,
  type PromotionTargetDescriptor,
  type ProviderCompactionClient,
  type ProviderCompactionCompletedResponse,
  type SnapcompactEvidence,
  type VisionEvaluator,
  type VisionEvaluatorRequest,
} from "./src/index.ts";

const caseById: ReadonlyMap<string, BenchmarkCase> = new Map(
  FIXED_SYNTHETIC_CORPUS.cases.map((fixture) => [fixture.id, fixture]),
);

function fixture(id: string): BenchmarkCase {
  const found = caseById.get(id);
  assert.ok(found, `fixture ${id} must exist`);
  return found;
}

function exactOutput(item: BenchmarkCase) {
  return {
    preservedFacts: item.facts.map((fact) => ({
      factId: fact.id,
      value: fact.value,
      evidenceRefs: [...fact.evidenceMessageIds],
    })),
    structural: {
      messageOrder: [...item.structural.requiredMessageOrder],
      toolPairs: item.structural.toolPairs.map((pair) => ({ ...pair })),
      artifactUris: [...item.structural.artifactUris],
      unresolvedErrorFactIds: [...item.structural.unresolvedErrorFactIds],
    },
    continuationAnswers: item.continuation.probes.map((probe) => ({
      probeId: probe.id,
      answer: probe.expectedAnswer,
      supportingFactIds: [...probe.expectedFactIds],
    })),
    nextAction: item.continuation.exactNextAction,
  };
}

function snapcompactEvidence(
  item: BenchmarkCase,
  request: VisionEvaluatorRequest,
): SnapcompactEvidence {
  const indexIdsFor = (messageIds: readonly string[]) =>
    request.textIndex
      .filter((entry) => messageIds.includes(entry.messageId))
      .map((entry) => entry.id);
  return {
    facts: item.facts.map((fact) => ({
      factId: fact.id,
      value: fact.value,
      sourceTextIndexIds: indexIdsFor(fact.evidenceMessageIds),
    })),
    messageOrder: [...item.structural.requiredMessageOrder],
    toolPairs: item.structural.toolPairs.map((pair) => ({ ...pair })),
    artifactUris: [...item.structural.artifactUris],
    unresolvedErrorFactIds: [...item.structural.unresolvedErrorFactIds],
    continuationAnswers: item.continuation.probes.map((probe) => ({
      probeId: probe.id,
      answer: probe.expectedAnswer,
      supportingFactIds: [...probe.expectedFactIds],
    })),
    nextAction: item.continuation.exactNextAction,
  };
}

function providerResponse(
  item: BenchmarkCase,
): ProviderCompactionCompletedResponse {
  const output = exactOutput(item);
  return {
    status: "compacted",
    evidence: {
      preservedFacts: output.preservedFacts,
      structural: output.structural,
    },
    continuation: {
      answers: output.continuationAnswers,
      nextAction: output.nextAction,
    },
    latencyMs: 20,
    usage: {
      inputTokens: 200,
      outputTokens: 20,
      cachedInputTokens: 30,
      imageTokens: null,
    },
    cache: {
      cacheablePrefixTokens: 150,
      cacheReadTokens: 30,
      cacheWriteTokens: 120,
      invalidations: 1,
      epochId: "fake-provider-epoch",
    },
    cost: { estimatedCostUsd: 0.002 },
  };
}

function promotionResult(item: BenchmarkCase): PromotionInvocationResult {
  return {
    evidence: exactOutput(item),
    latencyMs: 30,
    usage: {
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 40,
      imageTokens: null,
      estimatedCostUsd: 0.003,
    },
    cache: {
      cacheablePrefixTokens: 260,
      cacheReadTokens: 40,
      cacheWriteTokens: 220,
      invalidations: 0,
      epochId: "fake-promotion-epoch",
    },
  };
}

const promotionTarget: PromotionTargetDescriptor = {
  providerId: "fake/offline-provider",
  modelId: "fake-1m",
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
    {
      name: "bash",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "rg",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern", "path"],
        additionalProperties: false,
      },
    },
  ],
};

function assertSharedContract(
  report: BenchmarkReport,
  control: BenchmarkReport,
  expectedFallbackCodes: readonly string[],
) {
  assert.equal(report.providerCallsAllowed, true);
  assert.equal(report.aggregate.caseCount, 5);
  assert.equal(report.aggregate.completedCaseCount, 3);
  assert.equal(report.aggregate.fallbackCaseCount, 2);
  assert.equal(report.aggregate.failedCaseCount, 0);
  assert.equal(report.aggregate.compatibleCaseCount, 3);
  assert.equal(
    report.aggregate.meanStructuralFidelity,
    control.aggregate.meanStructuralFidelity,
  );
  assert.equal(
    report.aggregate.meanContinuationQuality,
    control.aggregate.meanContinuationQuality,
  );
  assert.equal(report.aggregate.meanStructuralFidelity, 100);
  assert.equal(report.aggregate.meanContinuationQuality, 100);
  assert.ok(
    report.aggregate.totalInputTokens < control.aggregate.totalInputTokens,
  );
  assert.deepEqual(
    report.results.slice(3).map((result) => result.failureFallback.failureCode),
    expectedFallbackCodes,
  );
  assert.ok(
    report.results
      .slice(3)
      .every(
        (result) =>
          result.failureFallback.fallbackAttempted &&
          result.failureFallback.fallbackStrategyId ===
            noopBaselineStrategy.manifest.id &&
          result.executedStrategyId === noopBaselineStrategy.manifest.id &&
          result.failureFallback.inputPreserved,
      ),
  );
}

test("all Phase 9 adapters run the fixed corpus deterministically through public injected seams", async () => {
  const control = await runBenchmark({
    strategy: noopBaselineStrategy,
    corpus: FIXED_SYNTHETIC_CORPUS,
  });
  assert.equal(control.aggregate.totalInputTokens, 24_498);

  let snapcompactCalls = 0;
  const evaluator: VisionEvaluator = {
    async evaluate(request) {
      snapcompactCalls += 1;
      const item = fixture(request.fixtureId);
      return {
        outcome: "completed",
        evidence: snapcompactEvidence(item, request),
        usage: {
          latencyMs: 10,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 20,
          imageTokens: 50,
          estimatedCostUsd: 0.001,
          cache: {
            cacheablePrefixTokens: 80,
            cacheReadTokens: 20,
            cacheWriteTokens: 60,
            invalidations: 0,
            epochId: "fake-snapcompact-epoch",
          },
        },
      };
    },
  };
  const snapcompact = createSnapcompactStrategy({ evaluator });

  let providerSupportChecks = 0;
  let providerCompactionCalls = 0;
  const providerClient: ProviderCompactionClient = {
    detectSupport() {
      providerSupportChecks += 1;
      return {
        capabilityAvailable: true,
        authenticated: true,
        modelSupported: true,
      };
    },
    async compact(request) {
      providerCompactionCalls += 1;
      return providerResponse(fixture(request.fixtureId));
    },
  };
  const providerCompaction = createProviderCompactionStrategy(providerClient);

  let promotionAuthChecks = 0;
  let promotionAvailabilityChecks = 0;
  let promotionCalls = 0;
  const promotionClient: PromotionClient = {
    hasProviderAuth() {
      promotionAuthChecks += 1;
      return true;
    },
    isModelAvailable() {
      promotionAvailabilityChecks += 1;
      return true;
    },
    async promote(request) {
      promotionCalls += 1;
      assert.equal(request.target.modelId, promotionTarget.modelId);
      return promotionResult(request.fixture);
    },
  };
  const promotion = createModelPromotionStrategy({
    client: promotionClient,
    target: promotionTarget,
  });

  const runTwice = async (strategy: typeof snapcompact) => {
    const input = {
      strategy,
      corpus: FIXED_SYNTHETIC_CORPUS,
      fallbackStrategy: noopBaselineStrategy,
      providerCallsAllowed: true,
    } as const;
    const first = await runBenchmark(input);
    const second = await runBenchmark(input);
    assert.equal(first.benchmarkId, second.benchmarkId);
    assert.equal(renderBenchmarkJson(first), renderBenchmarkJson(second));
    return first;
  };

  const snapcompactReport = await runTwice(snapcompact);
  const providerReport = await runTwice(providerCompaction);
  const promotionReport = await runTwice(promotion);

  assert.equal(snapcompactCalls, 6);
  assert.equal(providerSupportChecks, 6);
  assert.equal(providerCompactionCalls, 6);
  assert.equal(promotionAuthChecks, 6);
  assert.equal(promotionAvailabilityChecks, 6);
  assert.equal(promotionCalls, 6);

  assertSharedContract(snapcompactReport, control, [
    "missing-provider-capability",
    "missing-provider-capability",
  ]);
  assertSharedContract(providerReport, control, [
    "image-input-unsupported",
    "missing-provider-capability",
  ]);
  assertSharedContract(promotionReport, control, [
    "missing-provider-capability",
    "missing-provider-capability",
  ]);

  assert.deepEqual(
    {
      latencyMs: snapcompactReport.aggregate.totalLatencyMs,
      inputTokens: snapcompactReport.aggregate.totalInputTokens,
      outputTokens: snapcompactReport.aggregate.totalOutputTokens,
      estimatedCostUsd: snapcompactReport.aggregate.totalEstimatedCostUsd,
    },
    {
      latencyMs: 30,
      inputTokens: 494,
      outputTokens: 30,
      estimatedCostUsd: 0.003,
    },
  );
  assert.deepEqual(snapcompactReport.results[0]?.cacheInput, {
    cacheablePrefixTokens: 80,
    cacheReadTokens: 20,
    cacheWriteTokens: 60,
    invalidations: 0,
    epochId: "fake-snapcompact-epoch",
  });
  assert.ok(
    snapcompactReport.aggregate.totalImageCount >
      control.aggregate.totalImageCount,
  );
  assert.ok(
    snapcompactReport.aggregate.totalImageBytes >
      control.aggregate.totalImageBytes,
  );

  assert.deepEqual(
    {
      latencyMs: providerReport.aggregate.totalLatencyMs,
      inputTokens: providerReport.aggregate.totalInputTokens,
      outputTokens: providerReport.aggregate.totalOutputTokens,
      imageCount: providerReport.aggregate.totalImageCount,
      imageBytes: providerReport.aggregate.totalImageBytes,
      estimatedCostUsd: providerReport.aggregate.totalEstimatedCostUsd,
    },
    {
      latencyMs: 60,
      inputTokens: 794,
      outputTokens: 60,
      imageCount: 1,
      imageBytes: 48_000,
      estimatedCostUsd: 0.006,
    },
  );
  assert.deepEqual(providerReport.results[0]?.cacheInput, {
    cacheablePrefixTokens: 150,
    cacheReadTokens: 30,
    cacheWriteTokens: 120,
    invalidations: 1,
    epochId: "fake-provider-epoch",
  });

  assert.deepEqual(
    {
      latencyMs: promotionReport.aggregate.totalLatencyMs,
      inputTokens: promotionReport.aggregate.totalInputTokens,
      outputTokens: promotionReport.aggregate.totalOutputTokens,
      imageCount: promotionReport.aggregate.totalImageCount,
      imageBytes: promotionReport.aggregate.totalImageBytes,
      estimatedCostUsd: promotionReport.aggregate.totalEstimatedCostUsd,
    },
    {
      latencyMs: 90,
      inputTokens: 1_094,
      outputTokens: 90,
      imageCount: 1,
      imageBytes: 48_000,
      estimatedCostUsd: 0.009000000000000001,
    },
  );
  assert.deepEqual(promotionReport.results[0]?.cacheInput, {
    cacheablePrefixTokens: 260,
    cacheReadTokens: 40,
    cacheWriteTokens: 220,
    invalidations: 1,
    epochId: "fake-promotion-epoch",
  });
});
