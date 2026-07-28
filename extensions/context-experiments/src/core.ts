import type {
  BenchmarkCase,
  ContinuationQualityMetric,
  OperationalComplexityInput,
  OperationalComplexityMetric,
  StrategyOutput,
  StructuralFidelityMetric,
} from "./types.ts";

function roundScore(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(matched: number, total: number) {
  return total === 0 ? 1 : matched / total;
}

function weightedMean(
  parts: readonly {
    readonly value: number;
    readonly weight: number;
    readonly applicable: boolean;
  }[],
) {
  const applicable = parts.filter((part) => part.applicable);
  const totalWeight = applicable.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return 1;
  return (
    applicable.reduce((sum, part) => sum + part.value * part.weight, 0) /
    totalWeight
  );
}

function orderedCoverage(
  expected: readonly string[],
  observed: readonly string[],
) {
  let nextObservedIndex = 0;
  let matched = 0;
  for (const id of expected) {
    const found = observed.indexOf(id, nextObservedIndex);
    if (found === -1) continue;
    matched += 1;
    nextObservedIndex = found + 1;
  }
  return ratio(matched, expected.length);
}

export function scoreStructuralFidelity(
  fixture: BenchmarkCase,
  output: StrategyOutput | undefined,
): StructuralFidelityMetric {
  if (output === undefined) {
    return Object.freeze({
      score: 0,
      factScore: 0,
      messageOrderScore: 0,
      toolPairScore: fixture.structural.toolPairs.length === 0 ? 100 : 0,
      artifactScore: fixture.structural.artifactUris.length === 0 ? 100 : 0,
      unresolvedErrorScore:
        fixture.structural.unresolvedErrorFactIds.length === 0 ? 100 : 0,
      missingFactIds: Object.freeze(fixture.facts.map((fact) => fact.id)),
      alteredFactIds: Object.freeze([]),
      missingToolCallIds: Object.freeze(
        fixture.structural.toolPairs.map((pair) => pair.callId),
      ),
      missingArtifactUris: Object.freeze([...fixture.structural.artifactUris]),
    });
  }

  const observedFacts = new Map(
    output.preservedFacts.map((fact) => [fact.factId, fact]),
  );
  const missingFactIds: string[] = [];
  const alteredFactIds: string[] = [];
  let matchedFactWeight = 0;
  let totalFactWeight = 0;
  for (const expected of fixture.facts) {
    totalFactWeight += expected.weight;
    const observed = observedFacts.get(expected.id);
    if (observed === undefined) {
      missingFactIds.push(expected.id);
    } else if (
      observed.value !== expected.value ||
      observed.evidenceRefs.length === 0
    ) {
      alteredFactIds.push(expected.id);
    } else {
      matchedFactWeight += expected.weight;
    }
  }
  const factRatio = ratio(matchedFactWeight, totalFactWeight);
  const orderRatio = orderedCoverage(
    fixture.structural.requiredMessageOrder,
    output.structural.messageOrder,
  );

  const observedPairs = new Set(
    output.structural.toolPairs.map(
      (pair) =>
        `${pair.callMessageId}\0${pair.resultMessageId}\0${pair.callId}\0${pair.toolName}`,
    ),
  );
  const missingToolCallIds = fixture.structural.toolPairs
    .filter(
      (pair) =>
        !observedPairs.has(
          `${pair.callMessageId}\0${pair.resultMessageId}\0${pair.callId}\0${pair.toolName}`,
        ),
    )
    .map((pair) => pair.callId);
  const toolPairRatio = ratio(
    fixture.structural.toolPairs.length - missingToolCallIds.length,
    fixture.structural.toolPairs.length,
  );

  const observedArtifacts = new Set(output.structural.artifactUris);
  const missingArtifactUris = fixture.structural.artifactUris.filter(
    (uri) => !observedArtifacts.has(uri),
  );
  const artifactRatio = ratio(
    fixture.structural.artifactUris.length - missingArtifactUris.length,
    fixture.structural.artifactUris.length,
  );

  const observedErrors = new Set(output.structural.unresolvedErrorFactIds);
  const matchedErrors = fixture.structural.unresolvedErrorFactIds.filter((id) =>
    observedErrors.has(id),
  ).length;
  const errorRatio = ratio(
    matchedErrors,
    fixture.structural.unresolvedErrorFactIds.length,
  );
  const score = weightedMean([
    { value: factRatio, weight: 50, applicable: fixture.facts.length > 0 },
    {
      value: orderRatio,
      weight: 15,
      applicable: fixture.structural.requiredMessageOrder.length > 0,
    },
    {
      value: toolPairRatio,
      weight: 15,
      applicable: fixture.structural.toolPairs.length > 0,
    },
    {
      value: artifactRatio,
      weight: 10,
      applicable: fixture.structural.artifactUris.length > 0,
    },
    {
      value: errorRatio,
      weight: 10,
      applicable: fixture.structural.unresolvedErrorFactIds.length > 0,
    },
  ]);

  return Object.freeze({
    score: roundScore(score * 100),
    factScore: roundScore(factRatio * 100),
    messageOrderScore: roundScore(orderRatio * 100),
    toolPairScore: roundScore(toolPairRatio * 100),
    artifactScore: roundScore(artifactRatio * 100),
    unresolvedErrorScore: roundScore(errorRatio * 100),
    missingFactIds: Object.freeze(missingFactIds),
    alteredFactIds: Object.freeze(alteredFactIds),
    missingToolCallIds: Object.freeze(missingToolCallIds),
    missingArtifactUris: Object.freeze(missingArtifactUris),
  });
}

export function scoreContinuationQuality(
  fixture: BenchmarkCase,
  output: StrategyOutput | undefined,
): ContinuationQualityMetric {
  if (output === undefined) {
    return Object.freeze({
      score: 0,
      probeScore: 0,
      nextActionScore: 0,
      passedProbeIds: Object.freeze([]),
      failedProbeIds: Object.freeze(
        fixture.continuation.probes.map((probe) => probe.id),
      ),
    });
  }
  const answers = new Map(
    output.continuationAnswers.map((answer) => [answer.probeId, answer]),
  );
  const exactFacts = new Set(
    output.preservedFacts
      .filter((observed) =>
        fixture.facts.some(
          (expected) =>
            expected.id === observed.factId &&
            expected.value === observed.value,
        ),
      )
      .map((fact) => fact.factId),
  );
  let passedWeight = 0;
  let totalWeight = 0;
  const passedProbeIds: string[] = [];
  const failedProbeIds: string[] = [];
  for (const probe of fixture.continuation.probes) {
    totalWeight += probe.weight;
    const answer = answers.get(probe.id);
    const support = new Set(answer?.supportingFactIds ?? []);
    const passed =
      answer?.answer === probe.expectedAnswer &&
      probe.expectedFactIds.every(
        (factId) => support.has(factId) && exactFacts.has(factId),
      );
    if (passed) {
      passedWeight += probe.weight;
      passedProbeIds.push(probe.id);
    } else {
      failedProbeIds.push(probe.id);
    }
  }
  const probeRatio = ratio(passedWeight, totalWeight);
  const nextActionRatio =
    output.nextAction === fixture.continuation.exactNextAction ? 1 : 0;
  const score = probeRatio * 0.75 + nextActionRatio * 0.25;
  return Object.freeze({
    score: roundScore(score * 100),
    probeScore: roundScore(probeRatio * 100),
    nextActionScore: nextActionRatio * 100,
    passedProbeIds: Object.freeze(passedProbeIds),
    failedProbeIds: Object.freeze(failedProbeIds),
  });
}

export function scoreOperationalComplexity(
  input: OperationalComplexityInput,
): OperationalComplexityMetric {
  const migrationPoints = { none: 0, low: 2, medium: 5, high: 9 }[
    input.migrationRisk
  ];
  return Object.freeze({
    ...input,
    notes: Object.freeze([...input.notes]),
    burdenPoints:
      input.setupSteps +
      input.externalDependencies * 2 +
      input.runtimeServices * 3 +
      input.persistentArtifactKinds * 2 +
      migrationPoints,
  });
}
