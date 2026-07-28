import type {
  BenchmarkEnvironment,
  BenchmarkFact,
  BenchmarkMessage,
  ContinuationAnswer,
  ContinuationFixture,
  ExperimentFailure,
  ExperimentRequest,
  ExperimentStrategy,
  ExperimentStrategyManifest,
  PreservedFact,
  StrategyExecution,
  StrategyMeasurements,
  StrategyOutput,
  StructuralObservation,
  StructuralRequirements,
} from "../types.ts";

export const LOCAL_STRUCTURED_COMPACTION_FALLBACK =
  "local structured-compaction";

export interface ProviderCompactionSupportRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly environmentCapabilities: BenchmarkEnvironment["capabilities"];
  readonly hasImages: boolean;
  readonly signal?: AbortSignal;
}

/** The client must check its actual credentials and provider/model support locally. */
export interface ProviderCompactionSupport {
  readonly capabilityAvailable: boolean;
  readonly authenticated: boolean;
  readonly modelSupported: boolean;
  readonly reason?: string;
}

export interface ProviderCompactionProbe {
  readonly id: string;
  readonly prompt: string;
}

/**
 * Immutable provider-edge projection. Ground-truth answers and fact values are
 * deliberately not sent to the provider.
 */
export interface ProviderCompactionRequest {
  readonly schemaVersion: "provider-compaction-request/v1";
  readonly fixtureId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly transcript: readonly BenchmarkMessage[];
  readonly continuationProbes: readonly ProviderCompactionProbe[];
}

export interface ProviderCompactionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly imageTokens: number | null;
}

export interface ProviderCompactionCache {
  readonly cacheablePrefixTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly invalidations: number;
  readonly epochId: string | null;
}

export interface ProviderCompactionCost {
  readonly estimatedCostUsd: number | null;
}

export interface ProviderCompactionEvidence {
  readonly preservedFacts: readonly PreservedFact[];
  readonly structural: StructuralObservation;
}

export interface ProviderCompactionContinuation {
  readonly answers: readonly ContinuationAnswer[];
  readonly nextAction: string | null;
}

export interface ProviderCompactionCompletedResponse {
  readonly status: "compacted";
  readonly evidence: ProviderCompactionEvidence;
  readonly continuation: ProviderCompactionContinuation;
  readonly latencyMs: number;
  readonly usage: ProviderCompactionUsage;
  readonly cache: ProviderCompactionCache;
  readonly cost: ProviderCompactionCost;
}

export interface ProviderCompactionRejectedResponse {
  readonly status: "rejected";
  readonly reason: string;
  readonly retriable?: boolean;
}

export interface ProviderCompactionUnsupportedResponse {
  readonly status: "unsupported";
  readonly reason: string;
}

export type ProviderCompactionResponse =
  | ProviderCompactionCompletedResponse
  | ProviderCompactionRejectedResponse
  | ProviderCompactionUnsupportedResponse;

export interface ProviderCompactionClient {
  detectSupport(
    request: ProviderCompactionSupportRequest,
  ): ProviderCompactionSupport | Promise<ProviderCompactionSupport>;
  compact(
    request: ProviderCompactionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderCompactionResponse | null | undefined>;
}

export const PROVIDER_COMPACTION_MANIFEST: ExperimentStrategyManifest =
  Object.freeze({
    id: "provider.native-compaction",
    version: "1.0.0",
    label: "Provider-native compaction experiment",
    execution: "provider",
    acceptsImages: false,
    requirements: Object.freeze([
      Object.freeze({
        capability: "provider-compaction",
        reason:
          "The selected provider and model must expose native compaction.",
      }),
    ]),
    complexity: Object.freeze({
      setupSteps: 1,
      externalDependencies: 1,
      runtimeServices: 0,
      persistentArtifactKinds: 0,
      migrationRisk: "low",
      notes: Object.freeze([
        "Requires an explicitly injected provider client; registers no session or overflow hooks.",
      ]),
    }),
  });

function cloneUnknown<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneUnknown(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, cloneUnknown(item)] as const,
    );
    return Object.freeze(Object.fromEntries(entries)) as T;
  }
  return value;
}

function cloneMessage(message: BenchmarkMessage): BenchmarkMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: Object.freeze(
            message.toolCalls.map((call) =>
              Object.freeze({
                id: call.id,
                name: call.name,
                arguments: cloneUnknown(call.arguments),
              }),
            ),
          ),
        }),
    ...(message.toolResult === undefined
      ? {}
      : {
          toolResult: Object.freeze({ ...message.toolResult }),
        }),
    ...(message.images === undefined
      ? {}
      : {
          images: Object.freeze(
            message.images.map((image) => Object.freeze({ ...image })),
          ),
        }),
  });
}

/** Creates a detached, recursively frozen request without mutating the fixture. */
export function createProviderCompactionRequest(
  request: Pick<ExperimentRequest, "fixture" | "environment">,
): ProviderCompactionRequest {
  return Object.freeze({
    schemaVersion: "provider-compaction-request/v1",
    fixtureId: request.fixture.id,
    providerId: request.environment.providerId,
    modelId: request.environment.modelId,
    transcript: Object.freeze(request.fixture.messages.map(cloneMessage)),
    continuationProbes: Object.freeze(
      request.fixture.continuation.probes.map((probe) =>
        Object.freeze({
          id: probe.id,
          prompt: probe.prompt,
        }),
      ),
    ),
  });
}

function failure(
  outcome: "failed" | "unsupported",
  code: string,
  message: string,
  retriable = false,
): StrategyExecution {
  const detail: ExperimentFailure = Object.freeze({
    code,
    message,
    retriable,
    inputPreserved: true,
    suggestedFallback: LOCAL_STRUCTURED_COMPACTION_FALLBACK,
  });
  return Object.freeze({ outcome, failure: detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function hasUniqueValues(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function validSupport(value: unknown): value is ProviderCompactionSupport {
  if (!isRecord(value)) return false;
  return (
    typeof value.capabilityAvailable === "boolean" &&
    typeof value.authenticated === "boolean" &&
    typeof value.modelSupported === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function validPreservedFacts(
  value: unknown,
  fixtureFacts: readonly BenchmarkFact[],
  messageIds: ReadonlySet<string>,
): value is readonly PreservedFact[] {
  if (!Array.isArray(value)) return false;
  const factIds = new Set(fixtureFacts.map((fact) => fact.id));
  const observedIds: string[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.factId !== "string" ||
      typeof item.value !== "string" ||
      !isStringArray(item.evidenceRefs)
    )
      return false;
    if (
      !factIds.has(item.factId) ||
      !item.evidenceRefs.every((id) => messageIds.has(id))
    )
      return false;
    observedIds.push(item.factId);
  }
  return hasUniqueValues(observedIds);
}

function validStructural(
  value: unknown,
  requirements: StructuralRequirements,
  messageIds: ReadonlySet<string>,
): value is StructuralObservation {
  if (
    !isRecord(value) ||
    !isStringArray(value.messageOrder) ||
    !Array.isArray(value.toolPairs) ||
    !isStringArray(value.artifactUris) ||
    !isStringArray(value.unresolvedErrorFactIds)
  )
    return false;
  if (
    !hasUniqueValues(value.messageOrder) ||
    !value.messageOrder.every((id) => messageIds.has(id))
  )
    return false;

  const requiredArtifacts = new Set(requirements.artifactUris);
  const requiredErrors = new Set(requirements.unresolvedErrorFactIds);
  if (
    !value.artifactUris.every((uri) => requiredArtifacts.has(uri)) ||
    !value.unresolvedErrorFactIds.every((id) => requiredErrors.has(id))
  )
    return false;

  const knownPairs = new Set(
    requirements.toolPairs.map(
      (pair) =>
        `${pair.callMessageId}\0${pair.resultMessageId}\0${pair.callId}\0${pair.toolName}`,
    ),
  );
  const observedPairs: string[] = [];
  for (const item of value.toolPairs) {
    if (
      !isRecord(item) ||
      typeof item.callMessageId !== "string" ||
      typeof item.resultMessageId !== "string" ||
      typeof item.callId !== "string" ||
      typeof item.toolName !== "string"
    )
      return false;
    const key = `${item.callMessageId}\0${item.resultMessageId}\0${item.callId}\0${item.toolName}`;
    if (!knownPairs.has(key)) return false;
    observedPairs.push(key);
  }
  return (
    hasUniqueValues(observedPairs) &&
    hasUniqueValues(value.artifactUris) &&
    hasUniqueValues(value.unresolvedErrorFactIds)
  );
}

function validContinuation(
  value: unknown,
  fixture: ContinuationFixture,
  factIds: ReadonlySet<string>,
): value is ProviderCompactionContinuation {
  if (
    !isRecord(value) ||
    !Array.isArray(value.answers) ||
    !(value.nextAction === null || typeof value.nextAction === "string")
  )
    return false;
  const probeIds = new Set(fixture.probes.map((probe) => probe.id));
  const observedIds: string[] = [];
  for (const item of value.answers) {
    if (
      !isRecord(item) ||
      typeof item.probeId !== "string" ||
      typeof item.answer !== "string" ||
      !isStringArray(item.supportingFactIds)
    )
      return false;
    if (
      !probeIds.has(item.probeId) ||
      !item.supportingFactIds.every((id) => factIds.has(id))
    )
      return false;
    observedIds.push(item.probeId);
  }
  return hasUniqueValues(observedIds);
}

function validAccounting(value: Record<string, unknown>) {
  const usage = value.usage;
  const cache = value.cache;
  const cost = value.cost;
  if (!isRecord(usage) || !isRecord(cache) || !isRecord(cost)) return false;
  return (
    isNonNegativeNumber(value.latencyMs) &&
    isNonNegativeInteger(usage.inputTokens) &&
    isNonNegativeInteger(usage.outputTokens) &&
    isNonNegativeInteger(usage.cachedInputTokens) &&
    (usage.imageTokens === null || isNonNegativeInteger(usage.imageTokens)) &&
    isNonNegativeInteger(cache.cacheablePrefixTokens) &&
    isNonNegativeInteger(cache.cacheReadTokens) &&
    isNonNegativeInteger(cache.cacheWriteTokens) &&
    isNonNegativeInteger(cache.invalidations) &&
    (cache.epochId === null || typeof cache.epochId === "string") &&
    isNullableNonNegativeNumber(cost.estimatedCostUsd)
  );
}

function responseProblem(
  value: unknown,
  request: ExperimentRequest,
): string | null {
  if (!isRecord(value) || value.status !== "compacted")
    return "response is not a compacted result";
  if (!isRecord(value.evidence) || !isRecord(value.continuation))
    return "evidence or continuation is missing";
  const messageIds = new Set(
    request.fixture.messages.map((message) => message.id),
  );
  const factIds = new Set(request.fixture.facts.map((fact) => fact.id));
  if (
    !validPreservedFacts(
      value.evidence.preservedFacts,
      request.fixture.facts,
      messageIds,
    )
  ) {
    return "preserved fact evidence is invalid";
  }
  if (
    !validStructural(
      value.evidence.structural,
      request.fixture.structural,
      messageIds,
    )
  ) {
    return "structural evidence is invalid";
  }
  if (
    !validContinuation(
      value.continuation,
      request.fixture.continuation,
      factIds,
    )
  ) {
    return "continuation evidence is invalid";
  }
  if (!validAccounting(value))
    return "usage, cache, cost, or latency accounting is invalid";
  return null;
}

function emptyCompactedResponse(value: Record<string, unknown>) {
  if (
    value.status !== "compacted" ||
    !isRecord(value.evidence) ||
    !isRecord(value.continuation)
  )
    return false;
  const structural = value.evidence.structural;
  return (
    Array.isArray(value.evidence.preservedFacts) &&
    value.evidence.preservedFacts.length === 0 &&
    isRecord(structural) &&
    Array.isArray(structural.messageOrder) &&
    structural.messageOrder.length === 0 &&
    Array.isArray(structural.toolPairs) &&
    structural.toolPairs.length === 0 &&
    Array.isArray(structural.artifactUris) &&
    structural.artifactUris.length === 0 &&
    Array.isArray(structural.unresolvedErrorFactIds) &&
    structural.unresolvedErrorFactIds.length === 0 &&
    Array.isArray(value.continuation.answers) &&
    value.continuation.answers.length === 0 &&
    value.continuation.nextAction === null
  );
}

function mappedCompletedResponse(
  response: ProviderCompactionCompletedResponse,
  request: ExperimentRequest,
): StrategyExecution {
  const output: StrategyOutput = Object.freeze({
    preservedFacts: Object.freeze(
      response.evidence.preservedFacts.map((fact) =>
        Object.freeze({
          factId: fact.factId,
          value: fact.value,
          evidenceRefs: Object.freeze([...fact.evidenceRefs]),
        }),
      ),
    ),
    structural: Object.freeze({
      messageOrder: Object.freeze([
        ...response.evidence.structural.messageOrder,
      ]),
      toolPairs: Object.freeze(
        response.evidence.structural.toolPairs.map((pair) =>
          Object.freeze({ ...pair }),
        ),
      ),
      artifactUris: Object.freeze([
        ...response.evidence.structural.artifactUris,
      ]),
      unresolvedErrorFactIds: Object.freeze([
        ...response.evidence.structural.unresolvedErrorFactIds,
      ]),
    }),
    continuationAnswers: Object.freeze(
      response.continuation.answers.map((answer) =>
        Object.freeze({
          probeId: answer.probeId,
          answer: answer.answer,
          supportingFactIds: Object.freeze([...answer.supportingFactIds]),
        }),
      ),
    ),
    nextAction: response.continuation.nextAction,
  });
  const images = request.fixture.messages.flatMap(
    (message) => message.images ?? [],
  );
  const measurements: StrategyMeasurements = Object.freeze({
    latencyMs: response.latencyMs,
    cost: Object.freeze({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      imageCount: images.length,
      imageBytes: images.reduce((total, image) => total + image.bytes, 0),
      imageTokens: response.usage.imageTokens,
      estimatedCostUsd: response.cost.estimatedCostUsd,
    }),
    cache: Object.freeze({ ...response.cache }),
  });
  return Object.freeze({ outcome: "completed", output, measurements });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a provider strategy with no default transport. Merely importing this
 * module cannot perform network I/O.
 */
export function createProviderCompactionStrategy(
  client: ProviderCompactionClient,
): ExperimentStrategy {
  return Object.freeze({
    manifest: PROVIDER_COMPACTION_MANIFEST,
    async execute(request: ExperimentRequest): Promise<StrategyExecution> {
      if (!request.providerCallsAllowed) {
        return failure(
          "unsupported",
          "provider-calls-disabled",
          "Provider execution is not explicitly enabled.",
        );
      }
      if (!request.environment.capabilities.includes("provider-compaction")) {
        return failure(
          "unsupported",
          "missing-provider-capability",
          "The environment lacks provider-compaction capability.",
        );
      }

      const providerRequest = createProviderCompactionRequest(request);
      let support: ProviderCompactionSupport;
      try {
        const detected = await client.detectSupport({
          providerId: request.environment.providerId,
          modelId: request.environment.modelId,
          environmentCapabilities: Object.freeze([
            ...request.environment.capabilities,
          ]),
          hasImages: request.fixture.messages.some(
            (message) => (message.images?.length ?? 0) > 0,
          ),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (!validSupport(detected)) {
          return failure(
            "failed",
            "provider-compaction-malformed-support",
            "Provider support detection returned malformed data.",
          );
        }
        support = detected;
      } catch (error) {
        return failure(
          "failed",
          "provider-compaction-support-check-failed",
          `Provider support detection failed: ${errorMessage(error)}`,
          true,
        );
      }

      const supportReason =
        support.reason === undefined || support.reason.length === 0
          ? "No additional reason was supplied."
          : support.reason;
      if (!support.capabilityAvailable) {
        return failure(
          "unsupported",
          "provider-compaction-unavailable",
          `Provider-native compaction is unavailable. ${supportReason}`,
        );
      }
      if (!support.authenticated) {
        return failure(
          "unsupported",
          "provider-compaction-auth-unavailable",
          `Provider authentication is unavailable. ${supportReason}`,
        );
      }
      if (!support.modelSupported) {
        return failure(
          "unsupported",
          "provider-compaction-model-unsupported",
          `The selected provider/model does not support compaction. ${supportReason}`,
        );
      }

      let response: ProviderCompactionResponse | null | undefined;
      try {
        response = await client.compact(
          providerRequest,
          request.signal === undefined ? undefined : { signal: request.signal },
        );
      } catch (error) {
        return failure(
          "failed",
          "provider-compaction-rejected",
          `Provider compaction rejected the request: ${errorMessage(error)}`,
          true,
        );
      }

      if (
        response === null ||
        response === undefined ||
        (isRecord(response) && Object.keys(response).length === 0)
      ) {
        return failure(
          "failed",
          "provider-compaction-empty-response",
          "Provider compaction returned no result.",
        );
      }
      if (isRecord(response) && response.status === "unsupported") {
        if (
          typeof response.reason !== "string" ||
          response.reason.length === 0
        ) {
          return failure(
            "failed",
            "provider-compaction-malformed-response",
            "Provider compaction returned malformed unsupported metadata.",
          );
        }
        return failure(
          "unsupported",
          "provider-compaction-unsupported",
          response.reason,
        );
      }
      if (isRecord(response) && response.status === "rejected") {
        if (
          typeof response.reason !== "string" ||
          response.reason.length === 0 ||
          !(
            response.retriable === undefined ||
            typeof response.retriable === "boolean"
          )
        ) {
          return failure(
            "failed",
            "provider-compaction-malformed-response",
            "Provider compaction returned malformed rejection metadata.",
          );
        }
        return failure(
          "failed",
          "provider-compaction-rejected",
          response.reason,
          response.retriable ?? false,
        );
      }
      if (isRecord(response) && emptyCompactedResponse(response)) {
        return failure(
          "failed",
          "provider-compaction-empty-response",
          "Provider compaction returned an empty compacted result.",
        );
      }

      const problem = responseProblem(response, request);
      if (problem !== null) {
        return failure(
          "failed",
          "provider-compaction-malformed-response",
          `Provider compaction response is malformed: ${problem}.`,
        );
      }
      return mappedCompletedResponse(
        response as ProviderCompactionCompletedResponse,
        request,
      );
    },
  });
}
