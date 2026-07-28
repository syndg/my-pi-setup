import type {
  BenchmarkCase,
  BenchmarkMessage,
  ExperimentStrategy,
  ExperimentRequest,
  StrategyMeasurements,
  StrategyOutput,
} from "./types.ts";

function estimatedMessageTokens(messages: readonly BenchmarkMessage[]) {
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4),
  );
}

function measurements(fixture: BenchmarkCase): StrategyMeasurements {
  const images = fixture.messages.flatMap((message) => message.images ?? []);
  const inputTokens = estimatedMessageTokens(fixture.messages);
  return Object.freeze({
    latencyMs: 0,
    cost: Object.freeze({
      inputTokens,
      outputTokens: 0,
      cachedInputTokens: 0,
      imageCount: images.length,
      imageBytes: images.reduce((sum, image) => sum + image.bytes, 0),
      imageTokens: null,
      estimatedCostUsd: null,
    }),
    cache: Object.freeze({
      cacheablePrefixTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      invalidations: 0,
      epochId: `noop-full-context:${fixture.id}`,
    }),
  });
}

function unchangedOutput(fixture: BenchmarkCase): StrategyOutput {
  return Object.freeze({
    preservedFacts: Object.freeze(
      fixture.facts.map((fact) =>
        Object.freeze({
          factId: fact.id,
          value: fact.value,
          evidenceRefs: Object.freeze([...fact.evidenceMessageIds]),
        }),
      ),
    ),
    structural: Object.freeze({
      messageOrder: Object.freeze(
        fixture.messages.map((message) => message.id),
      ),
      toolPairs: Object.freeze(
        fixture.structural.toolPairs.map((pair) => Object.freeze({ ...pair })),
      ),
      artifactUris: Object.freeze([...fixture.structural.artifactUris]),
      unresolvedErrorFactIds: Object.freeze([
        ...fixture.structural.unresolvedErrorFactIds,
      ]),
    }),
    continuationAnswers: Object.freeze(
      fixture.continuation.probes.map((probe) =>
        Object.freeze({
          probeId: probe.id,
          answer: probe.expectedAnswer,
          supportingFactIds: Object.freeze([...probe.expectedFactIds]),
        }),
      ),
    ),
    nextAction: fixture.continuation.exactNextAction,
  });
}

/** Control adapter: retains the provider-neutral fixture exactly and makes no provider calls. */
export const noopBaselineStrategy: ExperimentStrategy = Object.freeze({
  manifest: Object.freeze({
    id: "baseline.noop",
    version: "1.0.0",
    label: "No-op full-context control",
    execution: "offline",
    acceptsImages: true,
    requirements: Object.freeze([]),
    complexity: Object.freeze({
      setupSteps: 0,
      externalDependencies: 0,
      runtimeServices: 0,
      persistentArtifactKinds: 0,
      migrationRisk: "none",
      notes: Object.freeze([
        "Retains the complete synthetic input without transformation.",
      ]),
    }),
  }),
  async execute(request: ExperimentRequest) {
    return Object.freeze({
      outcome: "completed",
      output: unchangedOutput(request.fixture),
      measurements: measurements(request.fixture),
    });
  },
});
