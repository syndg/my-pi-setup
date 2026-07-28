export type FactCategory =
  | "goal"
  | "constraint"
  | "decision"
  | "file"
  | "error"
  | "tool-pairing"
  | "artifact-reference"
  | "next-action";

export interface BenchmarkFact {
  readonly id: string;
  readonly category: FactCategory;
  readonly value: string;
  readonly weight: number;
  readonly evidenceMessageIds: readonly string[];
}

export interface BenchmarkToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface BenchmarkToolResult {
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
  readonly artifactUri?: string;
}

export interface BenchmarkImage {
  readonly id: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly bytes: number;
  readonly alt: string;
}

export type BenchmarkMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool-result"
  | "checkpoint"
  | "compaction-summary";

/** Provider-neutral transcript material. Follow-on adapters own conversion to provider/Pi messages. */
export interface BenchmarkMessage {
  readonly id: string;
  readonly role: BenchmarkMessageRole;
  readonly text?: string;
  readonly toolCalls?: readonly BenchmarkToolCall[];
  readonly toolResult?: BenchmarkToolResult;
  readonly images?: readonly BenchmarkImage[];
}

export interface ToolPairRequirement {
  readonly callMessageId: string;
  readonly resultMessageId: string;
  readonly callId: string;
  readonly toolName: string;
}

export interface StructuralRequirements {
  readonly requiredMessageOrder: readonly string[];
  readonly toolPairs: readonly ToolPairRequirement[];
  readonly artifactUris: readonly string[];
  readonly unresolvedErrorFactIds: readonly string[];
}

export interface ContinuationProbe {
  readonly id: string;
  readonly prompt: string;
  readonly expectedFactIds: readonly string[];
  readonly expectedAnswer: string;
  readonly weight: number;
}

export interface ContinuationFixture {
  readonly probes: readonly ContinuationProbe[];
  readonly exactNextAction: string;
}

export type StrategyCapability =
  | "image-input"
  | "provider-compaction"
  | "model-promotion"
  | "larger-context-window"
  | "token-usage"
  | "cache-metrics";

export interface BenchmarkEnvironment {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly capabilities: readonly StrategyCapability[];
}

export interface BenchmarkCase {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly messages: readonly BenchmarkMessage[];
  readonly facts: readonly BenchmarkFact[];
  readonly structural: StructuralRequirements;
  readonly continuation: ContinuationFixture;
  readonly defaultEnvironment: BenchmarkEnvironment;
}

export interface BenchmarkCorpus {
  readonly schemaVersion: "context-experiment-corpus/v1";
  readonly id: string;
  readonly description: string;
  readonly cases: readonly BenchmarkCase[];
}

export interface CapabilityRequirement {
  readonly capability: StrategyCapability;
  readonly reason: string;
}

export interface OperationalComplexityInput {
  readonly setupSteps: number;
  readonly externalDependencies: number;
  readonly runtimeServices: number;
  readonly persistentArtifactKinds: number;
  readonly migrationRisk: "none" | "low" | "medium" | "high";
  readonly notes: readonly string[];
}

export interface ExperimentStrategyManifest {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  /** Provider execution is blocked unless the runner explicitly opts in. */
  readonly execution: "offline" | "provider";
  readonly acceptsImages: boolean;
  readonly requirements: readonly CapabilityRequirement[];
  readonly complexity: OperationalComplexityInput;
}

export interface ExperimentRequest {
  readonly fixture: BenchmarkCase;
  readonly environment: BenchmarkEnvironment;
  readonly providerCallsAllowed: boolean;
  readonly signal?: AbortSignal;
}

export interface PreservedFact {
  readonly factId: string;
  readonly value: string;
  readonly evidenceRefs: readonly string[];
}

export interface ObservedToolPair {
  readonly callMessageId: string;
  readonly resultMessageId: string;
  readonly callId: string;
  readonly toolName: string;
}

export interface StructuralObservation {
  readonly messageOrder: readonly string[];
  readonly toolPairs: readonly ObservedToolPair[];
  readonly artifactUris: readonly string[];
  readonly unresolvedErrorFactIds: readonly string[];
}

export interface ContinuationAnswer {
  readonly probeId: string;
  readonly answer: string;
  readonly supportingFactIds: readonly string[];
}

export interface StrategyOutput {
  readonly preservedFacts: readonly PreservedFact[];
  readonly structural: StructuralObservation;
  readonly continuationAnswers: readonly ContinuationAnswer[];
  readonly nextAction: string | null;
}

export interface TokenImageCostInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly imageCount: number;
  readonly imageBytes: number;
  /** Null means the provider did not expose a defensible image-token estimate. */
  readonly imageTokens: number | null;
  /** Null means pricing was unavailable or no provider was called. */
  readonly estimatedCostUsd: number | null;
}

export interface CacheBehaviorInput {
  readonly cacheablePrefixTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly invalidations: number;
  readonly epochId: string | null;
}

export interface StrategyMeasurements {
  /** Adapter-supplied observed latency. The runner does not inject wall-clock nondeterminism. */
  readonly latencyMs: number;
  readonly cost: TokenImageCostInput;
  readonly cache: CacheBehaviorInput;
}

export interface ExperimentFailure {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly inputPreserved: boolean;
  readonly suggestedFallback?: string;
}

export type StrategyExecution =
  | {
      readonly outcome: "completed" | "fallback";
      readonly output: StrategyOutput;
      readonly measurements: StrategyMeasurements;
      readonly failure?: ExperimentFailure;
    }
  | {
      readonly outcome: "unsupported" | "failed";
      readonly output?: StrategyOutput;
      readonly measurements?: StrategyMeasurements;
      readonly failure: ExperimentFailure;
    };

/**
 * The Phase 9 experiment seam. All provider/model/bitmap mechanics stay behind
 * one operation; the runner owns capability gating, scoring, fallback, and reports.
 */
export interface ExperimentStrategy {
  readonly manifest: ExperimentStrategyManifest;
  execute(request: ExperimentRequest): Promise<StrategyExecution>;
}

export interface StructuralFidelityMetric {
  readonly score: number;
  readonly factScore: number;
  readonly messageOrderScore: number;
  readonly toolPairScore: number;
  readonly artifactScore: number;
  readonly unresolvedErrorScore: number;
  readonly missingFactIds: readonly string[];
  readonly alteredFactIds: readonly string[];
  readonly missingToolCallIds: readonly string[];
  readonly missingArtifactUris: readonly string[];
}

export interface ContinuationQualityMetric {
  readonly score: number;
  readonly probeScore: number;
  readonly nextActionScore: number;
  readonly passedProbeIds: readonly string[];
  readonly failedProbeIds: readonly string[];
}

export interface ProviderCompatibilityMetric {
  readonly compatible: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly missingCapabilities: readonly StrategyCapability[];
  readonly providerCallsBlocked: boolean;
  readonly imageInputUnsupported: boolean;
}

export interface OperationalComplexityMetric extends OperationalComplexityInput {
  readonly burdenPoints: number;
}

export interface FailureFallbackMetric {
  readonly primaryOutcome: StrategyExecution["outcome"] | "blocked";
  readonly finalOutcome: StrategyExecution["outcome"];
  readonly fallbackAttempted: boolean;
  readonly fallbackStrategyId: string | null;
  readonly failureCode: string | null;
  readonly inputPreserved: boolean;
}

export interface BenchmarkCaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly primaryStrategyId: string;
  readonly executedStrategyId: string;
  readonly structuralFidelity: StructuralFidelityMetric;
  readonly continuationQuality: ContinuationQualityMetric;
  readonly latencyMs: number | null;
  readonly costInput: TokenImageCostInput | null;
  readonly cacheInput: CacheBehaviorInput | null;
  readonly providerCompatibility: ProviderCompatibilityMetric;
  readonly operationalComplexity: OperationalComplexityMetric;
  readonly failureFallback: FailureFallbackMetric;
}

export interface BenchmarkAggregate {
  readonly caseCount: number;
  readonly completedCaseCount: number;
  readonly fallbackCaseCount: number;
  readonly failedCaseCount: number;
  readonly meanStructuralFidelity: number;
  readonly meanContinuationQuality: number;
  readonly totalLatencyMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalImageCount: number;
  readonly totalImageBytes: number;
  readonly totalEstimatedCostUsd: number | null;
  readonly compatibleCaseCount: number;
}

export interface BenchmarkReport {
  readonly schemaVersion: "context-experiment-report/v1";
  readonly benchmarkId: string;
  readonly corpusId: string;
  readonly strategy: ExperimentStrategyManifest;
  readonly fallbackStrategy: ExperimentStrategyManifest | null;
  readonly providerCallsAllowed: boolean;
  readonly results: readonly BenchmarkCaseResult[];
  readonly aggregate: BenchmarkAggregate;
}

export interface BenchmarkRunInput {
  readonly strategy: ExperimentStrategy;
  readonly corpus: BenchmarkCorpus;
  readonly fallbackStrategy?: ExperimentStrategy;
  readonly providerCallsAllowed?: boolean;
  readonly environmentForCase?: (
    fixture: BenchmarkCase,
  ) => BenchmarkEnvironment;
  readonly signal?: AbortSignal;
}
