import type { PressureLevel } from "../../shared/context-governor-state.ts";

export type { PressureLevel };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export type OutputClass =
  | "read"
  | "search"
  | "mcp-result"
  | "subagent-final"
  | "child-live-message"
  | "background-completion";

export type BudgetPressure = Exclude<PressureLevel, "emergency">;

export interface ArtifactReference {
  readonly id: string;
  readonly uri: string;
  readonly path: string;
  readonly sessionScope: string;
}

export interface ArtifactMetadata {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionScope: string;
  readonly createdAtMs: number;
  readonly toolName: string;
  readonly outputClass: OutputClass;
  readonly tags: readonly string[];
  readonly synopsis: string;
  readonly originalBytes: number;
  readonly storedBytes: number;
  readonly storedLines: number;
  readonly storedSha256: string;
  readonly redactionCount: number;
  readonly sourceMetadata: JsonObject;
}

export interface ArchivableOutput {
  readonly content: string;
  readonly toolName: string;
  readonly outputClass: OutputClass;
  readonly tags?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface StoredArtifact {
  readonly reference: ArtifactReference;
  readonly metadata: ArtifactMetadata;
}

export type RecallSlice =
  | {
      readonly kind: "bytes";
      readonly offsetBytes?: number;
      readonly maxBytes?: number;
    }
  | {
      readonly kind: "lines";
      /** One-based line number. */
      readonly startLine?: number;
      readonly lineCount?: number;
      readonly maxBytes?: number;
    };

export interface RecallRequest {
  /** A session-scoped artifact ID or context:// URI. */
  readonly artifact: string;
  readonly slice?: RecallSlice;
}

export interface RecallResult {
  readonly reference: ArtifactReference;
  readonly metadata: ArtifactMetadata;
  /** Terminal-safe, UTF-8-safe bounded content. */
  readonly content: string;
  readonly returnedBytes: number;
  readonly range: {
    readonly startByte: number;
    readonly endByte: number;
    readonly startLine?: number;
    readonly endLine?: number;
  };
  readonly truncated: boolean;
  readonly next: {
    readonly kind: "bytes";
    readonly offsetBytes: number;
  } | null;
}

export interface ArchiveQuery {
  readonly toolName?: string;
  readonly outputClass?: OutputClass;
  readonly tags?: readonly string[];
  readonly text?: string;
  readonly createdAfterMs?: number;
  readonly createdBeforeMs?: number;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

export interface ArchiveQueryResult {
  readonly artifacts: readonly StoredArtifact[];
  readonly matched: number;
  readonly limited: boolean;
}

/**
 * Session-scoped durable artifact module. Store resolves only after content,
 * metadata, and the query index are durable.
 */
export interface ContextArchive {
  store(output: ArchivableOutput): Promise<StoredArtifact>;
  recall(request: RecallRequest): Promise<RecallResult>;
  query(request?: ArchiveQuery): Promise<ArchiveQueryResult>;
}

export interface RedactionInput {
  readonly content: string;
  readonly metadata: JsonObject;
}

export interface RedactionResult {
  readonly content: string;
  readonly metadata: JsonObject;
  readonly redactionCount: number;
}

export type Redactor = (
  input: RedactionInput,
) => RedactionResult | Promise<RedactionResult>;

export interface OutputRequest {
  readonly toolName: string;
  readonly outputClass?: OutputClass;
  readonly pressure: PressureLevel | null;
  readonly rawOutput: string;
  /** Explicit caller override. It is always bounded by the hard ceiling. */
  readonly explicitLimitBytes?: number;
  /** Optional adapter-facing presentation for an archived error result. */
  readonly presentation?: "standard" | "error";
  /** Optional bounded tool name used in retrieval instructions. */
  readonly recallToolName?: string;
  readonly metadata?: JsonObject;
  readonly tags?: readonly string[];
}

export interface OutputBudgetDecision {
  readonly outputClass: OutputClass;
  readonly pressure: BudgetPressure;
  readonly defaultLimitBytes: number;
  readonly requestedLimitBytes: number | null;
  readonly appliedLimitBytes: number;
  readonly boundedByHardCeiling: boolean;
  readonly usedExplicitLimit: boolean;
}

export interface OutputMetrics {
  readonly toolName: string;
  readonly outputClass: OutputClass;
  readonly pressure: BudgetPressure;
  readonly inputBytes: number;
  readonly deliveredBytes: number;
  readonly artifactBytes: number;
  readonly bytesSaved: number;
  readonly estimatedInputTokens: number;
  readonly estimatedDeliveredTokens: number;
  readonly estimatedTokensSaved: number;
  readonly artifactStored: boolean;
  readonly failOpen: boolean;
}

export type OutputDisposition = "inline" | "archived" | "fail-open";

export interface OutputEnvelope {
  readonly disposition: OutputDisposition;
  /** The exact string an adapter may return to provider context. */
  readonly output: string;
  readonly shortened: boolean;
  readonly synopsis: string;
  readonly counts: {
    readonly inputBytes: number;
    readonly inputCharacters: number;
    readonly inputLines: number;
    readonly deliveredBytes: number;
  };
  readonly truncationReason: string | null;
  readonly retrievalInstructions: string | null;
  readonly artifact: StoredArtifact | null;
  readonly budget: OutputBudgetDecision;
  readonly metrics: OutputMetrics;
  /** Present only when unchanged raw output was returned after archive failure. */
  readonly persistenceError: string | null;
}

export interface OutputBroker {
  process(request: OutputRequest): Promise<OutputEnvelope>;
}
