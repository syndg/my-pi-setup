export { noopBaselineStrategy } from "./baseline.ts";
export {
  FIXED_SYNTHETIC_CORPUS,
  SYNTHETIC_LONG_TOOL_OUTPUT,
} from "./corpus.ts";
export { renderBenchmarkJson, renderBenchmarkMarkdown } from "./report.ts";
export { runBenchmark } from "./runner.ts";
export {
  scoreContinuationQuality,
  scoreOperationalComplexity,
  scoreStructuralFidelity,
} from "./core.ts";
export {
  createDeterministicSnapcompactRenderer,
  deterministicSnapcompactRenderer,
} from "./adapters/snapcompact-renderer.ts";
export { createSnapcompactStrategy } from "./adapters/snapcompact.ts";
export {
  LOCAL_STRUCTURED_COMPACTION_FALLBACK,
  PROVIDER_COMPACTION_MANIFEST,
  createProviderCompactionRequest,
  createProviderCompactionStrategy,
} from "./adapters/provider-compaction.ts";
export {
  MODEL_PROMOTION_MANIFEST,
  createModelPromotionStrategy,
  estimatePromotionInputTokens,
} from "./adapters/model-promotion.ts";
export type {
  BenchmarkAggregate,
  BenchmarkCase,
  BenchmarkCaseResult,
  BenchmarkCorpus,
  BenchmarkEnvironment,
  BenchmarkFact,
  BenchmarkImage,
  BenchmarkMessage,
  BenchmarkMessageRole,
  BenchmarkReport,
  BenchmarkRunInput,
  BenchmarkToolCall,
  BenchmarkToolResult,
  CacheBehaviorInput,
  CapabilityRequirement,
  ContinuationAnswer,
  ContinuationFixture,
  ContinuationProbe,
  ContinuationQualityMetric,
  ExperimentFailure,
  ExperimentRequest,
  ExperimentStrategy,
  ExperimentStrategyManifest,
  FactCategory,
  FailureFallbackMetric,
  ObservedToolPair,
  OperationalComplexityInput,
  OperationalComplexityMetric,
  PreservedFact,
  ProviderCompatibilityMetric,
  StrategyCapability,
  StrategyExecution,
  StrategyMeasurements,
  StrategyOutput,
  StructuralFidelityMetric,
  StructuralObservation,
  StructuralRequirements,
  TokenImageCostInput,
  ToolPairRequirement,
} from "./types.ts";
export type {
  DeterministicRendererOptions,
  RenderedSnapcompactContext,
  SnapcompactArtifactReference,
  SnapcompactFrame,
  SnapcompactFrameRenderer,
  SnapcompactTextIndexEntry,
  SnapcompactTextKind,
} from "./adapters/snapcompact-renderer.ts";
export type {
  SnapcompactContinuationEvidence,
  SnapcompactEvidence,
  SnapcompactFactCatalogEntry,
  SnapcompactFactEvidence,
  SnapcompactProbeRequest,
  SnapcompactSourceImageReference,
  SnapcompactStrategyOptions,
  VisionEvaluator,
  VisionEvaluatorRequest,
  VisionEvaluatorResult,
  VisionEvaluatorUsage,
} from "./adapters/snapcompact.ts";
export type {
  ProviderCompactionCache,
  ProviderCompactionClient,
  ProviderCompactionCompletedResponse,
  ProviderCompactionContinuation,
  ProviderCompactionCost,
  ProviderCompactionEvidence,
  ProviderCompactionProbe,
  ProviderCompactionRejectedResponse,
  ProviderCompactionRequest,
  ProviderCompactionResponse,
  ProviderCompactionSupport,
  ProviderCompactionSupportRequest,
  ProviderCompactionUnsupportedResponse,
  ProviderCompactionUsage,
} from "./adapters/provider-compaction.ts";
export type {
  ModelPromotionStrategyOptions,
  PromotionCacheObservation,
  PromotionClient,
  PromotionInvocationRequest,
  PromotionInvocationResult,
  PromotionJsonSchema,
  PromotionJsonSchemaType,
  PromotionTargetDescriptor,
  PromotionToolDescriptor,
  PromotionToolInputSchema,
  PromotionUsage,
} from "./adapters/model-promotion.ts";
