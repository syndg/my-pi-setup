import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { rejectCommonSecrets } from "./secrets.ts";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SOURCE_KINDS,
  type ConsolidateMemoryInput,
  type ConsolidateMemoryResult,
  type ContextMemory,
  type ForgetMemoryInput,
  type ForgetMemoryResult,
  type MemoryCategory,
  type MemoryDocument,
  type MemoryLimits,
  type MemoryPersistence,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchMatch,
  type MemorySearchScope,
  type MemorySecretPolicy,
  type MemorySource,
  type RememberMemoryInput,
  type RememberMemoryResult,
  type SearchMemoryInput,
  type SearchMemoryResult,
  type SecretPolicyDecision,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ID_PATTERN = /^mem_[a-z0-9][a-z0-9_-]{5,63}$/i;
const TRANSCRIPT_PATTERN =
  /(?:^|\n)\s*(?:user|assistant|tool(?: result)?)\s*:/i;
const CHECKPOINT_PATTERN =
  /^\s*(?:checkpoint|goal|completed work|next actions?|current task|tool outputs?|transcript)\s*:/i;
const TRANSIENT_PATTERN =
  /\b(?:for this task|this turn|right now|today only|temporary checkpoint)\b/i;

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = Object.freeze({
  maximumRecords: 500,
  maximumStorageBytes: 256 * 1024,
  maximumFactBytes: 1_024,
  maximumReferenceBytes: 384,
  maximumSourcesPerRecord: 4,
  defaultSearchResults: 8,
  maximumSearchResults: 20,
  defaultRecallBytes: 4 * 1024,
  maximumRecallBytes: 8 * 1024,
  defaultRetentionDays: 365,
  maximumRetentionDays: 3_650,
});

export class MemoryPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryPolicyError";
    this.code = code;
  }
}

export interface ContextMemoryOptions {
  readonly persistence: MemoryPersistence;
  readonly limits?: Partial<MemoryLimits>;
  readonly clock?: () => number;
  readonly idGenerator?: () => string;
  readonly secretPolicy?: MemorySecretPolicy;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizedLimits(
  input: Partial<MemoryLimits> | undefined,
): MemoryLimits {
  const defaults = DEFAULT_MEMORY_LIMITS;
  const maximumSearchResults = positiveInteger(
    input?.maximumSearchResults,
    defaults.maximumSearchResults,
  );
  const maximumRecallBytes = positiveInteger(
    input?.maximumRecallBytes,
    defaults.maximumRecallBytes,
  );
  const maximumRetentionDays = positiveInteger(
    input?.maximumRetentionDays,
    defaults.maximumRetentionDays,
  );
  return Object.freeze({
    maximumRecords: positiveInteger(
      input?.maximumRecords,
      defaults.maximumRecords,
    ),
    maximumStorageBytes: positiveInteger(
      input?.maximumStorageBytes,
      defaults.maximumStorageBytes,
    ),
    maximumFactBytes: positiveInteger(
      input?.maximumFactBytes,
      defaults.maximumFactBytes,
    ),
    maximumReferenceBytes: positiveInteger(
      input?.maximumReferenceBytes,
      defaults.maximumReferenceBytes,
    ),
    maximumSourcesPerRecord: positiveInteger(
      input?.maximumSourcesPerRecord,
      defaults.maximumSourcesPerRecord,
    ),
    defaultSearchResults: Math.min(
      maximumSearchResults,
      positiveInteger(
        input?.defaultSearchResults,
        defaults.defaultSearchResults,
      ),
    ),
    maximumSearchResults,
    defaultRecallBytes: Math.min(
      maximumRecallBytes,
      positiveInteger(input?.defaultRecallBytes, defaults.defaultRecallBytes),
    ),
    maximumRecallBytes,
    defaultRetentionDays: Math.min(
      maximumRetentionDays,
      positiveInteger(
        input?.defaultRetentionDays,
        defaults.defaultRetentionDays,
      ),
    ),
    maximumRetentionDays,
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/[\t ]+/g, " ");
  if (normalized.length === 0)
    throw new MemoryPolicyError("empty", `${label} must not be empty`);
  if (byteLength(normalized) > maximumBytes) {
    throw new MemoryPolicyError(
      "field-bound",
      `${label} exceeds its ${maximumBytes}-byte bound`,
    );
  }
  return normalized;
}

function normalizeProject(value: string): string {
  if (!isAbsolute(value))
    throw new MemoryPolicyError(
      "scope",
      "project scope requires an absolute project path",
    );
  return resolve(value);
}

export function projectMemoryScope(project: string): MemoryScope {
  return Object.freeze({ kind: "project", project: normalizeProject(project) });
}

function normalizeScope(scope: MemoryScope): MemoryScope {
  if (scope.kind === "global") return Object.freeze({ kind: "global" });
  if (scope.kind === "project") return projectMemoryScope(scope.project);
  throw new MemoryPolicyError(
    "scope",
    "memory scope must be global or project",
  );
}

function categoryIs(value: unknown): value is MemoryCategory {
  return (
    typeof value === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}

function sourceKindIs(value: unknown): value is MemorySource["kind"] {
  return (
    typeof value === "string" &&
    (MEMORY_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

function stableFact(value: string, maximumBytes: number): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new MemoryPolicyError(
      "not-stable-fact",
      "Memory accepts one stable fact, not multiline transcript or output content.",
    );
  }
  const fact = boundedText(value, "fact", maximumBytes);
  if (
    TRANSCRIPT_PATTERN.test(fact) ||
    CHECKPOINT_PATTERN.test(fact) ||
    TRANSIENT_PATTERN.test(fact)
  ) {
    throw new MemoryPolicyError(
      "not-stable-fact",
      "Live task, transcript, checkpoint, and tool-output material is not eligible for memory.",
    );
  }
  return fact;
}

function normalizeSource(
  source: MemorySource,
  limits: MemoryLimits,
): MemorySource {
  if (!sourceKindIs(source.kind))
    throw new MemoryPolicyError("source", "Unsupported memory source kind");
  return Object.freeze({
    kind: source.kind,
    reference: boundedText(
      source.reference,
      "source reference",
      limits.maximumReferenceBytes,
    ),
  });
}

function validateCategoryScope(
  category: MemoryCategory,
  scope: MemoryScope,
): void {
  if (
    (category === "project-convention" ||
      category === "architectural-decision") &&
    scope.kind !== "project"
  ) {
    throw new MemoryPolicyError(
      "scope",
      `${category} memories require project scope`,
    );
  }
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 0.8;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryPolicyError(
      "confidence",
      "confidence must be between 0 and 1",
    );
  }
  return Math.round(value * 1_000) / 1_000;
}

function retentionDays(
  value: number | undefined,
  limits: MemoryLimits,
): number {
  const selected = value ?? limits.defaultRetentionDays;
  if (
    !Number.isFinite(selected) ||
    selected <= 0 ||
    selected > limits.maximumRetentionDays
  ) {
    throw new MemoryPolicyError(
      "retention",
      `retentionDays must be between 1 and ${limits.maximumRetentionDays}`,
    );
  }
  return Math.max(1, Math.floor(selected));
}

function defaultId(): string {
  return `mem_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
}

function canonicalFact(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scopeKey(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.project}`;
}

function dedupKey(
  record: Pick<MemoryRecord, "category" | "scope" | "fact">,
): string {
  return `${record.category}\u0000${scopeKey(record.scope)}\u0000${canonicalFact(record.fact)}`;
}

function sourceKey(source: MemorySource): string {
  return `${source.kind}\u0000${source.reference.normalize("NFKC").toLocaleLowerCase("en-US")}`;
}

function mergeSources(
  groups: readonly (readonly MemorySource[])[],
  maximum: number,
): readonly MemorySource[] {
  const seen = new Set<string>();
  const output: MemorySource[] = [];
  for (const sources of groups) {
    for (const source of sources) {
      const key = sourceKey(source);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(Object.freeze({ ...source }));
      if (output.length >= maximum) return Object.freeze(output);
    }
  }
  return Object.freeze(output);
}

function isRecord(value: unknown, limits: MemoryLimits): value is MemoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<MemoryRecord>;
  if (
    record.schemaVersion !== MEMORY_SCHEMA_VERSION ||
    typeof record.id !== "string" ||
    !ID_PATTERN.test(record.id) ||
    !categoryIs(record.category) ||
    typeof record.fact !== "string" ||
    byteLength(record.fact) > limits.maximumFactBytes ||
    !Array.isArray(record.sources) ||
    record.sources.length < 1 ||
    record.sources.length > limits.maximumSourcesPerRecord ||
    !record.sources.every(
      (source) =>
        typeof source === "object" &&
        source !== null &&
        sourceKindIs(source.kind) &&
        typeof source.reference === "string" &&
        byteLength(source.reference) <= limits.maximumReferenceBytes,
    ) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    !Number.isSafeInteger(record.lastConfirmedAtMs) ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    typeof record.confidence !== "number" ||
    record.confidence < 0 ||
    record.confidence > 1 ||
    (record.status !== "active" && record.status !== "superseded")
  )
    return false;
  if (typeof record.scope !== "object" || record.scope === null) return false;
  return (
    record.scope.kind === "global" ||
    (record.scope.kind === "project" &&
      typeof record.scope.project === "string" &&
      isAbsolute(record.scope.project))
  );
}

function freezeRecord(record: MemoryRecord): MemoryRecord {
  return Object.freeze({
    ...record,
    scope: Object.freeze({ ...record.scope }),
    sources: Object.freeze(
      record.sources.map((source) => Object.freeze({ ...source })),
    ),
  });
}

function parseDocument(
  serialized: string | null,
  limits: MemoryLimits,
  now: number,
): MemoryDocument {
  if (serialized === null)
    return Object.freeze({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAtMs: now,
      records: Object.freeze([]),
    });
  if (byteLength(serialized) > limits.maximumStorageBytes) {
    throw new MemoryPolicyError(
      "storage-bound",
      "Memory file exceeds configured storage bound",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new MemoryPolicyError("schema", "Memory file is not valid JSON");
  }
  if (typeof value !== "object" || value === null)
    throw new MemoryPolicyError("schema", "Memory document must be an object");
  const document = value as Partial<MemoryDocument>;
  if (document.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryPolicyError(
      "schema-version",
      `Unsupported memory schema version: ${String(document.schemaVersion)}`,
    );
  }
  if (
    !Number.isSafeInteger(document.updatedAtMs) ||
    !Array.isArray(document.records)
  ) {
    throw new MemoryPolicyError("schema", "Invalid memory document metadata");
  }
  if (document.records.length > limits.maximumRecords) {
    throw new MemoryPolicyError(
      "storage-bound",
      "Memory record count exceeds configured bound",
    );
  }
  if (!document.records.every((record) => isRecord(record, limits))) {
    throw new MemoryPolicyError(
      "schema",
      "Memory document contains an invalid record",
    );
  }
  const ids = new Set<string>();
  for (const record of document.records) {
    if (ids.has(record.id))
      throw new MemoryPolicyError(
        "schema",
        `Duplicate memory id: ${record.id}`,
      );
    ids.add(record.id);
  }
  const updatedAtMs = document.updatedAtMs as number;
  return Object.freeze({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAtMs,
    records: Object.freeze(document.records.map(freezeRecord)),
  });
}

function serializeDocument(
  records: readonly MemoryRecord[],
  now: number,
  limits: MemoryLimits,
): string {
  if (records.length > limits.maximumRecords) {
    throw new MemoryPolicyError(
      "storage-bound",
      `Memory is full (${limits.maximumRecords} records); forget or consolidate first.`,
    );
  }
  const serialized = `${JSON.stringify({ schemaVersion: MEMORY_SCHEMA_VERSION, updatedAtMs: now, records })}\n`;
  if (byteLength(serialized) > limits.maximumStorageBytes) {
    throw new MemoryPolicyError(
      "storage-bound",
      `Memory exceeds its ${limits.maximumStorageBytes}-byte storage bound; forget or consolidate first.`,
    );
  }
  return serialized;
}

function eligible(
  record: MemoryRecord,
  scope: MemorySearchScope,
  project: string | undefined,
): boolean {
  if (scope === "global") return record.scope.kind === "global";
  if (scope === "project")
    return (
      record.scope.kind === "project" &&
      project !== undefined &&
      record.scope.project === project
    );
  return (
    record.scope.kind === "global" ||
    (record.scope.kind === "project" &&
      project !== undefined &&
      record.scope.project === project)
  );
}

function normalizeSearchProject(
  scope: MemorySearchScope,
  project: string | undefined,
): string | undefined {
  if (scope === "global") return undefined;
  if (project === undefined)
    throw new MemoryPolicyError(
      "scope",
      `${scope} search requires the current project`,
    );
  return normalizeProject(project);
}

function scoreRecord(record: MemoryRecord, query: string): number {
  const normalizedQuery = canonicalFact(query);
  if (normalizedQuery.length === 0) return 1;
  const terms = [...new Set(normalizedQuery.split(" ").filter(Boolean))];
  const fact = canonicalFact(record.fact);
  const references = record.sources
    .map((source) => canonicalFact(source.reference))
    .join(" ");
  let score = fact.includes(normalizedQuery) ? 20 : 0;
  for (const term of terms) {
    if (fact.includes(term)) score += 4;
    if (references.includes(term)) score += 1;
    if (canonicalFact(record.category).includes(term)) score += 1;
  }
  return score;
}

function selectedMaximum(
  requested: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(maximum, Math.floor(requested));
}

function scopeForConsolidation(input: ConsolidateMemoryInput): {
  readonly scope: MemorySearchScope;
  readonly project?: string;
} {
  const scope = input.scope ?? "all";
  const project = normalizeSearchProject(scope, input.project);
  return project === undefined
    ? Object.freeze({ scope })
    : Object.freeze({ scope, project });
}

function consolidateSelected(
  records: readonly MemoryRecord[],
  input: ConsolidateMemoryInput,
  now: number,
  limits: MemoryLimits,
): {
  readonly records: readonly MemoryRecord[];
  readonly duplicatesMerged: number;
  readonly expiredRemoved: number;
} {
  const target = scopeForConsolidation(input);
  const untouched: MemoryRecord[] = [];
  const selected: MemoryRecord[] = [];
  let expiredRemoved = 0;
  for (const record of records) {
    if (!eligible(record, target.scope, target.project)) {
      untouched.push(record);
    } else if (record.expiresAtMs <= now || record.status !== "active") {
      expiredRemoved += 1;
    } else {
      selected.push(record);
    }
  }
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of selected) {
    const key = dedupKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  let duplicatesMerged = 0;
  const merged = [...groups.values()].map((group) => {
    group.sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
    );
    const canonical = group[0] as MemoryRecord;
    duplicatesMerged += group.length - 1;
    if (group.length === 1) return canonical;
    return freezeRecord({
      ...canonical,
      sources: mergeSources(
        group.map((record) => record.sources),
        limits.maximumSourcesPerRecord,
      ),
      createdAtMs: Math.min(...group.map((record) => record.createdAtMs)),
      updatedAtMs: now,
      lastConfirmedAtMs: Math.max(
        ...group.map((record) => record.lastConfirmedAtMs),
      ),
      expiresAtMs: Math.max(...group.map((record) => record.expiresAtMs)),
      confidence: Math.max(...group.map((record) => record.confidence)),
      status: "active",
    });
  });
  const output = [...untouched, ...merged].sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
  );
  return Object.freeze({
    records: Object.freeze(output),
    duplicatesMerged,
    expiredRemoved,
  });
}

class FileContextMemory implements ContextMemory {
  readonly #persistence: MemoryPersistence;
  readonly #limits: MemoryLimits;
  readonly #clock: () => number;
  readonly #idGenerator: () => string;
  readonly #secretPolicy: MemorySecretPolicy;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ContextMemoryOptions) {
    this.#persistence = options.persistence;
    this.#limits = normalizedLimits(options.limits);
    this.#clock = options.clock ?? Date.now;
    this.#idGenerator = options.idGenerator ?? defaultId;
    this.#secretPolicy = options.secretPolicy ?? rejectCommonSecrets;
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release = () => {};
    this.#queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #load(now: number): Promise<MemoryDocument> {
    return parseDocument(await this.#persistence.load(), this.#limits, now);
  }

  async remember(input: RememberMemoryInput): Promise<RememberMemoryResult> {
    return this.#serialized(async () => {
      if (!categoryIs(input.category))
        throw new MemoryPolicyError(
          "category",
          "Unsupported stable memory category",
        );
      const scope = normalizeScope(input.scope);
      validateCategoryScope(input.category, scope);
      const initialFact = stableFact(input.fact, this.#limits.maximumFactBytes);
      const initialSource = normalizeSource(input.source, this.#limits);
      const secretDecision: SecretPolicyDecision = await this.#secretPolicy({
        fact: initialFact,
        source: initialSource,
      });
      if (secretDecision.action === "reject")
        throw new MemoryPolicyError("secret", secretDecision.reason);
      const fact = stableFact(
        secretDecision.fact,
        this.#limits.maximumFactBytes,
      );
      const source = normalizeSource(secretDecision.source, this.#limits);
      const confidence = clampConfidence(input.confidence);
      const now = Math.max(0, Math.floor(this.#clock()));
      const expiresAtMs =
        now + retentionDays(input.retentionDays, this.#limits) * DAY_MS;
      return this.#persistence.update((serializedDocument) => {
        const document = parseDocument(serializedDocument, this.#limits, now);
        const retained = document.records.filter(
          (record) => record.expiresAtMs > now && record.status === "active",
        );
        const expiredRemoved = document.records.length - retained.length;
        const key = dedupKey({ category: input.category, scope, fact });
        const duplicateIndex = retained.findIndex(
          (record) => dedupKey(record) === key,
        );
        let record: MemoryRecord;
        let created = false;
        if (duplicateIndex >= 0) {
          const existing = retained[duplicateIndex] as MemoryRecord;
          record = freezeRecord({
            ...existing,
            fact,
            sources: mergeSources(
              [[source], existing.sources],
              this.#limits.maximumSourcesPerRecord,
            ),
            updatedAtMs: now,
            lastConfirmedAtMs: now,
            expiresAtMs: Math.max(existing.expiresAtMs, expiresAtMs),
            confidence: Math.max(existing.confidence, confidence),
            status: "active",
          });
          retained[duplicateIndex] = record;
        } else {
          const id = this.#idGenerator();
          if (!ID_PATTERN.test(id))
            throw new MemoryPolicyError(
              "id",
              "idGenerator returned an unsafe memory id",
            );
          if (retained.some((item) => item.id === id))
            throw new MemoryPolicyError(
              "id",
              `Duplicate generated memory id: ${id}`,
            );
          record = freezeRecord({
            schemaVersion: MEMORY_SCHEMA_VERSION,
            id,
            category: input.category,
            scope,
            fact,
            sources: Object.freeze([source]),
            createdAtMs: now,
            updatedAtMs: now,
            lastConfirmedAtMs: now,
            expiresAtMs,
            confidence,
            status: "active",
          });
          retained.push(record);
          created = true;
        }
        retained.sort(
          (left, right) =>
            left.createdAtMs - right.createdAtMs ||
            left.id.localeCompare(right.id),
        );
        return Object.freeze({
          serializedDocument: serializeDocument(retained, now, this.#limits),
          result: Object.freeze({
            record,
            created,
            deduplicated: !created,
            expiredRemoved,
            redactionCount: secretDecision.redactionCount,
          }),
        });
      });
    });
  }

  async search(input: SearchMemoryInput = {}): Promise<SearchMemoryResult> {
    const now = Math.max(0, Math.floor(this.#clock()));
    const document = await this.#load(now);
    const scope = input.scope ?? "all";
    const project = normalizeSearchProject(scope, input.project);
    if (input.category !== undefined && !categoryIs(input.category)) {
      throw new MemoryPolicyError(
        "category",
        "Unsupported stable memory category",
      );
    }
    const query = input.query?.trim() ?? "";
    const ranked: MemorySearchMatch[] = document.records
      .filter(
        (record) => record.status === "active" && record.expiresAtMs > now,
      )
      .filter((record) => eligible(record, scope, project))
      .filter(
        (record) =>
          input.category === undefined || record.category === input.category,
      )
      .map((record) =>
        Object.freeze({ record, score: scoreRecord(record, query) }),
      )
      .filter((match) => query.length === 0 || match.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.record.lastConfirmedAtMs - left.record.lastConfirmedAtMs ||
          left.record.id.localeCompare(right.record.id),
      );
    const resultLimit = selectedMaximum(
      input.limit,
      this.#limits.defaultSearchResults,
      this.#limits.maximumSearchResults,
    );
    const maximumBytes = selectedMaximum(
      input.maxBytes,
      this.#limits.defaultRecallBytes,
      this.#limits.maximumRecallBytes,
    );
    const selected: MemorySearchMatch[] = [];
    let returnedBytes = 2;
    for (const match of ranked) {
      if (selected.length >= resultLimit) break;
      const addition =
        byteLength(JSON.stringify(match)) + (selected.length === 0 ? 0 : 1);
      if (returnedBytes + addition > maximumBytes) break;
      selected.push(match);
      returnedBytes += addition;
    }
    return Object.freeze({
      matches: Object.freeze(selected),
      matched: ranked.length,
      limited: ranked.length > selected.length,
      returnedBytes,
      maximumBytes,
    });
  }

  async forget(input: ForgetMemoryInput): Promise<ForgetMemoryResult> {
    return this.#serialized(async () => {
      if (typeof input.id !== "string" || !ID_PATTERN.test(input.id))
        throw new MemoryPolicyError("id", "Invalid memory id");
      const now = Math.max(0, Math.floor(this.#clock()));
      const project =
        input.project === undefined
          ? undefined
          : normalizeProject(input.project);
      return this.#persistence.update<ForgetMemoryResult>(
        (serializedDocument) => {
          const document = parseDocument(serializedDocument, this.#limits, now);
          const index = document.records.findIndex(
            (record) =>
              record.id === input.id &&
              (record.scope.kind === "global" ||
                record.scope.project === project),
          );
          if (index < 0)
            return Object.freeze({
              result: Object.freeze({ forgotten: false, id: input.id }),
            });
          const records = [
            ...document.records.slice(0, index),
            ...document.records.slice(index + 1),
          ];
          return Object.freeze({
            serializedDocument: serializeDocument(records, now, this.#limits),
            result: Object.freeze({ forgotten: true, id: input.id }),
          });
        },
      );
    });
  }

  async consolidate(
    input: ConsolidateMemoryInput = {},
  ): Promise<ConsolidateMemoryResult> {
    return this.#serialized(async () => {
      const now = Math.max(0, Math.floor(this.#clock()));
      return this.#persistence.update((serializedDocument) => {
        const document = parseDocument(serializedDocument, this.#limits, now);
        const consolidated = consolidateSelected(
          document.records,
          input,
          now,
          this.#limits,
        );
        return Object.freeze({
          serializedDocument: serializeDocument(
            consolidated.records,
            now,
            this.#limits,
          ),
          result: Object.freeze({
            before: document.records.length,
            after: consolidated.records.length,
            duplicatesMerged: consolidated.duplicatesMerged,
            expiredRemoved: consolidated.expiredRemoved,
          }),
        });
      });
    });
  }
}

export function createContextMemory(
  options: ContextMemoryOptions,
): ContextMemory {
  return new FileContextMemory(options);
}
