import type {
  BenchmarkCase,
  BenchmarkImage,
  ExperimentFailure,
  ExperimentStrategy,
  ExperimentRequest,
  StrategyExecution,
  StrategyMeasurements,
  StrategyOutput,
} from "../types.ts";

export type PromotionJsonSchemaType =
  "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

/** The intentionally small JSON Schema surface needed to check concrete fixture tool calls. */
export interface PromotionJsonSchema {
  readonly type?: PromotionJsonSchemaType | readonly PromotionJsonSchemaType[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, PromotionToolInputSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | PromotionToolInputSchema;
  readonly items?: PromotionToolInputSchema;
  readonly anyOf?: readonly PromotionToolInputSchema[];
  readonly oneOf?: readonly PromotionToolInputSchema[];
  readonly allOf?: readonly PromotionToolInputSchema[];
}

export type PromotionToolInputSchema = PromotionJsonSchema | boolean;

export interface PromotionToolDescriptor {
  readonly name: string;
  readonly inputSchema: PromotionToolInputSchema;
}

/** An explicit experiment-only destination. It is never installed as a production default. */
export interface PromotionTargetDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly acceptsImages: boolean;
  readonly tools: readonly PromotionToolDescriptor[];
  /** Omit to permit any source provider for which the injected client can translate messages. */
  readonly compatibleSourceProviderIds?: readonly string[];
}

export interface PromotionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly imageTokens?: number | null;
  readonly estimatedCostUsd?: number | null;
}

export interface PromotionCacheObservation {
  readonly cacheablePrefixTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Provider-observed invalidations in addition to the source-to-target model change. */
  readonly invalidations?: number;
  readonly epochId?: string | null;
}

export interface PromotionInvocationRequest {
  readonly source: {
    readonly providerId: string;
    readonly modelId: string;
    readonly contextWindowTokens: number;
  };
  readonly target: PromotionTargetDescriptor;
  /** A detached copy. A client cannot mutate the benchmark corpus through this reference. */
  readonly fixture: BenchmarkCase;
  readonly estimatedInputTokens: number;
  readonly signal?: AbortSignal;
}

export interface PromotionInvocationResult {
  readonly evidence: StrategyOutput;
  readonly latencyMs: number;
  readonly usage: PromotionUsage;
  readonly cache?: PromotionCacheObservation;
}

/**
 * Provider mechanics are injected. Implementations may inspect credentials and model catalogs,
 * but `promote` must be a one-shot target invocation and must not change a session/default model.
 */
export interface PromotionClient {
  hasProviderAuth(
    target: PromotionTargetDescriptor,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  isModelAvailable(
    target: PromotionTargetDescriptor,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  promote(
    request: PromotionInvocationRequest,
  ): Promise<PromotionInvocationResult>;
}

export interface ModelPromotionStrategyOptions {
  readonly client: PromotionClient;
  readonly target: PromotionTargetDescriptor;
  readonly estimateInputTokens?: (fixture: BenchmarkCase) => number;
}

const REQUIREMENTS = Object.freeze([
  Object.freeze({
    capability: "model-promotion" as const,
    reason:
      "The provider must permit an explicit experiment-only target-model invocation.",
  }),
  Object.freeze({
    capability: "larger-context-window" as const,
    reason:
      "The explicit target must expose a context window larger than the source model.",
  }),
]);

export const MODEL_PROMOTION_MANIFEST = Object.freeze({
  id: "provider.larger-context-model-promotion",
  version: "1.0.0",
  label: "Explicit larger-context model promotion",
  execution: "provider" as const,
  // The adapter accepts image fixtures, then gates against the explicit target capability.
  acceptsImages: true,
  requirements: REQUIREMENTS,
  complexity: Object.freeze({
    setupSteps: 2,
    externalDependencies: 1,
    runtimeServices: 0,
    persistentArtifactKinds: 0,
    migrationRisk: "low" as const,
    notes: Object.freeze([
      "Requires an authenticated provider client and explicit target descriptor.",
      "Does not switch or persist a production session/default model.",
      "A model change invalidates the source model's prompt-cache epoch.",
    ]),
  }),
});

export function estimatePromotionInputTokens(fixture: BenchmarkCase): number {
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(JSON.stringify(fixture.messages), "utf8") / 4),
  );
}

function unsupported(
  code: string,
  message: string,
  suggestedFallback?: string,
): StrategyExecution {
  const failure: ExperimentFailure = Object.freeze({
    code,
    message,
    retriable: false,
    inputPreserved: true,
    ...(suggestedFallback === undefined ? {} : { suggestedFallback }),
  });
  return Object.freeze({ outcome: "unsupported", failure });
}

function failed(
  code: string,
  message: string,
  suggestedFallback: string,
  retriable: boolean,
): StrategyExecution {
  return Object.freeze({
    outcome: "failed",
    failure: Object.freeze({
      code,
      message,
      retriable,
      inputPreserved: true,
      suggestedFallback,
    }),
  });
}

function fallbackStatement(sourceModelId: string) {
  return `Continue on source model ${sourceModelId}, or let the benchmark runner invoke its explicit fallback strategy; no production model rollback is required.`;
}

function failureMessage(reason: string) {
  return `${reason} No production model or default was changed; the detached source fixture remains available for rollback/fallback.`;
}

function validIdentifier(value: string) {
  return value.trim().length > 0;
}

function targetProblem(target: PromotionTargetDescriptor): string | null {
  if (!validIdentifier(target.providerId))
    return "Target providerId must be non-empty.";
  if (!validIdentifier(target.modelId))
    return "Target modelId must be non-empty.";
  if (
    !Number.isSafeInteger(target.contextWindowTokens) ||
    target.contextWindowTokens <= 0
  ) {
    return "Target contextWindowTokens must be a positive safe integer.";
  }
  const names = new Set<string>();
  for (const tool of target.tools) {
    if (!validIdentifier(tool.name))
      return "Target tool names must be non-empty.";
    if (names.has(tool.name))
      return `Target tool descriptor is duplicated: ${tool.name}.`;
    names.add(tool.name);
  }
  return null;
}

function jsonEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function matchesType(value: unknown, type: PromotionJsonSchemaType) {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "string":
      return typeof value === "string";
  }
}

function matchesSchema(
  value: unknown,
  schema: PromotionToolInputSchema,
): boolean {
  if (typeof schema === "boolean") return schema;
  if (schema.const !== undefined && !jsonEqual(value, schema.const))
    return false;
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => jsonEqual(candidate, value))
  )
    return false;
  const types =
    schema.type === undefined
      ? []
      : Array.isArray(schema.type)
        ? schema.type
        : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(value, type)))
    return false;
  if (
    schema.allOf !== undefined &&
    !schema.allOf.every((part) => matchesSchema(value, part))
  )
    return false;
  if (
    schema.anyOf !== undefined &&
    !schema.anyOf.some((part) => matchesSchema(value, part))
  )
    return false;
  if (
    schema.oneOf !== undefined &&
    schema.oneOf.filter((part) => matchesSchema(value, part)).length !== 1
  )
    return false;

  if (
    Array.isArray(value) &&
    schema.items !== undefined &&
    !value.every((item) =>
      matchesSchema(item, schema.items as PromotionToolInputSchema),
    )
  ) {
    return false;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(record, key)))
      return false;
    for (const [key, propertyValue] of Object.entries(record)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema !== undefined) {
        if (!matchesSchema(propertyValue, propertySchema)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        typeof schema.additionalProperties === "object" &&
        !matchesSchema(propertyValue, schema.additionalProperties)
      ) {
        return false;
      }
    }
  }
  return true;
}

function incompatibleToolCalls(
  fixture: BenchmarkCase,
  target: PromotionTargetDescriptor,
) {
  const tools = new Map(target.tools.map((tool) => [tool.name, tool]));
  const incompatible: string[] = [];
  for (const message of fixture.messages) {
    for (const call of message.toolCalls ?? []) {
      const descriptor = tools.get(call.name);
      if (
        descriptor === undefined ||
        !matchesSchema(call.arguments, descriptor.inputSchema)
      ) {
        incompatible.push(`${call.name}:${call.id}`);
      }
    }
  }
  return incompatible;
}

function images(fixture: BenchmarkCase): readonly BenchmarkImage[] {
  return fixture.messages.flatMap((message) => message.images ?? []);
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function evidenceShapeValid(value: StrategyOutput) {
  return (
    Array.isArray(value.preservedFacts) &&
    typeof value.structural === "object" &&
    value.structural !== null &&
    Array.isArray(value.structural.messageOrder) &&
    Array.isArray(value.structural.toolPairs) &&
    Array.isArray(value.structural.artifactUris) &&
    Array.isArray(value.structural.unresolvedErrorFactIds) &&
    Array.isArray(value.continuationAnswers) &&
    (value.nextAction === null || typeof value.nextAction === "string")
  );
}

function measurementsOf(
  result: PromotionInvocationResult,
  fixture: BenchmarkCase,
): StrategyMeasurements | null {
  const cachedInputTokens = result.usage.cachedInputTokens ?? 0;
  const imageTokens = result.usage.imageTokens ?? null;
  const estimatedCostUsd = result.usage.estimatedCostUsd ?? null;
  const cache = result.cache;
  const numeric = [
    result.latencyMs,
    result.usage.inputTokens,
    result.usage.outputTokens,
    cachedInputTokens,
    ...(imageTokens === null ? [] : [imageTokens]),
    ...(estimatedCostUsd === null ? [] : [estimatedCostUsd]),
    ...(cache === undefined
      ? []
      : [
          cache.cacheablePrefixTokens,
          cache.cacheReadTokens,
          cache.cacheWriteTokens,
          cache.invalidations ?? 0,
        ]),
  ];
  if (!numeric.every(finiteNonNegative)) return null;
  const fixtureImages = images(fixture);
  return Object.freeze({
    latencyMs: result.latencyMs,
    cost: Object.freeze({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens,
      imageCount: fixtureImages.length,
      imageBytes: fixtureImages.reduce((sum, image) => sum + image.bytes, 0),
      imageTokens,
      estimatedCostUsd,
    }),
    cache: Object.freeze({
      cacheablePrefixTokens: cache?.cacheablePrefixTokens ?? 0,
      cacheReadTokens: cache?.cacheReadTokens ?? cachedInputTokens,
      cacheWriteTokens: cache?.cacheWriteTokens ?? 0,
      // The explicit source-to-target model transition always starts a new cache epoch.
      invalidations: (cache?.invalidations ?? 0) + 1,
      epochId: cache?.epochId ?? null,
    }),
  });
}

function copyOutput(output: StrategyOutput): StrategyOutput {
  return Object.freeze({
    preservedFacts: Object.freeze(
      output.preservedFacts.map((fact) =>
        Object.freeze({
          factId: fact.factId,
          value: fact.value,
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
          probeId: answer.probeId,
          answer: answer.answer,
          supportingFactIds: Object.freeze([...answer.supportingFactIds]),
        }),
      ),
    ),
    nextAction: output.nextAction,
  });
}

/** Create a provider-gated, one-shot experiment adapter for one explicitly supplied target. */
export function createModelPromotionStrategy(
  options: ModelPromotionStrategyOptions,
): ExperimentStrategy {
  const estimateInputTokens =
    options.estimateInputTokens ?? estimatePromotionInputTokens;

  return Object.freeze({
    manifest: MODEL_PROMOTION_MANIFEST,
    async execute(request: ExperimentRequest): Promise<StrategyExecution> {
      if (!request.providerCallsAllowed) {
        return unsupported(
          "provider-calls-disabled",
          "Provider execution is disabled; the explicit promotion target was not inspected or invoked.",
        );
      }

      const problem = targetProblem(options.target);
      if (problem !== null)
        return unsupported("promotion-target-invalid", problem);
      if (
        !validIdentifier(request.environment.providerId) ||
        !validIdentifier(request.environment.modelId)
      ) {
        return unsupported(
          "promotion-source-invalid",
          "Source providerId and modelId must be non-empty.",
        );
      }
      if (
        options.target.contextWindowTokens <=
        request.environment.contextWindowTokens
      ) {
        return unsupported(
          "promotion-target-not-larger",
          `Target window ${options.target.contextWindowTokens} must be larger than source window ${request.environment.contextWindowTokens}.`,
        );
      }
      if (
        options.target.compatibleSourceProviderIds !== undefined &&
        !options.target.compatibleSourceProviderIds.includes(
          request.environment.providerId,
        )
      ) {
        return unsupported(
          "promotion-provider-incompatible",
          `Target provider ${options.target.providerId} does not accept source provider ${request.environment.providerId}.`,
        );
      }

      let authenticated: boolean;
      try {
        authenticated = await options.client.hasProviderAuth(
          options.target,
          request.signal,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          "promotion-preflight-failed",
          failureMessage(
            `Could not verify target-provider authentication: ${reason}.`,
          ),
          fallbackStatement(request.environment.modelId),
          true,
        );
      }
      if (!authenticated) {
        return unsupported(
          "promotion-provider-auth-missing",
          `No provider authentication is available for explicit target ${options.target.providerId}/${options.target.modelId}.`,
          fallbackStatement(request.environment.modelId),
        );
      }

      const incompatible = incompatibleToolCalls(
        request.fixture,
        options.target,
      );
      if (incompatible.length > 0) {
        return unsupported(
          "promotion-tool-schema-incompatible",
          `Target tool schemas do not accept fixture calls: ${incompatible.join(", ")}.`,
          fallbackStatement(request.environment.modelId),
        );
      }
      if (images(request.fixture).length > 0 && !options.target.acceptsImages) {
        return unsupported(
          "promotion-image-unsupported",
          `Explicit target ${options.target.modelId} does not accept image input.`,
          fallbackStatement(request.environment.modelId),
        );
      }

      let estimatedInputTokens: number;
      try {
        estimatedInputTokens = estimateInputTokens(request.fixture);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          "promotion-input-estimate-failed",
          failureMessage(`Could not estimate target context use: ${reason}.`),
          fallbackStatement(request.environment.modelId),
          false,
        );
      }
      if (
        !Number.isSafeInteger(estimatedInputTokens) ||
        estimatedInputTokens < 0
      ) {
        return failed(
          "promotion-input-estimate-invalid",
          failureMessage(
            "The input-token estimator returned an invalid value.",
          ),
          fallbackStatement(request.environment.modelId),
          false,
        );
      }
      if (estimatedInputTokens > options.target.contextWindowTokens) {
        return unsupported(
          "promotion-context-does-not-fit",
          `Estimated input ${estimatedInputTokens} exceeds target window ${options.target.contextWindowTokens}.`,
          fallbackStatement(request.environment.modelId),
        );
      }

      let available: boolean;
      try {
        available = await options.client.isModelAvailable(
          options.target,
          request.signal,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          "promotion-preflight-failed",
          failureMessage(
            `Could not verify target-model availability: ${reason}.`,
          ),
          fallbackStatement(request.environment.modelId),
          true,
        );
      }
      if (!available) {
        return unsupported(
          "promotion-model-unavailable",
          `Explicit target ${options.target.providerId}/${options.target.modelId} is unavailable.`,
          fallbackStatement(request.environment.modelId),
        );
      }

      const detachedFixture = structuredClone(request.fixture);
      const detachedTarget = structuredClone(options.target);
      let invocation: PromotionInvocationResult;
      try {
        invocation = await options.client.promote({
          source: Object.freeze({
            providerId: request.environment.providerId,
            modelId: request.environment.modelId,
            contextWindowTokens: request.environment.contextWindowTokens,
          }),
          target: detachedTarget,
          fixture: detachedFixture,
          estimatedInputTokens,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          "promotion-invocation-failed",
          failureMessage(`Target invocation failed: ${reason}.`),
          fallbackStatement(request.environment.modelId),
          true,
        );
      }

      try {
        if (!evidenceShapeValid(invocation.evidence)) {
          return failed(
            "promotion-invalid-response",
            failureMessage(
              "Target invocation returned malformed continuation evidence.",
            ),
            fallbackStatement(request.environment.modelId),
            false,
          );
        }
        const measurements = measurementsOf(invocation, request.fixture);
        if (measurements === null) {
          return failed(
            "promotion-invalid-response",
            failureMessage(
              "Target invocation returned invalid usage, cache, cost, or latency accounting.",
            ),
            fallbackStatement(request.environment.modelId),
            false,
          );
        }
        return Object.freeze({
          outcome: "completed",
          output: copyOutput(invocation.evidence),
          measurements,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(
          "promotion-invalid-response",
          failureMessage(
            `Could not map target continuation evidence: ${reason}.`,
          ),
          fallbackStatement(request.environment.modelId),
          false,
        );
      }
    },
  });
}
