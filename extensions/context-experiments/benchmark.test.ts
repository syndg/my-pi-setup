import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_SYNTHETIC_CORPUS,
  SYNTHETIC_LONG_TOOL_OUTPUT,
  noopBaselineStrategy,
  renderBenchmarkJson,
  renderBenchmarkMarkdown,
  runBenchmark,
  scoreContinuationQuality,
  scoreStructuralFidelity,
  type BenchmarkCase,
  type BenchmarkCorpus,
  type ExperimentStrategy,
  type StrategyOutput,
} from "./src/index.ts";

function fixture(id: string): BenchmarkCase {
  const found = FIXED_SYNTHETIC_CORPUS.cases.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(found, `fixture ${id} must exist`);
  return found;
}

function corpus(...cases: readonly BenchmarkCase[]): BenchmarkCorpus {
  return {
    schemaVersion: "context-experiment-corpus/v1",
    id: `test:${cases.map((item) => item.id).join("+")}`,
    description: "Focused test corpus.",
    cases,
  };
}

const providerStrategy: ExperimentStrategy = {
  manifest: {
    id: "test.provider-compaction",
    version: "1",
    label: "Provider test double",
    execution: "provider",
    acceptsImages: false,
    requirements: [
      {
        capability: "provider-compaction",
        reason: "Exercises capability gating.",
      },
    ],
    complexity: {
      setupSteps: 1,
      externalDependencies: 1,
      runtimeServices: 0,
      persistentArtifactKinds: 0,
      migrationRisk: "low",
      notes: [],
    },
  },
  async execute(request) {
    return noopBaselineStrategy.execute(request);
  },
};

test("fixed corpus covers Phase 9 fidelity and compatibility hazards", () => {
  assert.equal(
    FIXED_SYNTHETIC_CORPUS.schemaVersion,
    "context-experiment-corpus/v1",
  );
  assert.equal(FIXED_SYNTHETIC_CORPUS.cases.length, 5);
  const categories = new Set(
    FIXED_SYNTHETIC_CORPUS.cases.flatMap((item) =>
      item.facts.map((fact) => fact.category),
    ),
  );
  assert.deepEqual([...categories].sort(), [
    "artifact-reference",
    "constraint",
    "decision",
    "error",
    "file",
    "goal",
    "next-action",
    "tool-pairing",
  ]);
  assert.ok(Buffer.byteLength(SYNTHETIC_LONG_TOOL_OUTPUT, "utf8") > 75_000);
  assert.ok(
    FIXED_SYNTHETIC_CORPUS.cases.some((item) =>
      item.tags.includes("compaction"),
    ),
  );
  assert.ok(
    FIXED_SYNTHETIC_CORPUS.cases.some((item) => item.tags.includes("image")),
  );
  assert.ok(
    FIXED_SYNTHETIC_CORPUS.cases.some((item) =>
      item.tags.includes("unsupported-provider"),
    ),
  );

  const cases: readonly BenchmarkCase[] = FIXED_SYNTHETIC_CORPUS.cases;
  for (const item of cases) {
    const calls = new Map(
      item.messages.flatMap((message) =>
        (message.toolCalls ?? []).map(
          (call) =>
            [call.id, { messageId: message.id, name: call.name }] as const,
        ),
      ),
    );
    const results = new Map(
      item.messages.flatMap((message) =>
        message.toolResult === undefined
          ? []
          : [
              [
                message.toolResult.callId,
                { messageId: message.id, name: message.toolResult.name },
              ] as const,
            ],
      ),
    );
    for (const pair of item.structural.toolPairs) {
      assert.deepEqual(calls.get(pair.callId), {
        messageId: pair.callMessageId,
        name: pair.toolName,
      });
      assert.deepEqual(results.get(pair.callId), {
        messageId: pair.resultMessageId,
        name: pair.toolName,
      });
    }
  }
});

test("no-op baseline is a perfect, provider-free control", async () => {
  const report = await runBenchmark({
    strategy: noopBaselineStrategy,
    corpus: FIXED_SYNTHETIC_CORPUS,
  });
  assert.equal(report.providerCallsAllowed, false);
  assert.equal(report.aggregate.caseCount, 5);
  assert.equal(report.aggregate.completedCaseCount, 5);
  assert.equal(report.aggregate.fallbackCaseCount, 0);
  assert.equal(report.aggregate.failedCaseCount, 0);
  assert.equal(report.aggregate.meanStructuralFidelity, 100);
  assert.equal(report.aggregate.meanContinuationQuality, 100);
  assert.equal(report.aggregate.totalLatencyMs, 0);
  assert.equal(report.aggregate.totalImageCount, 1);
  assert.equal(report.aggregate.totalImageBytes, 48_000);
  assert.equal(report.aggregate.totalEstimatedCostUsd, null);
  assert.ok(report.aggregate.totalInputTokens > 20_000);
  assert.ok(
    report.results.every((result) => result.providerCompatibility.compatible),
  );
});

test("JSON and Markdown reports are byte-deterministic", async () => {
  const first = await runBenchmark({
    strategy: noopBaselineStrategy,
    corpus: FIXED_SYNTHETIC_CORPUS,
  });
  const second = await runBenchmark({
    strategy: noopBaselineStrategy,
    corpus: FIXED_SYNTHETIC_CORPUS,
  });
  const firstJson = renderBenchmarkJson(first);
  const markdown = renderBenchmarkMarkdown(first);
  assert.equal(first.benchmarkId, second.benchmarkId);
  assert.equal(firstJson, renderBenchmarkJson(second));
  assert.equal(markdown, renderBenchmarkMarkdown(second));
  assert.ok(firstJson.endsWith("\n"));
  assert.ok(markdown.endsWith("\n"));
  assert.deepEqual(
    JSON.parse(firstJson),
    JSON.parse(renderBenchmarkJson(second)),
  );
  assert.match(markdown, /Structural fidelity/);
  assert.match(markdown, /Token\/image cost input/);
  assert.match(markdown, /Failure \/ fallback/);
  assert.doesNotMatch(markdown, /generated at|timestamp/i);
});

test("provider strategies cannot execute unless provider calls are explicitly enabled", async () => {
  let calls = 0;
  const guarded: ExperimentStrategy = {
    ...providerStrategy,
    async execute(request) {
      calls += 1;
      return providerStrategy.execute(request);
    },
  };
  const report = await runBenchmark({
    strategy: guarded,
    corpus: corpus(fixture("state-and-tool-structure")),
  });
  assert.equal(calls, 0);
  assert.equal(
    report.results[0]?.providerCompatibility.providerCallsBlocked,
    true,
  );
  assert.equal(report.results[0]?.failureFallback.primaryOutcome, "blocked");
  assert.equal(
    report.results[0]?.failureFallback.failureCode,
    "provider-calls-disabled",
  );
  assert.equal(report.aggregate.failedCaseCount, 1);
});

test("capability and image incompatibility route to an explicit no-op fallback", async () => {
  let calls = 0;
  const guarded: ExperimentStrategy = {
    ...providerStrategy,
    async execute(request) {
      calls += 1;
      return providerStrategy.execute(request);
    },
  };
  const report = await runBenchmark({
    strategy: guarded,
    corpus: corpus(
      fixture("unsupported-image-input"),
      fixture("unsupported-provider-capabilities"),
    ),
    fallbackStrategy: noopBaselineStrategy,
    providerCallsAllowed: true,
  });
  assert.equal(calls, 0);
  assert.equal(report.aggregate.fallbackCaseCount, 2);
  assert.equal(report.aggregate.failedCaseCount, 0);
  assert.ok(
    report.results.every(
      (result) => result.executedStrategyId === "baseline.noop",
    ),
  );
  assert.ok(
    report.results.every((result) => result.structuralFidelity.score === 100),
  );
  assert.deepEqual(
    report.results.map((result) => result.failureFallback.failureCode),
    ["image-input-unsupported", "missing-provider-capability"],
  );
  assert.equal(
    report.results[0]?.providerCompatibility.imageInputUnsupported,
    true,
  );
  assert.deepEqual(
    report.results[1]?.providerCompatibility.missingCapabilities,
    ["provider-compaction"],
  );
});

test("thrown strategy failures are measured separately from successful fallback", async () => {
  const throwing: ExperimentStrategy = {
    manifest: {
      ...providerStrategy.manifest,
      id: "test.throwing",
      execution: "offline",
      acceptsImages: true,
      requirements: [],
    },
    async execute() {
      throw new Error("synthetic provider failure");
    },
  };
  const report = await runBenchmark({
    strategy: throwing,
    corpus: corpus(fixture("compaction-continuation")),
    fallbackStrategy: noopBaselineStrategy,
  });
  const result = report.results[0];
  assert.equal(result?.failureFallback.primaryOutcome, "failed");
  assert.equal(result?.failureFallback.finalOutcome, "completed");
  assert.equal(result?.failureFallback.fallbackAttempted, true);
  assert.equal(result?.failureFallback.failureCode, "strategy-threw");
  assert.equal(result?.failureFallback.inputPreserved, true);
  assert.equal(result?.structuralFidelity.score, 100);
  assert.equal(result?.continuationQuality.score, 100);
  assert.equal(report.aggregate.fallbackCaseCount, 1);
});

test("scoring detects altered facts, missing structure, and weak continuation", async () => {
  const item = fixture("state-and-tool-structure");
  const baseline = await noopBaselineStrategy.execute({
    fixture: item,
    environment: item.defaultEnvironment,
    providerCallsAllowed: false,
  });
  assert.ok(baseline.output);
  const degraded: StrategyOutput = {
    ...baseline.output,
    preservedFacts: baseline.output.preservedFacts.map((fact) =>
      fact.factId === "fact-error-assert17"
        ? { ...fact, value: "A generic test failed." }
        : fact,
    ),
    structural: {
      ...baseline.output.structural,
      toolPairs: [],
      artifactUris: [],
      unresolvedErrorFactIds: [],
    },
    continuationAnswers: [],
    nextAction: null,
  };
  const structural = scoreStructuralFidelity(item, degraded);
  const continuation = scoreContinuationQuality(item, degraded);
  assert.ok(structural.score < 100);
  assert.deepEqual(structural.alteredFactIds, ["fact-error-assert17"]);
  assert.deepEqual(structural.missingToolCallIds, [
    "call-read-parser",
    "call-run-test",
  ]);
  assert.ok(continuation.score < 25);
  assert.deepEqual(continuation.failedProbeIds, [
    "probe-parser-goal",
    "probe-parser-failure",
    "probe-parser-decision",
  ]);
});
