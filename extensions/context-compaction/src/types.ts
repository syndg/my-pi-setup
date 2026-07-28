import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type {
  CheckpointContextPolicyState,
  CheckpointValidationIssue,
  ContextCheckpoint,
} from "../../context-checkpoints/src/index.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** A committed, context-visible entry. Queued messages deliberately use no place in this type. */
export interface CompactionTranscriptEntry {
  readonly id: string;
  readonly message: AgentMessage;
  /** Deterministic test/adapter override; otherwise a chars/4 estimate is used. */
  readonly estimatedTokens?: number;
}

export interface RetainedBoundaryConfig {
  readonly minimumTokens: number;
  readonly targetTokens: number;
  readonly maximumTokens: number;
}

export const DEFAULT_RETAINED_BOUNDARY = Object.freeze({
  minimumTokens: 8_000,
  targetTokens: 10_000,
  maximumTokens: 12_000,
}) satisfies RetainedBoundaryConfig;

export interface SerializationLimits {
  readonly totalBytes: number;
  readonly previousSummaryBytes: number;
  readonly previousCheckpointBytes: number;
  readonly historyBytes: number;
  readonly splitTurnPrefixBytes: number;
  readonly retainedSuffixBytes: number;
  readonly messageBytes: number;
  readonly toolResultBytes: number;
}

export const DEFAULT_SERIALIZATION_LIMITS = Object.freeze({
  totalBytes: 131_072,
  previousSummaryBytes: 24_576,
  previousCheckpointBytes: 65_536,
  historyBytes: 65_536,
  splitTurnPrefixBytes: 24_576,
  retainedSuffixBytes: 16_384,
  messageBytes: 8_192,
  toolResultBytes: 2_000,
}) satisfies SerializationLimits;

export interface BoundarySelection {
  readonly firstKeptEntryId: string;
  readonly firstKeptIndex: number;
  readonly retainedEstimatedTokens: number;
  readonly summarizedEstimatedTokens: number;
  readonly isSplitTurn: boolean;
  readonly turnStartIndex: number | null;
  readonly history: readonly CompactionTranscriptEntry[];
  readonly splitTurnPrefix: readonly CompactionTranscriptEntry[];
  readonly retainedSuffix: readonly CompactionTranscriptEntry[];
}

export interface BoundedCompactionPacket {
  readonly text: string;
  readonly bytes: number;
  readonly truncatedSections: readonly string[];
}

export interface SummaryModelRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly reason: CompactionReason;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface SummaryModelResponse {
  readonly text: string;
  readonly usage?: Usage;
}

/** Internal model seam. The Pi registry implementation is one adapter; tests use a fake. */
export interface CheckpointSummaryModel {
  summarize(request: SummaryModelRequest): Promise<SummaryModelResponse>;
}

export interface VerificationRequest {
  readonly checkpoint: ContextCheckpoint;
  readonly serializedInput: string;
  readonly reason: CompactionReason;
  readonly firstKeptEntryId: string;
  readonly signal?: AbortSignal;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly usage?: Usage;
}

export interface CheckpointVerifier {
  verify(request: VerificationRequest): Promise<VerificationResult>;
}

export type ReasonAction = "custom" | "native";
export type FailureAction = "local" | "native";

export interface ResolvedReasonPolicy {
  readonly reason: CompactionReason;
  readonly action: ReasonAction;
  readonly onFailure: FailureAction;
}

export interface ReasonPolicyConfig {
  readonly manual?: Partial<Omit<ResolvedReasonPolicy, "reason">>;
  readonly threshold?: Partial<Omit<ResolvedReasonPolicy, "reason">>;
  readonly overflow?: Partial<Omit<ResolvedReasonPolicy, "reason">>;
}

export interface CompactionPrototypeInput {
  readonly reason: CompactionReason;
  /** Committed branch entries only, in provider order. */
  readonly entries: readonly CompactionTranscriptEntry[];
  readonly tokensBefore: number;
  /** Repeated compaction starts at this prior kept boundary when supplied. */
  readonly summarizeFromEntryId?: string;
  readonly previousSummary?: string;
  readonly previousCheckpoint?: unknown;
  readonly customInstructions?: string;
  readonly contextPolicyState?: CheckpointContextPolicyState;
  readonly boundary?: Partial<RetainedBoundaryConfig>;
  readonly serialization?: Partial<SerializationLimits>;
  readonly reasonPolicy?: ReasonPolicyConfig;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  /** Explicitly ignored: Pi owns queue resumption outside this prototype. */
  readonly queuedMessages?: readonly unknown[];
}

export interface ContextCompactionDetails {
  readonly prototype: "context-compaction/phase-6a";
  readonly checkpointSchema: "context-checkpoint/v1";
  readonly reason: CompactionReason;
  readonly source: "model" | "local-fallback";
  readonly retainedEstimatedTokens: number;
  readonly summarizedEstimatedTokens: number;
  readonly isSplitTurn: boolean;
  readonly verifier: "not-run" | "passed" | "failed";
  readonly inputBytes: number;
  readonly truncatedInputSections: readonly string[];
}

export type CompatibleCompactionResult =
  CompactionResult<ContextCompactionDetails>;

export type NativeFallbackCode =
  | "reason-policy"
  | "no-valid-boundary"
  | "invalid-previous-checkpoint"
  | "model-failure"
  | "malformed-model-output"
  | "verifier-rejected"
  | "local-fallback-failed";

export type CompactionPrototypeDecision =
  | {
      readonly kind: "custom";
      readonly result: CompatibleCompactionResult;
      readonly checkpoint: ContextCheckpoint;
      readonly boundary: BoundarySelection;
      readonly source: "model" | "local-fallback";
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: "native-fallback";
      readonly code: NativeFallbackCode;
      readonly message: string;
      readonly validationIssues?: readonly CheckpointValidationIssue[];
      readonly boundary?: BoundarySelection;
      readonly usage?: Usage;
    };

export interface ReconstructedContext {
  readonly summary: ContextCheckpoint;
  readonly firstKeptEntryId: string;
  readonly retainedEntries: readonly CompactionTranscriptEntry[];
}
