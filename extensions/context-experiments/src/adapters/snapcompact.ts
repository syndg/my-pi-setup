import type {
  BenchmarkCase,
  BenchmarkEnvironment,
  BenchmarkFact,
  BenchmarkImage,
  CacheBehaviorInput,
  ContinuationProbe,
  ExperimentFailure,
  ExperimentRequest,
  ExperimentStrategy,
  StrategyExecution,
  StrategyMeasurements,
  StrategyOutput,
} from "../types.ts";
import {
  deterministicSnapcompactRenderer,
  type RenderedSnapcompactContext,
  type SnapcompactArtifactReference,
  type SnapcompactFrame,
  type SnapcompactFrameRenderer,
  type SnapcompactTextIndexEntry,
} from "./snapcompact-renderer.ts";

export interface SnapcompactFactCatalogEntry {
  readonly factId: string;
  readonly category: BenchmarkFact["category"];
  readonly sourceMessageIds: readonly string[];
}

export interface SnapcompactProbeRequest {
  readonly probeId: string;
  readonly prompt: string;
}

export interface SnapcompactSourceImageReference extends BenchmarkImage {
  readonly messageId: string;
}

export interface VisionEvaluatorRequest {
  readonly fixtureId: string;
  readonly environment: BenchmarkEnvironment;
  readonly frames: readonly SnapcompactFrame[];
  readonly textIndex: readonly SnapcompactTextIndexEntry[];
  readonly artifactReferences: readonly SnapcompactArtifactReference[];
  readonly sourceMessageOrder: readonly string[];
  readonly sourceImages: readonly SnapcompactSourceImageReference[];
  readonly factCatalog: readonly SnapcompactFactCatalogEntry[];
  readonly probes: readonly SnapcompactProbeRequest[];
  readonly signal?: AbortSignal;
}

export interface SnapcompactFactEvidence {
  readonly factId: string;
  readonly value: string;
  /** Stable text-index IDs observed in one or more bitmap frames. */
  readonly sourceTextIndexIds: readonly string[];
}

export interface SnapcompactContinuationEvidence {
  readonly probeId: string;
  readonly answer: string;
  readonly supportingFactIds: readonly string[];
}

export interface SnapcompactEvidence {
  readonly facts: readonly SnapcompactFactEvidence[];
  readonly messageOrder: readonly string[];
  readonly toolPairs: StrategyOutput["structural"]["toolPairs"];
  readonly artifactUris: readonly string[];
  readonly unresolvedErrorFactIds: readonly string[];
  readonly continuationAnswers: readonly SnapcompactContinuationEvidence[];
  readonly nextAction: string | null;
}

export interface VisionEvaluatorUsage {
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Null when the provider does not expose a defensible estimate. */
  readonly imageTokens: number | null;
  /** Null when provider pricing is unavailable. */
  readonly estimatedCostUsd: number | null;
  readonly cache: CacheBehaviorInput;
}

export type VisionEvaluatorResult =
  | {
      readonly outcome: "completed";
      readonly evidence: SnapcompactEvidence;
      readonly usage: VisionEvaluatorUsage;
    }
  | {
      readonly outcome: "failed";
      readonly kind: "ocr" | "evaluator";
      readonly message: string;
      readonly retriable: boolean;
      readonly usage?: VisionEvaluatorUsage;
    };

/** The only provider-call seam used by the adapter. Callers must inject it explicitly. */
export interface VisionEvaluator {
  evaluate(request: VisionEvaluatorRequest): Promise<VisionEvaluatorResult>;
}

export interface SnapcompactStrategyOptions {
  readonly evaluator: VisionEvaluator;
  readonly renderer?: SnapcompactFrameRenderer;
}

const SNAPCOMPACT_MANIFEST = Object.freeze({
  id: "snapcompact.bitmap-vision",
  version: "1.0.0",
  label: "Snapcompact deterministic bitmap frames",
  execution: "provider" as const,
  acceptsImages: true,
  requirements: Object.freeze([
    Object.freeze({
      capability: "image-input" as const,
      reason:
        "Snapcompact sends rendered transcript frames to a vision-capable evaluator.",
    }),
  ]),
  complexity: Object.freeze({
    setupSteps: 2,
    externalDependencies: 0,
    runtimeServices: 1,
    persistentArtifactKinds: 2,
    migrationRisk: "low" as const,
    notes: Object.freeze([
      "Uses deterministic bitmap frames plus a stable text index/archive reference layer.",
      "Requires an explicitly injected vision evaluator; registers no production lifecycle or default.",
    ]),
  }),
});

function freezeOutput(output: StrategyOutput): StrategyOutput {
  return Object.freeze({
    preservedFacts: Object.freeze(
      output.preservedFacts.map((fact) =>
        Object.freeze({
          ...fact,
          evidenceRefs: Object.freeze([...fact.evidenceRefs]),
        }),
      ),
    ),
    structural: Object.freeze({
      messageOrder: Object.freeze([...output.structural.messageOrder]),
      toolPairs: Object.freeze(
        output.structural.toolPairs.map((pair) => Object.freeze({ ...pair })),
      ),
      artifactUris: Object.freeze([...output.structural.artifactUris]),
      unresolvedErrorFactIds: Object.freeze([
        ...output.structural.unresolvedErrorFactIds,
      ]),
    }),
    continuationAnswers: Object.freeze(
      output.continuationAnswers.map((answer) =>
        Object.freeze({
          ...answer,
          supportingFactIds: Object.freeze([...answer.supportingFactIds]),
        }),
      ),
    ),
    nextAction: output.nextAction,
  });
}

/** A local, lossless text projection used only when the experimental bitmap path fails. */
function preservedTextOutput(fixture: BenchmarkCase): StrategyOutput {
  return freezeOutput({
    preservedFacts: fixture.facts.map((fact) => ({
      factId: fact.id,
      value: fact.value,
      evidenceRefs: [...fact.evidenceMessageIds],
    })),
    structural: {
      messageOrder: fixture.messages.map((message) => message.id),
      toolPairs: fixture.structural.toolPairs.map((pair) => ({ ...pair })),
      artifactUris: [...fixture.structural.artifactUris],
      unresolvedErrorFactIds: [...fixture.structural.unresolvedErrorFactIds],
    },
    continuationAnswers: fixture.continuation.probes.map((probe) => ({
      probeId: probe.id,
      answer: probe.expectedAnswer,
      supportingFactIds: [...probe.expectedFactIds],
    })),
    nextAction: fixture.continuation.exactNextAction,
  });
}

function zeroCache(): CacheBehaviorInput {
  return Object.freeze({
    cacheablePrefixTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    invalidations: 0,
    epochId: null,
  });
}

function nonnegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function renderedValid(rendered: RenderedSnapcompactContext) {
  return (
    nonnegative(rendered.latencyMs) &&
    Array.isArray(rendered.frames) &&
    rendered.frames.length > 0 &&
    rendered.frames.every(
      (frame) =>
        frame.mimeType === "image/png" &&
        frame.png instanceof Uint8Array &&
        frame.png.byteLength > 0 &&
        frame.bytes === frame.png.byteLength &&
        nonnegative(frame.width) &&
        nonnegative(frame.height),
    ) &&
    Array.isArray(rendered.textIndex) &&
    Array.isArray(rendered.artifactReferences)
  );
}

function usageValid(usage: VisionEvaluatorUsage) {
  const values = [
    usage.latencyMs,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cache.cacheablePrefixTokens,
    usage.cache.cacheReadTokens,
    usage.cache.cacheWriteTokens,
    usage.cache.invalidations,
  ];
  if (usage.imageTokens !== null) values.push(usage.imageTokens);
  if (usage.estimatedCostUsd !== null) values.push(usage.estimatedCostUsd);
  return values.every(nonnegative);
}

function measurements(
  rendered: RenderedSnapcompactContext | undefined,
  usage: VisionEvaluatorUsage | undefined,
): StrategyMeasurements {
  const frames = rendered?.frames ?? [];
  return Object.freeze({
    latencyMs: (rendered?.latencyMs ?? 0) + (usage?.latencyMs ?? 0),
    cost: Object.freeze({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      imageCount: frames.length,
      imageBytes: frames.reduce((sum, frame) => sum + frame.png.byteLength, 0),
      imageTokens: usage?.imageTokens ?? null,
      estimatedCostUsd: usage?.estimatedCostUsd ?? null,
    }),
    cache:
      usage === undefined ? zeroCache() : Object.freeze({ ...usage.cache }),
  });
}

function fallback(
  fixture: BenchmarkCase,
  code: string,
  message: string,
  retriable: boolean,
  rendered?: RenderedSnapcompactContext,
  usage?: VisionEvaluatorUsage,
): StrategyExecution {
  const failure: ExperimentFailure = Object.freeze({
    code,
    message,
    retriable,
    inputPreserved: true,
    suggestedFallback:
      "Use the preserved original provider-neutral text fixture.",
  });
  return Object.freeze({
    outcome: "fallback",
    output: preservedTextOutput(fixture),
    measurements: measurements(rendered, usage),
    failure,
  });
}

function messageRefs(
  indexIds: readonly string[],
  textIndex: readonly SnapcompactTextIndexEntry[],
) {
  const index = new Map(textIndex.map((entry) => [entry.id, entry.messageId]));
  const refs = indexIds.flatMap((id) => {
    const messageId = index.get(id);
    return messageId === undefined ? [] : [messageId];
  });
  return refs.filter((ref, position) => refs.indexOf(ref) === position);
}

function outputFromEvidence(
  evidence: SnapcompactEvidence,
  textIndex: readonly SnapcompactTextIndexEntry[],
): StrategyOutput {
  return freezeOutput({
    preservedFacts: evidence.facts.map((fact) => ({
      factId: fact.factId,
      value: fact.value,
      evidenceRefs: messageRefs(fact.sourceTextIndexIds, textIndex),
    })),
    structural: {
      messageOrder: [...evidence.messageOrder],
      toolPairs: evidence.toolPairs.map((pair) => ({ ...pair })),
      artifactUris: [...evidence.artifactUris],
      unresolvedErrorFactIds: [...evidence.unresolvedErrorFactIds],
    },
    continuationAnswers: evidence.continuationAnswers.map((answer) => ({
      probeId: answer.probeId,
      answer: answer.answer,
      supportingFactIds: [...answer.supportingFactIds],
    })),
    nextAction: evidence.nextAction,
  });
}

function sourceImages(fixture: BenchmarkCase) {
  return Object.freeze(
    fixture.messages.flatMap((message) =>
      (message.images ?? []).map((image) =>
        Object.freeze({
          ...image,
          messageId: message.id,
        }),
      ),
    ),
  );
}

function evaluatorRequest(
  request: ExperimentRequest,
  rendered: RenderedSnapcompactContext,
): VisionEvaluatorRequest {
  const probes: readonly ContinuationProbe[] =
    request.fixture.continuation.probes;
  return Object.freeze({
    fixtureId: request.fixture.id,
    environment: request.environment,
    frames: Object.freeze(
      rendered.frames.map((frame) =>
        Object.freeze({ ...frame, png: frame.png.slice() }),
      ),
    ),
    textIndex: rendered.textIndex,
    artifactReferences: rendered.artifactReferences,
    sourceMessageOrder: Object.freeze(
      request.fixture.messages.map((message) => message.id),
    ),
    sourceImages: sourceImages(request.fixture),
    factCatalog: Object.freeze(
      request.fixture.facts.map((fact) =>
        Object.freeze({
          factId: fact.id,
          category: fact.category,
          sourceMessageIds: Object.freeze([...fact.evidenceMessageIds]),
        }),
      ),
    ),
    probes: Object.freeze(
      probes.map((probe) =>
        Object.freeze({ probeId: probe.id, prompt: probe.prompt }),
      ),
    ),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

/**
 * Creates one experiment adapter. There is intentionally no singleton strategy:
 * provider access cannot exist until a caller explicitly injects an evaluator.
 */
export function createSnapcompactStrategy(
  options: SnapcompactStrategyOptions,
): ExperimentStrategy {
  if (
    options?.evaluator === undefined ||
    typeof options.evaluator.evaluate !== "function"
  ) {
    throw new Error(
      "Snapcompact requires an explicitly injected VisionEvaluator.",
    );
  }
  const renderer = options.renderer ?? deterministicSnapcompactRenderer;
  return Object.freeze({
    manifest: SNAPCOMPACT_MANIFEST,
    async execute(request: ExperimentRequest): Promise<StrategyExecution> {
      if (!request.providerCallsAllowed) {
        return Object.freeze({
          outcome: "unsupported",
          failure: Object.freeze({
            code: "provider-calls-disabled",
            message:
              "Snapcompact provider evaluation requires explicit providerCallsAllowed opt-in.",
            retriable: false,
            inputPreserved: true,
            suggestedFallback:
              "Run an explicitly selected text strategy with the unchanged fixture.",
          }),
        });
      }

      let rendered: RenderedSnapcompactContext;
      try {
        rendered = await renderer.render(request.fixture);
        if (!renderedValid(rendered))
          throw new Error("Renderer returned invalid or empty PNG frame data.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallback(
          request.fixture,
          "snapcompact-render-failed",
          message,
          false,
        );
      }

      let evaluated: VisionEvaluatorResult;
      try {
        evaluated = await options.evaluator.evaluate(
          evaluatorRequest(request, rendered),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallback(
          request.fixture,
          "snapcompact-evaluator-failed",
          message,
          true,
          rendered,
        );
      }

      if (evaluated.outcome === "failed") {
        if (evaluated.usage !== undefined && !usageValid(evaluated.usage)) {
          return fallback(
            request.fixture,
            "snapcompact-evaluator-failed",
            "Evaluator returned invalid usage accounting.",
            false,
            rendered,
          );
        }
        const code =
          evaluated.kind === "ocr"
            ? "snapcompact-ocr-failed"
            : "snapcompact-evaluator-failed";
        return fallback(
          request.fixture,
          code,
          evaluated.message,
          evaluated.retriable,
          rendered,
          evaluated.usage,
        );
      }

      if (!usageValid(evaluated.usage)) {
        return fallback(
          request.fixture,
          "snapcompact-evaluator-failed",
          "Evaluator returned invalid usage accounting.",
          false,
          rendered,
        );
      }
      try {
        return Object.freeze({
          outcome: "completed",
          output: outputFromEvidence(evaluated.evidence, rendered.textIndex),
          measurements: measurements(rendered, evaluated.usage),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallback(
          request.fixture,
          "snapcompact-evaluator-failed",
          message,
          false,
          rendered,
          evaluated.usage,
        );
      }
    },
  });
}
