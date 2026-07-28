import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_SYNTHETIC_CORPUS } from "./src/corpus.ts";
import { runBenchmark } from "./src/runner.ts";
import type {
  BenchmarkCase,
  BenchmarkCorpus,
  BenchmarkEnvironment,
  ExperimentRequest,
} from "./src/types.ts";
import {
  createSnapcompactStrategy,
  type SnapcompactEvidence,
  type VisionEvaluator,
  type VisionEvaluatorRequest,
  type VisionEvaluatorUsage,
} from "./src/adapters/snapcompact.ts";
import {
  createDeterministicSnapcompactRenderer,
  type SnapcompactFrameRenderer,
} from "./src/adapters/snapcompact-renderer.ts";

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
    id: `snapcompact-test:${cases.map((item) => item.id).join("+")}`,
    description: "Focused Snapcompact corpus.",
    cases,
  };
}

const FULL_ENVIRONMENT: BenchmarkEnvironment = {
  providerId: "test/vision",
  modelId: "test-vision-1",
  contextWindowTokens: 128_000,
  capabilities: ["image-input", "token-usage", "cache-metrics"],
};

const USAGE: VisionEvaluatorUsage = Object.freeze({
  latencyMs: 37,
  inputTokens: 211,
  outputTokens: 43,
  cachedInputTokens: 89,
  imageTokens: 512,
  estimatedCostUsd: 0.0042,
  cache: Object.freeze({
    cacheablePrefixTokens: 144,
    cacheReadTokens: 89,
    cacheWriteTokens: 55,
    invalidations: 1,
    epochId: "snapcompact-test-epoch",
  }),
});

function evidenceFor(
  item: BenchmarkCase,
  request: VisionEvaluatorRequest,
): SnapcompactEvidence {
  const indexIdsForMessages = (messageIds: readonly string[]) =>
    request.textIndex
      .filter((entry) => messageIds.includes(entry.messageId))
      .map((entry) => entry.id);
  return {
    facts: item.facts.map((fact) => ({
      factId: fact.id,
      value: fact.value,
      sourceTextIndexIds: indexIdsForMessages(fact.evidenceMessageIds),
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

function perfectEvaluator(
  item: BenchmarkCase,
  observe?: (request: VisionEvaluatorRequest) => void,
): VisionEvaluator {
  return {
    async evaluate(request) {
      observe?.(request);
      return {
        outcome: "completed",
        evidence: evidenceFor(item, request),
        usage: USAGE,
      };
    },
  };
}

function requestFor(
  item: BenchmarkCase,
  providerCallsAllowed: boolean,
): ExperimentRequest {
  return {
    fixture: item,
    environment: FULL_ENVIRONMENT,
    providerCallsAllowed,
  };
}

test("deterministic renderer emits byte-stable valid PNG frames, text index, and artifact references", async () => {
  const item = fixture("state-and-tool-structure");
  const renderer = createDeterministicSnapcompactRenderer({
    columns: 48,
    rowsPerFrame: 10,
  });
  const first = await renderer.render(item);
  const second = await renderer.render(item);

  assert.ok(first.frames.length > 1);
  assert.deepEqual(first.textIndex, second.textIndex);
  assert.deepEqual(first.artifactReferences, second.artifactReferences);
  assert.deepEqual(
    first.frames.map((frame) => ({
      ...frame,
      png: Buffer.from(frame.png).toString("base64"),
    })),
    second.frames.map((frame) => ({
      ...frame,
      png: Buffer.from(frame.png).toString("base64"),
    })),
  );
  assert.deepEqual(
    first.artifactReferences.map((reference) => reference.uri),
    [
      "context://aaaaaaaaaaaaaaaaaaaaaaaa/parser-source",
      "context://bbbbbbbbbbbbbbbbbbbbbbbb/parser-test-log",
    ],
  );
  assert.deepEqual(
    first.textIndex.map((entry) => entry.ordinal),
    first.textIndex.map((_, index) => index),
  );
  assert.ok(
    first.textIndex.every(
      (entry) => entry.frameIds.length > 0 && entry.textSha256.length === 64,
    ),
  );

  for (const frame of first.frames) {
    assert.equal(frame.mimeType, "image/png");
    assert.equal(frame.bytes, frame.png.byteLength);
    assert.deepEqual(
      [...frame.png.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(
      Buffer.from(frame.png).subarray(-8, -4).toString("ascii"),
      "IEND",
    );
  }
});

test("vision evidence maps through stable text-index IDs to perfect strategy fidelity", async () => {
  const item = fixture("state-and-tool-structure");
  let observed: VisionEvaluatorRequest | undefined;
  const mappedStrategy = createSnapcompactStrategy({
    evaluator: perfectEvaluator(item, (request) => {
      observed = request;
    }),
  });
  const execution = await mappedStrategy.execute(requestFor(item, true));
  assert.equal(execution.outcome, "completed");
  assert.ok(execution.output);
  assert.deepEqual(
    execution.output.preservedFacts.find(
      (fact) => fact.factId === "fact-error-assert17",
    )?.evidenceRefs,
    ["m-state-test-result"],
  );
  assert.ok(observed);
  assert.equal(observed.environment.providerId, "test/vision");
  assert.equal(observed.factCatalog[0]?.factId, item.facts[0]?.id);
  assert.equal(
    "value" in (observed.factCatalog[0] ?? {}),
    false,
    "fact answers must not leak through the catalog",
  );

  const report = await runBenchmark({
    strategy: mappedStrategy,
    corpus: corpus(item),
    providerCallsAllowed: true,
    environmentForCase: () => FULL_ENVIRONMENT,
  });
  assert.equal(report.results[0]?.structuralFidelity.score, 100);
  assert.equal(report.results[0]?.continuationQuality.score, 100);
});

test("runner gates provider opt-in and image capability before rendering or evaluator calls", async () => {
  const item = fixture("state-and-tool-structure");
  let renders = 0;
  let providerCalls = 0;
  const renderer: SnapcompactFrameRenderer = {
    render(target) {
      renders += 1;
      return createDeterministicSnapcompactRenderer().render(target);
    },
  };
  const strategy = createSnapcompactStrategy({
    renderer,
    evaluator: {
      async evaluate(request) {
        providerCalls += 1;
        return {
          outcome: "completed",
          evidence: evidenceFor(item, request),
          usage: USAGE,
        };
      },
    },
  });

  const blockedByPolicy = await runBenchmark({
    strategy,
    corpus: corpus(item),
    environmentForCase: () => FULL_ENVIRONMENT,
  });
  assert.equal(
    blockedByPolicy.results[0]?.failureFallback.failureCode,
    "provider-calls-disabled",
  );
  assert.equal(renders, 0);
  assert.equal(providerCalls, 0);

  const blockedByCapability = await runBenchmark({
    strategy,
    corpus: corpus(item),
    providerCallsAllowed: true,
    environmentForCase: () => ({ ...FULL_ENVIRONMENT, capabilities: [] }),
  });
  assert.equal(
    blockedByCapability.results[0]?.failureFallback.failureCode,
    "missing-provider-capability",
  );
  assert.deepEqual(
    blockedByCapability.results[0]?.providerCompatibility.missingCapabilities,
    ["image-input"],
  );
  assert.equal(renders, 0);
  assert.equal(providerCalls, 0);

  const direct = await strategy.execute(requestFor(item, false));
  assert.equal(direct.outcome, "unsupported");
  assert.equal(direct.failure.code, "provider-calls-disabled");
  assert.equal(renders, 0);
  assert.equal(providerCalls, 0);
});

test("image-bearing fixtures are accepted and generated frame accounting uses provider observations", async () => {
  const item = fixture("unsupported-image-input");
  const renderer = createDeterministicSnapcompactRenderer({
    columns: 64,
    rowsPerFrame: 12,
  });
  const rendered = await renderer.render(item);
  let sourceImageCount = -1;
  const strategy = createSnapcompactStrategy({
    renderer,
    evaluator: perfectEvaluator(item, (request) => {
      sourceImageCount = request.sourceImages.length;
    }),
  });
  const report = await runBenchmark({
    strategy,
    corpus: corpus(item),
    providerCallsAllowed: true,
    environmentForCase: () => FULL_ENVIRONMENT,
  });
  const result = report.results[0];

  assert.equal(strategy.manifest.execution, "provider");
  assert.equal(strategy.manifest.acceptsImages, true);
  assert.deepEqual(
    strategy.manifest.requirements.map((requirement) => requirement.capability),
    ["image-input"],
  );
  assert.equal(sourceImageCount, 1);
  assert.equal(result?.providerCompatibility.imageInputUnsupported, false);
  assert.equal(result?.costInput?.imageCount, rendered.frames.length);
  assert.equal(
    result?.costInput?.imageBytes,
    rendered.frames.reduce((sum, frame) => sum + frame.bytes, 0),
  );
  assert.equal(result?.costInput?.imageTokens, USAGE.imageTokens);
  assert.equal(result?.costInput?.inputTokens, USAGE.inputTokens);
  assert.equal(result?.costInput?.outputTokens, USAGE.outputTokens);
  assert.equal(result?.costInput?.cachedInputTokens, USAGE.cachedInputTokens);
  assert.equal(result?.costInput?.estimatedCostUsd, USAGE.estimatedCostUsd);
  assert.equal(result?.latencyMs, USAGE.latencyMs);
  assert.deepEqual(result?.cacheInput, USAGE.cache);
});

test("render, evaluator, and OCR failures return explicit input-preserving text fallback", async (t) => {
  const item = fixture("state-and-tool-structure");

  await t.test("render failure", async () => {
    let calls = 0;
    const strategy = createSnapcompactStrategy({
      renderer: {
        render() {
          throw new Error("bitmap allocation failed");
        },
      },
      evaluator: {
        async evaluate() {
          calls += 1;
          throw new Error("must not run");
        },
      },
    });
    const execution = await strategy.execute(requestFor(item, true));
    assert.equal(execution.outcome, "fallback");
    assert.equal(execution.failure?.code, "snapcompact-render-failed");
    assert.equal(execution.failure?.inputPreserved, true);
    assert.match(
      execution.failure?.suggestedFallback ?? "",
      /preserved original/i,
    );
    assert.equal(execution.measurements.cost.imageCount, 0);
    assert.equal(calls, 0);
  });

  await t.test("evaluator failure", async () => {
    const strategy = createSnapcompactStrategy({
      evaluator: {
        async evaluate() {
          throw new Error("provider unavailable");
        },
      },
    });
    const execution = await strategy.execute(requestFor(item, true));
    assert.equal(execution.outcome, "fallback");
    assert.equal(execution.failure?.code, "snapcompact-evaluator-failed");
    assert.equal(execution.failure?.inputPreserved, true);
    assert.ok(execution.measurements.cost.imageCount > 0);
    assert.equal(execution.measurements.cost.imageTokens, null);
  });

  await t.test("OCR failure with observed usage", async () => {
    const strategy = createSnapcompactStrategy({
      evaluator: {
        async evaluate() {
          return {
            outcome: "failed",
            kind: "ocr",
            message: "no legible text",
            retriable: false,
            usage: USAGE,
          };
        },
      },
    });
    const report = await runBenchmark({
      strategy,
      corpus: corpus(item),
      providerCallsAllowed: true,
      environmentForCase: () => FULL_ENVIRONMENT,
    });
    const result = report.results[0];
    assert.equal(result?.failureFallback.finalOutcome, "fallback");
    assert.equal(result?.failureFallback.failureCode, "snapcompact-ocr-failed");
    assert.equal(result?.failureFallback.inputPreserved, true);
    assert.equal(result?.structuralFidelity.score, 100);
    assert.equal(result?.continuationQuality.score, 100);
    assert.equal(result?.costInput?.imageTokens, USAGE.imageTokens);
    assert.equal(result?.latencyMs, USAGE.latencyMs);
  });
});
