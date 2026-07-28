import { normalizeCheckpointText } from "./normalize.ts";
import {
  CHECKPOINT_LIMITS,
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointChangedFile,
  type CheckpointCriticalReference,
  type CheckpointMergeInput,
  type CheckpointValidation,
  type CheckpointValidationIssue,
  type ContextCheckpoint,
  type RunRecapInput,
} from "./types.ts";
import {
  CheckpointValidationError,
  parseCheckpoint,
  validateCheckpoint,
} from "./validation.ts";

const EMPTY_CONTEXT_POLICY = {
  pressure: "unknown",
  measurementSource: "unknown",
  residentTokens: null,
  effectiveWireTokens: null,
  safeLimitTokens: null,
  headroomTokens: null,
  runwayRuns: null,
  capturedAtMs: 0,
  notes: [],
} as const;

function previousPath(path: string) {
  return path === "$" ? "$.previous" : `$.previous${path.slice(1)}`;
}

function previousIssues(
  issues: readonly CheckpointValidationIssue[],
): readonly CheckpointValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path: previousPath(issue.path),
    message: `Repair the previous checkpoint before merging. ${issue.message}`,
  }));
}

function validateRecaps(
  recaps: readonly RunRecapInput[],
): readonly CheckpointValidationIssue[] {
  const issues: CheckpointValidationIssue[] = [];
  recaps.forEach((recap, index) => {
    const path = `$.recaps[${index}]`;
    if (typeof recap !== "object" || recap === null || Array.isArray(recap)) {
      issues.push({
        path,
        code: "type",
        message: `Set ${path} to an object with string fields \"recap\" and \"next\".`,
      });
      return;
    }
    for (const key of ["recap", "next"] as const) {
      const value: unknown = recap[key];
      if (typeof value !== "string") {
        issues.push({
          path: `${path}.${key}`,
          code: "type",
          message: `Set ${path}.${key} to a string.`,
        });
      } else if (!normalizeCheckpointText(value)) {
        issues.push({
          path: `${path}.${key}`,
          code: "empty",
          message: `Provide non-empty text at ${path}.${key}.`,
        });
      } else if (
        Buffer.byteLength(value, "utf8") > CHECKPOINT_LIMITS.itemBytes
      ) {
        issues.push({
          path: `${path}.${key}`,
          code: "too-long",
          message: `Shorten ${path}.${key} to at most ${CHECKPOINT_LIMITS.itemBytes} UTF-8 bytes before consolidation.`,
        });
      }
    }
  });
  return issues;
}

function latestByKey<T>(values: readonly T[], key: (value: T) => string) {
  const indexes = new Map<string, number>();
  const result: T[] = [];
  for (const value of values) {
    const identity = key(value);
    const existing = indexes.get(identity);
    if (existing === undefined) {
      indexes.set(identity, result.length);
      result.push(value);
    } else {
      result[existing] = value;
    }
  }
  return result;
}

function mergeChangedFiles(
  previous: readonly CheckpointChangedFile[],
  updates: readonly CheckpointChangedFile[],
) {
  return latestByKey([...previous, ...updates], (file) =>
    normalizeCheckpointText(file.path),
  );
}

function mergeReferences(
  previous: readonly CheckpointCriticalReference[],
  updates: readonly CheckpointCriticalReference[],
) {
  return latestByKey(
    [...previous, ...updates],
    (reference) =>
      `${reference.kind}\u0000${normalizeCheckpointText(reference.id)}`,
  );
}

function actionableNext(recap: RunRecapInput) {
  const next = normalizeCheckpointText(recap.next);
  return /^no further action is required[.!]?$/i.test(next) ? undefined : next;
}

/**
 * Consolidates durable prior state, summaries-extension recaps, and current state.
 * Snapshot sections are replaced by current updates; historical sections accumulate.
 */
export function mergeCheckpoint(
  input: CheckpointMergeInput,
): CheckpointValidation {
  let previous: ContextCheckpoint | undefined;
  if (input.previous !== undefined) {
    const validation = validateCheckpoint(input.previous);
    if (!validation.ok) {
      return { ok: false, issues: previousIssues(validation.issues) };
    }
    previous = validation.checkpoint;
  }

  const recaps = input.recaps ?? [];
  const recapIssues = validateRecaps(recaps);
  if (recapIssues.length > 0) return { ok: false, issues: recapIssues };

  const updates = input.updates ?? {};
  const recapWork = recaps.map((recap) => recap.recap);
  const latestRecapNext = [...recaps]
    .reverse()
    .map(actionableNext)
    .find((next) => next !== undefined);

  const candidate: ContextCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    goal: updates.goal ?? previous?.goal ?? "",
    constraintsAndPreferences: [
      ...(previous?.constraintsAndPreferences ?? []),
      ...(updates.constraintsAndPreferences ?? []),
    ],
    completedWork: [
      ...(previous?.completedWork ?? []),
      ...recapWork,
      ...(updates.completedWork ?? []),
    ],
    workingSet: updates.workingSet ?? previous?.workingSet ?? [],
    decisions: [...(previous?.decisions ?? []), ...(updates.decisions ?? [])],
    changedFiles: mergeChangedFiles(
      previous?.changedFiles ?? [],
      updates.changedFiles ?? [],
    ),
    testsAndOutcomes: [
      ...(previous?.testsAndOutcomes ?? []),
      ...(updates.testsAndOutcomes ?? []),
    ],
    unresolvedQuestions:
      updates.unresolvedQuestions ?? previous?.unresolvedQuestions ?? [],
    blockers: updates.blockers ?? previous?.blockers ?? [],
    nextActions:
      updates.nextActions ??
      (latestRecapNext === undefined
        ? (previous?.nextActions ?? [])
        : [latestRecapNext]),
    criticalReferences: mergeReferences(
      previous?.criticalReferences ?? [],
      updates.criticalReferences ?? [],
    ),
    contextPolicyState:
      updates.contextPolicyState ??
      previous?.contextPolicyState ??
      EMPTY_CONTEXT_POLICY,
    ...(updates.originalSession !== undefined
      ? { originalSession: updates.originalSession }
      : previous?.originalSession === undefined
        ? {}
        : { originalSession: previous.originalSession }),
  };

  return validateCheckpoint(candidate);
}

/** Validates, canonicalizes, and emits byte-stable pretty JSON with one final newline. */
export function serializeCheckpoint(value: unknown) {
  const validation = validateCheckpoint(value);
  if (!validation.ok) throw new CheckpointValidationError(validation.issues);
  return `${JSON.stringify(validation.checkpoint, null, 2)}\n`;
}

/** The small external seam used by callers and contract tests. */
export const checkpointCore = Object.freeze({
  validate: validateCheckpoint,
  parse: parseCheckpoint,
  merge: mergeCheckpoint,
  serialize: serializeCheckpoint,
});
