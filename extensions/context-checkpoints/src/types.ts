export const CHECKPOINT_SCHEMA_VERSION = "context-checkpoint/v1" as const;

export const CHECKPOINT_LIMITS = Object.freeze({
  totalBytes: 131_072,
  goalBytes: 8_192,
  itemBytes: 4_096,
  rationaleBytes: 6_144,
  pathBytes: 2_048,
  referenceLocatorBytes: 4_096,
  maxSectionItems: 100,
  maxChangedFiles: 200,
  maxCriticalReferences: 100,
  maxContextNotes: 40,
});

export type CheckpointSchemaVersion = typeof CHECKPOINT_SCHEMA_VERSION;

export type PressureLevel =
  "green" | "yellow" | "orange" | "red" | "emergency" | "unknown";

export type MeasurementSource = "pi-usage" | "message-estimate" | "unknown";

export interface CheckpointDecision {
  readonly decision: string;
  readonly rationale: string;
}

export type ChangedFileStatus = "created" | "modified" | "deleted" | "renamed";

export interface CheckpointChangedFile {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly summary?: string;
}

export type TestOutcomeStatus = "passed" | "failed" | "partial" | "not-run";

export interface CheckpointTestOutcome {
  readonly command: string;
  readonly status: TestOutcomeStatus;
  readonly outcome: string;
}

export type CriticalReferenceKind = "session-entry" | "artifact";

export interface CheckpointCriticalReference {
  readonly kind: CriticalReferenceKind;
  readonly id: string;
  readonly uri?: string;
  readonly label?: string;
}

/** A bounded snapshot that can be populated from the governor now and dual accounting later. */
export interface CheckpointContextPolicyState {
  readonly pressure: PressureLevel;
  readonly measurementSource: MeasurementSource;
  readonly residentTokens: number | null;
  readonly effectiveWireTokens: number | null;
  readonly safeLimitTokens: number | null;
  readonly headroomTokens: number | null;
  readonly runwayRuns: number | null;
  readonly capturedAtMs: number;
  readonly notes: readonly string[];
}

export interface OriginalSessionPointer {
  readonly sessionId: string;
  readonly branchLeafId?: string;
  readonly transcriptPath?: string;
}

export interface ContextCheckpoint {
  readonly schemaVersion: CheckpointSchemaVersion;
  readonly goal: string;
  readonly constraintsAndPreferences: readonly string[];
  readonly completedWork: readonly string[];
  readonly workingSet: readonly string[];
  readonly decisions: readonly CheckpointDecision[];
  readonly changedFiles: readonly CheckpointChangedFile[];
  readonly testsAndOutcomes: readonly CheckpointTestOutcome[];
  readonly unresolvedQuestions: readonly string[];
  readonly blockers: readonly string[];
  readonly nextActions: readonly string[];
  readonly criticalReferences: readonly CheckpointCriticalReference[];
  readonly contextPolicyState: CheckpointContextPolicyState;
  readonly originalSession?: OriginalSessionPointer;
}

export interface RunRecapInput {
  readonly recap: string;
  readonly next: string;
}

export interface CheckpointUpdate {
  readonly goal?: string;
  readonly constraintsAndPreferences?: readonly string[];
  readonly completedWork?: readonly string[];
  readonly workingSet?: readonly string[];
  readonly decisions?: readonly CheckpointDecision[];
  readonly changedFiles?: readonly CheckpointChangedFile[];
  readonly testsAndOutcomes?: readonly CheckpointTestOutcome[];
  readonly unresolvedQuestions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly nextActions?: readonly string[];
  readonly criticalReferences?: readonly CheckpointCriticalReference[];
  readonly contextPolicyState?: CheckpointContextPolicyState;
  readonly originalSession?: OriginalSessionPointer;
}

export interface CheckpointMergeInput {
  /** Must be a valid checkpoint when supplied; malformed prior state is never ignored. */
  readonly previous?: unknown;
  /** UI-only summaries-extension recaps, oldest to newest. */
  readonly recaps?: readonly RunRecapInput[];
  /** Current authoritative state and newly learned durable facts. */
  readonly updates?: CheckpointUpdate;
}

export type CheckpointIssueCode =
  | "required"
  | "type"
  | "unknown-field"
  | "unsupported-version"
  | "empty"
  | "too-long"
  | "too-many"
  | "invalid-value"
  | "total-size"
  | "malformed-json";

export interface CheckpointValidationIssue {
  readonly path: string;
  readonly code: CheckpointIssueCode;
  readonly message: string;
}

export type CheckpointValidation =
  | {
      readonly ok: true;
      readonly checkpoint: ContextCheckpoint;
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly issues: readonly CheckpointValidationIssue[];
    };
