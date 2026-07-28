import { createHash } from "node:crypto";
import { canonicalCompactJson } from "./canonical.ts";
import {
  scoreContinuationQuality,
  scoreOperationalComplexity,
  scoreStructuralFidelity,
} from "./core.ts";
import type {
  BenchmarkAggregate,
  BenchmarkCase,
  BenchmarkCaseResult,
  BenchmarkEnvironment,
  BenchmarkReport,
  BenchmarkRunInput,
  ExperimentFailure,
  ExperimentStrategy,
  ProviderCompatibilityMetric,
  StrategyExecution,
  StrategyMeasurements,
} from "./types.ts";

interface Attempt {
  readonly execution: StrategyExecution;
  readonly blocked: boolean;
}

function hasImages(fixture: BenchmarkCase) {
  return fixture.messages.some((message) => (message.images?.length ?? 0) > 0);
}

function compatibility(
  strategy: ExperimentStrategy,
  fixture: BenchmarkCase,
  environment: BenchmarkEnvironment,
  providerCallsAllowed: boolean,
): ProviderCompatibilityMetric {
  const available = new Set(environment.capabilities);
  const missingCapabilities = strategy.manifest.requirements
    .map((requirement) => requirement.capability)
    .filter(
      (capability, index, values) =>
        !available.has(capability) && values.indexOf(capability) === index,
    );
  const imageInputUnsupported =
    hasImages(fixture) && !strategy.manifest.acceptsImages;
  const providerCallsBlocked =
    strategy.manifest.execution === "provider" && !providerCallsAllowed;
  return Object.freeze({
    compatible:
      missingCapabilities.length === 0 &&
      !imageInputUnsupported &&
      !providerCallsBlocked,
    providerId: environment.providerId,
    modelId: environment.modelId,
    missingCapabilities: Object.freeze(missingCapabilities),
    providerCallsBlocked,
    imageInputUnsupported,
  });
}

function failed(
  code: string,
  message: string,
  inputPreserved = true,
): StrategyExecution {
  return Object.freeze({
    outcome:
      code === "strategy-threw" || code === "invalid-measurements"
        ? "failed"
        : "unsupported",
    failure: Object.freeze({ code, message, retriable: false, inputPreserved }),
  });
}

function measurementsValid(measurements: StrategyMeasurements | undefined) {
  if (measurements === undefined) return false;
  const values = [
    measurements.latencyMs,
    measurements.cost.inputTokens,
    measurements.cost.outputTokens,
    measurements.cost.cachedInputTokens,
    measurements.cost.imageCount,
    measurements.cost.imageBytes,
    measurements.cache.cacheablePrefixTokens,
    measurements.cache.cacheReadTokens,
    measurements.cache.cacheWriteTokens,
    measurements.cache.invalidations,
  ];
  if (measurements.cost.imageTokens !== null)
    values.push(measurements.cost.imageTokens);
  if (measurements.cost.estimatedCostUsd !== null)
    values.push(measurements.cost.estimatedCostUsd);
  return values.every((value) => Number.isFinite(value) && value >= 0);
}

async function attempt(
  strategy: ExperimentStrategy,
  fixture: BenchmarkCase,
  environment: BenchmarkEnvironment,
  providerCallsAllowed: boolean,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  const gate = compatibility(
    strategy,
    fixture,
    environment,
    providerCallsAllowed,
  );
  if (gate.providerCallsBlocked) {
    return {
      execution: failed(
        "provider-calls-disabled",
        "Provider execution is disabled by the benchmark runner.",
      ),
      blocked: true,
    };
  }
  if (gate.imageInputUnsupported) {
    return {
      execution: failed(
        "image-input-unsupported",
        "The strategy does not accept an image-bearing fixture.",
      ),
      blocked: true,
    };
  }
  if (gate.missingCapabilities.length > 0) {
    return {
      execution: failed(
        "missing-provider-capability",
        `Missing provider capabilities: ${gate.missingCapabilities.join(", ")}.`,
      ),
      blocked: true,
    };
  }
  try {
    const execution = await strategy.execute({
      fixture,
      environment,
      providerCallsAllowed,
      ...(signal ? { signal } : {}),
    });
    if (
      (execution.outcome === "completed" || execution.outcome === "fallback") &&
      !measurementsValid(execution.measurements)
    ) {
      return {
        execution: failed(
          "invalid-measurements",
          "Completed strategy executions require finite, non-negative measurements.",
        ),
        blocked: false,
      };
    }
    if (
      execution.measurements !== undefined &&
      !measurementsValid(execution.measurements)
    ) {
      return {
        execution: failed(
          "invalid-measurements",
          "Strategy measurements must be finite and non-negative.",
        ),
        blocked: false,
      };
    }
    return { execution, blocked: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { execution: failed("strategy-threw", message), blocked: false };
  }
}

function combineMeasurements(
  primary: StrategyMeasurements | undefined,
  fallback: StrategyMeasurements | undefined,
): StrategyMeasurements | undefined {
  if (primary === undefined) return fallback;
  if (fallback === undefined) return primary;
  const primaryCost = primary.cost;
  const fallbackCost = fallback.cost;
  const monetary =
    primaryCost.estimatedCostUsd === null &&
    fallbackCost.estimatedCostUsd === null
      ? null
      : (primaryCost.estimatedCostUsd ?? 0) +
        (fallbackCost.estimatedCostUsd ?? 0);
  const imageTokens =
    primaryCost.imageTokens === null && fallbackCost.imageTokens === null
      ? null
      : (primaryCost.imageTokens ?? 0) + (fallbackCost.imageTokens ?? 0);
  return Object.freeze({
    latencyMs: primary.latencyMs + fallback.latencyMs,
    cost: Object.freeze({
      inputTokens: primaryCost.inputTokens + fallbackCost.inputTokens,
      outputTokens: primaryCost.outputTokens + fallbackCost.outputTokens,
      cachedInputTokens:
        primaryCost.cachedInputTokens + fallbackCost.cachedInputTokens,
      imageCount: primaryCost.imageCount + fallbackCost.imageCount,
      imageBytes: primaryCost.imageBytes + fallbackCost.imageBytes,
      imageTokens,
      estimatedCostUsd: monetary,
    }),
    cache: Object.freeze({
      cacheablePrefixTokens: fallback.cache.cacheablePrefixTokens,
      cacheReadTokens:
        primary.cache.cacheReadTokens + fallback.cache.cacheReadTokens,
      cacheWriteTokens:
        primary.cache.cacheWriteTokens + fallback.cache.cacheWriteTokens,
      invalidations: primary.cache.invalidations + fallback.cache.invalidations,
      epochId: fallback.cache.epochId,
    }),
  });
}

function aggregate(
  results: readonly BenchmarkCaseResult[],
): BenchmarkAggregate {
  const failedCount = results.filter(
    (result) =>
      result.failureFallback.finalOutcome === "failed" ||
      result.failureFallback.finalOutcome === "unsupported",
  ).length;
  const fallback = results.filter(
    (result) =>
      result.failureFallback.finalOutcome !== "failed" &&
      result.failureFallback.finalOutcome !== "unsupported" &&
      (result.failureFallback.fallbackAttempted ||
        result.failureFallback.finalOutcome === "fallback"),
  ).length;
  const completed = results.length - failedCount - fallback;
  const costs = results.flatMap((result) =>
    result.costInput ? [result.costInput] : [],
  );
  const monetaryValues = costs
    .map((cost) => cost.estimatedCostUsd)
    .filter((value): value is number => value !== null);
  const divisor = Math.max(1, results.length);
  return Object.freeze({
    caseCount: results.length,
    completedCaseCount: completed,
    fallbackCaseCount: fallback,
    failedCaseCount: failedCount,
    meanStructuralFidelity:
      Math.round(
        (results.reduce(
          (sum, result) => sum + result.structuralFidelity.score,
          0,
        ) /
          divisor) *
          10_000,
      ) / 10_000,
    meanContinuationQuality:
      Math.round(
        (results.reduce(
          (sum, result) => sum + result.continuationQuality.score,
          0,
        ) /
          divisor) *
          10_000,
      ) / 10_000,
    totalLatencyMs: results.reduce(
      (sum, result) => sum + (result.latencyMs ?? 0),
      0,
    ),
    totalInputTokens: costs.reduce((sum, cost) => sum + cost.inputTokens, 0),
    totalOutputTokens: costs.reduce((sum, cost) => sum + cost.outputTokens, 0),
    totalImageCount: costs.reduce((sum, cost) => sum + cost.imageCount, 0),
    totalImageBytes: costs.reduce((sum, cost) => sum + cost.imageBytes, 0),
    totalEstimatedCostUsd:
      monetaryValues.length === 0
        ? null
        : monetaryValues.reduce((sum, value) => sum + value, 0),
    compatibleCaseCount: results.filter(
      (result) => result.providerCompatibility.compatible,
    ).length,
  });
}

function benchmarkId(input: {
  readonly corpus: BenchmarkRunInput["corpus"];
  readonly strategy: ExperimentStrategy;
  readonly fallbackStrategy: ExperimentStrategy | undefined;
  readonly providerCallsAllowed: boolean;
  readonly environments: readonly BenchmarkEnvironment[];
}) {
  const seed = canonicalCompactJson({
    corpus: input.corpus,
    strategy: input.strategy.manifest,
    fallback: input.fallbackStrategy?.manifest ?? null,
    providerCallsAllowed: input.providerCallsAllowed,
    environments: input.environments,
  });
  return `bench-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function failureOf(
  execution: StrategyExecution,
): ExperimentFailure | undefined {
  return "failure" in execution ? execution.failure : undefined;
}

export async function runBenchmark(
  input: BenchmarkRunInput,
): Promise<BenchmarkReport> {
  const providerCallsAllowed = input.providerCallsAllowed ?? false;
  if (input.fallbackStrategy?.manifest.id === input.strategy.manifest.id) {
    throw new Error(
      "Fallback strategy must have a different manifest id from the primary strategy.",
    );
  }
  const environments = input.corpus.cases.map(
    (fixture) =>
      input.environmentForCase?.(fixture) ?? fixture.defaultEnvironment,
  );
  const results: BenchmarkCaseResult[] = [];

  for (let index = 0; index < input.corpus.cases.length; index += 1) {
    const fixture = input.corpus.cases[index] as BenchmarkCase;
    const environment = environments[index] as BenchmarkEnvironment;
    const primaryCompatibility = compatibility(
      input.strategy,
      fixture,
      environment,
      providerCallsAllowed,
    );
    const primary = await attempt(
      input.strategy,
      fixture,
      environment,
      providerCallsAllowed,
      input.signal,
    );
    let final = primary.execution;
    let executedStrategy = input.strategy;
    let fallbackAttempted = false;
    let combined = primary.execution.measurements;

    if (
      (primary.execution.outcome === "unsupported" ||
        primary.execution.outcome === "failed") &&
      input.fallbackStrategy !== undefined
    ) {
      fallbackAttempted = true;
      executedStrategy = input.fallbackStrategy;
      const fallback = await attempt(
        input.fallbackStrategy,
        fixture,
        environment,
        providerCallsAllowed,
        input.signal,
      );
      final = fallback.execution;
      combined = combineMeasurements(
        primary.execution.measurements,
        fallback.execution.measurements,
      );
    }

    const primaryFailure = failureOf(primary.execution);
    const finalFailure = failureOf(final);
    results.push(
      Object.freeze({
        caseId: fixture.id,
        title: fixture.title,
        primaryStrategyId: input.strategy.manifest.id,
        executedStrategyId: executedStrategy.manifest.id,
        structuralFidelity: scoreStructuralFidelity(fixture, final.output),
        continuationQuality: scoreContinuationQuality(fixture, final.output),
        latencyMs: combined?.latencyMs ?? null,
        costInput: combined?.cost ?? null,
        cacheInput: combined?.cache ?? null,
        providerCompatibility: primaryCompatibility,
        operationalComplexity: scoreOperationalComplexity(
          input.strategy.manifest.complexity,
        ),
        failureFallback: Object.freeze({
          primaryOutcome: primary.blocked
            ? "blocked"
            : primary.execution.outcome,
          finalOutcome: final.outcome,
          fallbackAttempted,
          fallbackStrategyId: fallbackAttempted
            ? (input.fallbackStrategy?.manifest.id ?? null)
            : null,
          failureCode: primaryFailure?.code ?? finalFailure?.code ?? null,
          inputPreserved:
            (primaryFailure?.inputPreserved ?? true) &&
            (finalFailure?.inputPreserved ?? true),
        }),
      }),
    );
  }

  return Object.freeze({
    schemaVersion: "context-experiment-report/v1",
    benchmarkId: benchmarkId({
      corpus: input.corpus,
      strategy: input.strategy,
      fallbackStrategy: input.fallbackStrategy,
      providerCallsAllowed,
      environments,
    }),
    corpusId: input.corpus.id,
    strategy: input.strategy.manifest,
    fallbackStrategy: input.fallbackStrategy?.manifest ?? null,
    providerCallsAllowed,
    results: Object.freeze(results),
    aggregate: aggregate(results),
  });
}
