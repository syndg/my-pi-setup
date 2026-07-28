export const MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_CATEGORIES = [
  "user-preference",
  "project-convention",
  "architectural-decision",
  "environment-fact",
] as const;

export const MEMORY_SOURCE_KINDS = [
  "user-statement",
  "project-document",
  "architecture-record",
  "environment-observation",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];
export type MemoryStatus = "active" | "superseded";
export type MemorySearchScope = "global" | "project" | "all";

export type MemoryScope =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly project: string };

export interface MemorySource {
  readonly kind: MemorySourceKind;
  readonly reference: string;
}

export interface MemoryRecord {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  readonly id: string;
  readonly category: MemoryCategory;
  readonly scope: MemoryScope;
  readonly fact: string;
  readonly sources: readonly MemorySource[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastConfirmedAtMs: number;
  readonly expiresAtMs: number;
  readonly confidence: number;
  readonly status: MemoryStatus;
}

export interface MemoryDocument {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  readonly updatedAtMs: number;
  readonly records: readonly MemoryRecord[];
}

export interface RememberMemoryInput {
  readonly category: MemoryCategory;
  readonly scope: MemoryScope;
  readonly fact: string;
  readonly source: MemorySource;
  readonly confidence?: number;
  readonly retentionDays?: number;
}

export interface RememberMemoryResult {
  readonly record: MemoryRecord;
  readonly created: boolean;
  readonly deduplicated: boolean;
  readonly expiredRemoved: number;
  readonly redactionCount: number;
}

export interface SearchMemoryInput {
  readonly query?: string;
  readonly scope?: MemorySearchScope;
  readonly project?: string;
  readonly category?: MemoryCategory;
  readonly limit?: number;
  readonly maxBytes?: number;
}

export interface MemorySearchMatch {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface SearchMemoryResult {
  readonly matches: readonly MemorySearchMatch[];
  readonly matched: number;
  readonly limited: boolean;
  readonly returnedBytes: number;
  readonly maximumBytes: number;
}

export interface ForgetMemoryInput {
  readonly id: string;
  readonly project?: string;
}

export interface ForgetMemoryResult {
  readonly forgotten: boolean;
  readonly id: string;
}

export interface ConsolidateMemoryInput {
  readonly scope?: MemorySearchScope;
  readonly project?: string;
}

export interface ConsolidateMemoryResult {
  readonly before: number;
  readonly after: number;
  readonly duplicatesMerged: number;
  readonly expiredRemoved: number;
}

export interface MemoryLimits {
  readonly maximumRecords: number;
  readonly maximumStorageBytes: number;
  readonly maximumFactBytes: number;
  readonly maximumReferenceBytes: number;
  readonly maximumSourcesPerRecord: number;
  readonly defaultSearchResults: number;
  readonly maximumSearchResults: number;
  readonly defaultRecallBytes: number;
  readonly maximumRecallBytes: number;
  readonly defaultRetentionDays: number;
  readonly maximumRetentionDays: number;
}

export interface MemoryPersistenceUpdate<T> {
  /** Omit for a locked no-op (for example, forgetting an unknown ID). */
  readonly serializedDocument?: string;
  readonly result: T;
}

export interface MemoryPersistence {
  /** Lock-free, fail-safe snapshot read used by search. */
  load(): Promise<string | null>;
  /** Serialize a complete read-modify-write transaction across all store instances. */
  update<T>(
    operation: (
      serializedDocument: string | null,
    ) => MemoryPersistenceUpdate<T> | Promise<MemoryPersistenceUpdate<T>>,
  ): Promise<T>;
}

export interface SecretPolicyInput {
  readonly fact: string;
  readonly source: MemorySource;
}

export type SecretPolicyDecision =
  | {
      readonly action: "accept" | "redact";
      readonly fact: string;
      readonly source: MemorySource;
      readonly redactionCount: number;
    }
  | { readonly action: "reject"; readonly reason: string };

export type MemorySecretPolicy = (
  input: SecretPolicyInput,
) => SecretPolicyDecision | Promise<SecretPolicyDecision>;

/** The deep module interface used by both the Pi adapter and tests. */
export interface ContextMemory {
  remember(input: RememberMemoryInput): Promise<RememberMemoryResult>;
  search(input?: SearchMemoryInput): Promise<SearchMemoryResult>;
  forget(input: ForgetMemoryInput): Promise<ForgetMemoryResult>;
  consolidate(input?: ConsolidateMemoryInput): Promise<ConsolidateMemoryResult>;
}
