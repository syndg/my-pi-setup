import { normalizeCheckpoint } from "./normalize.ts";
import {
  CHECKPOINT_LIMITS,
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointIssueCode,
  type CheckpointValidation,
  type CheckpointValidationIssue,
  type ContextCheckpoint,
} from "./types.ts";

const TOP_LEVEL_REQUIRED = [
  "schemaVersion",
  "goal",
  "constraintsAndPreferences",
  "completedWork",
  "workingSet",
  "decisions",
  "changedFiles",
  "testsAndOutcomes",
  "unresolvedQuestions",
  "blockers",
  "nextActions",
  "criticalReferences",
  "contextPolicyState",
] as const;

const TOP_LEVEL_OPTIONAL = ["originalSession"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function addIssue(
  issues: CheckpointValidationIssue[],
  path: string,
  code: CheckpointIssueCode,
  message: string,
) {
  issues.push({ path, code, message });
}

function inspectRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  issues: CheckpointValidationIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, path, "type", `Replace ${path} with a JSON object.`);
    return undefined;
  }

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      addIssue(
        issues,
        `${path}.${key}`,
        "required",
        `Add the required \"${key}\" section at ${path}.${key}. Use an empty array when the section has no entries.`,
      );
    }
  }

  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      addIssue(
        issues,
        `${path}.${key}`,
        "unknown-field",
        `Remove unsupported field ${path}.${key} or migrate it into a documented checkpoint section.`,
      );
    }
  }
  return value;
}

function inspectString(
  value: unknown,
  path: string,
  maxBytes: number,
  issues: CheckpointValidationIssue[],
) {
  if (typeof value !== "string") {
    addIssue(issues, path, "type", `Set ${path} to a string.`);
    return;
  }
  if (!value.trim()) {
    addIssue(
      issues,
      path,
      "empty",
      `Provide non-empty text at ${path}; do not use whitespace as a placeholder.`,
    );
  }
  const bytes = byteLength(value);
  if (bytes > maxBytes) {
    addIssue(
      issues,
      path,
      "too-long",
      `Shorten ${path} from ${bytes} to at most ${maxBytes} UTF-8 bytes and move full detail to an artifact reference.`,
    );
  }
}

function inspectOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  maxBytes: number,
  issues: CheckpointValidationIssue[],
) {
  if (Object.hasOwn(record, key)) {
    inspectString(record[key], `${path}.${key}`, maxBytes, issues);
  }
}

function inspectStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxBytes: number,
  issues: CheckpointValidationIssue[],
) {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "type",
      `Set ${path} to an array of strings; use [] when there are no entries.`,
    );
    return;
  }
  if (value.length > maxItems) {
    addIssue(
      issues,
      path,
      "too-many",
      `Reduce ${path} from ${value.length} to at most ${maxItems} entries and preserve overflow detail in an artifact.`,
    );
  }
  value.forEach((item, index) =>
    inspectString(item, `${path}[${index}]`, maxBytes, issues),
  );
}

function inspectEnum(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: CheckpointValidationIssue[],
) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    addIssue(
      issues,
      path,
      "invalid-value",
      `Set ${path} to one of: ${allowed.join(", ")}.`,
    );
  }
}

function inspectNullableNumber(
  value: unknown,
  path: string,
  options: { readonly nonNegative?: boolean },
  issues: CheckpointValidationIssue[],
) {
  if (value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.nonNegative && value < 0)
  ) {
    addIssue(
      issues,
      path,
      "invalid-value",
      `Set ${path} to ${options.nonNegative ? "a non-negative finite number" : "a finite number"} or null when unknown.`,
    );
  }
}

function inspectDecisions(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "type",
      `Set ${path} to an array; use [] when empty.`,
    );
    return;
  }
  if (value.length > CHECKPOINT_LIMITS.maxSectionItems) {
    addIssue(
      issues,
      path,
      "too-many",
      `Reduce ${path} to at most ${CHECKPOINT_LIMITS.maxSectionItems} entries.`,
    );
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = inspectRecord(
      item,
      itemPath,
      ["decision", "rationale"],
      [],
      issues,
    );
    if (!record) return;
    if (Object.hasOwn(record, "decision")) {
      inspectString(
        record.decision,
        `${itemPath}.decision`,
        CHECKPOINT_LIMITS.itemBytes,
        issues,
      );
    }
    if (Object.hasOwn(record, "rationale")) {
      inspectString(
        record.rationale,
        `${itemPath}.rationale`,
        CHECKPOINT_LIMITS.rationaleBytes,
        issues,
      );
    }
  });
}

function inspectChangedFiles(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "type",
      `Set ${path} to an array; use [] when no files changed.`,
    );
    return;
  }
  if (value.length > CHECKPOINT_LIMITS.maxChangedFiles) {
    addIssue(
      issues,
      path,
      "too-many",
      `Reduce ${path} to at most ${CHECKPOINT_LIMITS.maxChangedFiles} entries.`,
    );
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = inspectRecord(
      item,
      itemPath,
      ["path", "status"],
      ["summary"],
      issues,
    );
    if (!record) return;
    if (Object.hasOwn(record, "path")) {
      inspectString(
        record.path,
        `${itemPath}.path`,
        CHECKPOINT_LIMITS.pathBytes,
        issues,
      );
    }
    if (Object.hasOwn(record, "status")) {
      inspectEnum(
        record.status,
        `${itemPath}.status`,
        ["created", "modified", "deleted", "renamed"],
        issues,
      );
    }
    inspectOptionalString(
      record,
      "summary",
      itemPath,
      CHECKPOINT_LIMITS.itemBytes,
      issues,
    );
  });
}

function inspectTests(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "type",
      `Set ${path} to an array; use [] when no tests ran.`,
    );
    return;
  }
  if (value.length > CHECKPOINT_LIMITS.maxSectionItems) {
    addIssue(
      issues,
      path,
      "too-many",
      `Reduce ${path} to at most ${CHECKPOINT_LIMITS.maxSectionItems} entries.`,
    );
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = inspectRecord(
      item,
      itemPath,
      ["command", "status", "outcome"],
      [],
      issues,
    );
    if (!record) return;
    if (Object.hasOwn(record, "command")) {
      inspectString(
        record.command,
        `${itemPath}.command`,
        CHECKPOINT_LIMITS.itemBytes,
        issues,
      );
    }
    if (Object.hasOwn(record, "status")) {
      inspectEnum(
        record.status,
        `${itemPath}.status`,
        ["passed", "failed", "partial", "not-run"],
        issues,
      );
    }
    if (Object.hasOwn(record, "outcome")) {
      inspectString(
        record.outcome,
        `${itemPath}.outcome`,
        CHECKPOINT_LIMITS.itemBytes,
        issues,
      );
    }
  });
}

function inspectReferences(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "type",
      `Set ${path} to an array; use [] when there are no references.`,
    );
    return;
  }
  if (value.length > CHECKPOINT_LIMITS.maxCriticalReferences) {
    addIssue(
      issues,
      path,
      "too-many",
      `Reduce ${path} to at most ${CHECKPOINT_LIMITS.maxCriticalReferences} entries; keep only continuation-critical references.`,
    );
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = inspectRecord(
      item,
      itemPath,
      ["kind", "id"],
      ["uri", "label"],
      issues,
    );
    if (!record) return;
    if (Object.hasOwn(record, "kind")) {
      inspectEnum(
        record.kind,
        `${itemPath}.kind`,
        ["session-entry", "artifact"],
        issues,
      );
    }
    if (Object.hasOwn(record, "id")) {
      inspectString(
        record.id,
        `${itemPath}.id`,
        CHECKPOINT_LIMITS.itemBytes,
        issues,
      );
    }
    inspectOptionalString(
      record,
      "uri",
      itemPath,
      CHECKPOINT_LIMITS.referenceLocatorBytes,
      issues,
    );
    inspectOptionalString(
      record,
      "label",
      itemPath,
      CHECKPOINT_LIMITS.itemBytes,
      issues,
    );
  });
}

function inspectPolicy(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  const record = inspectRecord(
    value,
    path,
    [
      "pressure",
      "measurementSource",
      "residentTokens",
      "effectiveWireTokens",
      "safeLimitTokens",
      "headroomTokens",
      "runwayRuns",
      "capturedAtMs",
      "notes",
    ],
    [],
    issues,
  );
  if (!record) return;
  if (Object.hasOwn(record, "pressure")) {
    inspectEnum(
      record.pressure,
      `${path}.pressure`,
      ["green", "yellow", "orange", "red", "emergency", "unknown"],
      issues,
    );
  }
  if (Object.hasOwn(record, "measurementSource")) {
    inspectEnum(
      record.measurementSource,
      `${path}.measurementSource`,
      ["pi-usage", "message-estimate", "unknown"],
      issues,
    );
  }
  for (const key of [
    "residentTokens",
    "effectiveWireTokens",
    "safeLimitTokens",
    "runwayRuns",
  ] as const) {
    if (Object.hasOwn(record, key)) {
      inspectNullableNumber(
        record[key],
        `${path}.${key}`,
        { nonNegative: true },
        issues,
      );
    }
  }
  if (Object.hasOwn(record, "headroomTokens")) {
    inspectNullableNumber(
      record.headroomTokens,
      `${path}.headroomTokens`,
      {},
      issues,
    );
  }
  if (Object.hasOwn(record, "capturedAtMs")) {
    const capturedAtMs = record.capturedAtMs;
    if (
      typeof capturedAtMs !== "number" ||
      !Number.isSafeInteger(capturedAtMs) ||
      capturedAtMs < 0
    ) {
      addIssue(
        issues,
        `${path}.capturedAtMs`,
        "invalid-value",
        `Set ${path}.capturedAtMs to a non-negative safe integer timestamp (0 when unknown).`,
      );
    }
  }
  if (Object.hasOwn(record, "notes")) {
    inspectStringArray(
      record.notes,
      `${path}.notes`,
      CHECKPOINT_LIMITS.maxContextNotes,
      CHECKPOINT_LIMITS.itemBytes,
      issues,
    );
  }
}

function inspectOriginalSession(
  value: unknown,
  path: string,
  issues: CheckpointValidationIssue[],
) {
  const record = inspectRecord(
    value,
    path,
    ["sessionId"],
    ["branchLeafId", "transcriptPath"],
    issues,
  );
  if (!record) return;
  if (Object.hasOwn(record, "sessionId")) {
    inspectString(
      record.sessionId,
      `${path}.sessionId`,
      CHECKPOINT_LIMITS.itemBytes,
      issues,
    );
  }
  inspectOptionalString(
    record,
    "branchLeafId",
    path,
    CHECKPOINT_LIMITS.itemBytes,
    issues,
  );
  inspectOptionalString(
    record,
    "transcriptPath",
    path,
    CHECKPOINT_LIMITS.referenceLocatorBytes,
    issues,
  );
}

function inspectCheckpoint(
  value: unknown,
  issues: CheckpointValidationIssue[],
) {
  const record = inspectRecord(
    value,
    "$",
    TOP_LEVEL_REQUIRED,
    TOP_LEVEL_OPTIONAL,
    issues,
  );
  if (!record) return;

  if (
    Object.hasOwn(record, "schemaVersion") &&
    record.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
  ) {
    addIssue(
      issues,
      "$.schemaVersion",
      "unsupported-version",
      `Set $.schemaVersion to \"${CHECKPOINT_SCHEMA_VERSION}\" or run an explicit migration before validation.`,
    );
  }
  if (Object.hasOwn(record, "goal")) {
    inspectString(record.goal, "$.goal", CHECKPOINT_LIMITS.goalBytes, issues);
  }

  for (const key of [
    "constraintsAndPreferences",
    "completedWork",
    "workingSet",
    "unresolvedQuestions",
    "blockers",
    "nextActions",
  ] as const) {
    if (Object.hasOwn(record, key)) {
      inspectStringArray(
        record[key],
        `$.${key}`,
        CHECKPOINT_LIMITS.maxSectionItems,
        CHECKPOINT_LIMITS.itemBytes,
        issues,
      );
    }
  }
  if (Object.hasOwn(record, "decisions"))
    inspectDecisions(record.decisions, "$.decisions", issues);
  if (Object.hasOwn(record, "changedFiles"))
    inspectChangedFiles(record.changedFiles, "$.changedFiles", issues);
  if (Object.hasOwn(record, "testsAndOutcomes"))
    inspectTests(record.testsAndOutcomes, "$.testsAndOutcomes", issues);
  if (Object.hasOwn(record, "criticalReferences"))
    inspectReferences(
      record.criticalReferences,
      "$.criticalReferences",
      issues,
    );
  if (Object.hasOwn(record, "contextPolicyState"))
    inspectPolicy(record.contextPolicyState, "$.contextPolicyState", issues);
  if (Object.hasOwn(record, "originalSession"))
    inspectOriginalSession(record.originalSession, "$.originalSession", issues);
}

/** Strictly validates exact schema keys and returns a canonical checkpoint on success. */
export function validateCheckpoint(value: unknown): CheckpointValidation {
  const issues: CheckpointValidationIssue[] = [];
  inspectCheckpoint(value, issues);
  if (issues.length > 0) return { ok: false, issues };

  const checkpoint = normalizeCheckpoint(value as ContextCheckpoint);
  const serializedBytes = byteLength(JSON.stringify(checkpoint));
  if (serializedBytes > CHECKPOINT_LIMITS.totalBytes) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          code: "total-size",
          message: `Reduce the checkpoint from ${serializedBytes} to at most ${CHECKPOINT_LIMITS.totalBytes} UTF-8 bytes; move detailed history into critical artifact references.`,
        },
      ],
    };
  }
  return { ok: true, checkpoint, issues: [] };
}

export function parseCheckpoint(serialized: string): CheckpointValidation {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return {
      ok: false,
      issues: [
        {
          path: "$",
          code: "malformed-json",
          message: `Repair the checkpoint JSON before validation.${detail}`,
        },
      ],
    };
  }
  return validateCheckpoint(value);
}

export function formatCheckpointIssues(
  issues: readonly CheckpointValidationIssue[],
) {
  return issues
    .map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`)
    .join("\n");
}

export class CheckpointValidationError extends Error {
  readonly issues: readonly CheckpointValidationIssue[];

  constructor(issues: readonly CheckpointValidationIssue[]) {
    super(`Checkpoint validation failed:\n${formatCheckpointIssues(issues)}`);
    this.name = "CheckpointValidationError";
    this.issues = issues;
  }
}
