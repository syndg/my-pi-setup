import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type DecayClass =
  | "superseded-read"
  | "superseded-search"
  | "consumed-search"
  | "acknowledged-async"
  | "empty-output"
  | "old-large-result"
  | "duplicate";

export type ProtectionReason =
  | "recent-working-set"
  | "latest-relevant-read"
  | "current-goal-constraints"
  | "unresolved-error"
  | "explicit-pin"
  | "latest-checkpoint-handoff"
  | "structural-tool-call"
  | "unrecallable-source";

export interface DecayMessageInput {
  readonly message: AgentMessage;
  /** Session entry ID supplied by the adapter when it can map the context copy. */
  readonly entryId?: string;
  /** True only when entryId is present on the active durable session branch. */
  readonly entryRecallable?: boolean;
  /** Durable context-archive URI, when the producing adapter supplied one. */
  readonly artifactUri?: string;
  readonly labels?: readonly string[];
}

export interface DecayContext {
  readonly sessionId: string;
  readonly modelKey: string;
  /** Changes after compaction/tree reconstruction. It is part of the epoch identity. */
  readonly contextGeneration: string;
  readonly messages: readonly DecayMessageInput[];
}

export interface DecayConfig {
  readonly protectedRecentTokens: number;
  readonly oldLargeResultTokens: number;
  readonly minimumReplacementSavingsTokens: number;
  readonly maximumWireTokens: number | null;
  readonly pinnedIdentities: readonly string[];
}

export interface RecallReference {
  readonly kind: "artifact" | "session-entry";
  readonly uri: string;
  readonly artifact?: string;
  readonly sessionId?: string;
  readonly entryId?: string;
}

export interface Replacement {
  readonly identity: string;
  readonly messageIndex: number;
  readonly classification: DecayClass;
  readonly toolName: string;
  readonly originalTokens: number;
  readonly placeholderTokens: number;
  readonly tokensSaved: number;
  readonly originalDigest: string;
  readonly placeholder: string;
  readonly recall: RecallReference;
}

export interface CandidateDecision {
  readonly identity: string;
  readonly messageIndex: number;
  readonly classification: DecayClass;
  readonly estimatedTokens: number;
  readonly protectedBy: readonly ProtectionReason[];
  readonly recoverable: boolean;
  readonly selected: boolean;
  readonly blockedReason:
    "protected" | "unrecoverable" | "below-savings-floor" | null;
}

export interface SequenceValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DecayAccounting {
  readonly residentTokens: number;
  readonly effectiveWireTokens: number;
  readonly proposedTokensSaved: number;
  readonly residentSource: "message-estimate";
  readonly wireSource: "message-estimate";
}

export interface DecayEpoch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly modelKey: string;
  readonly contextGeneration: string;
  readonly replacements: Readonly<Record<string, Replacement>>;
  readonly replacementOrder: readonly string[];
  /** Digest of the exact context at planning time; append-only application keeps this cache epoch fixed. */
  readonly plannedContextDigest: string;
}

export interface DecayPlan {
  readonly epoch: DecayEpoch;
  readonly candidates: readonly CandidateDecision[];
  readonly protectedIdentities: Readonly<
    Record<string, readonly ProtectionReason[]>
  >;
  readonly accounting: DecayAccounting;
  readonly inputValidation: SequenceValidation;
  readonly outputValidation: SequenceValidation;
  readonly oversizedProtectedTurn: boolean;
}

export interface DecayTransformation {
  readonly cacheEpochId: string;
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly inputMessageCount: number;
  readonly outputMessageCount: number;
  readonly replacementCount: number;
}

export interface DecayedContext {
  readonly messages: readonly AgentMessage[];
  readonly epoch: DecayEpoch;
  readonly accounting: DecayAccounting;
  readonly validation: SequenceValidation;
  readonly transformation: DecayTransformation;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = Object.freeze({
  protectedRecentTokens: 20_000,
  oldLargeResultTokens: 4_000,
  minimumReplacementSavingsTokens: 128,
  maximumWireTokens: null,
  pinnedIdentities: Object.freeze([]),
});
