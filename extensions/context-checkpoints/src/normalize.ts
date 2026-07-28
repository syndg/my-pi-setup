import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointChangedFile,
  type CheckpointContextPolicyState,
  type CheckpointCriticalReference,
  type CheckpointDecision,
  type CheckpointTestOutcome,
  type ContextCheckpoint,
  type OriginalSessionPointer,
} from "./types.ts";

const ANSI_OR_OSC =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const DISALLOWED_CONTROL =
  // Keep tabs and newlines but remove controls that are unsafe in terminals/artifacts.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function normalizeCheckpointText(value: string) {
  return value
    .replace(ANSI_OR_OSC, "")
    .replace(DISALLOWED_CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trim();
}

function uniqueStrings(values: readonly string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = normalizeCheckpointText(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

function normalizeDecisions(values: readonly CheckpointDecision[]) {
  return uniqueBy(
    values.map((value) => ({
      decision: normalizeCheckpointText(value.decision),
      rationale: normalizeCheckpointText(value.rationale),
    })),
    (value) => `${value.decision}\u0000${value.rationale}`,
  );
}

function normalizeChangedFiles(values: readonly CheckpointChangedFile[]) {
  return uniqueBy(
    values.map((value) => ({
      path: normalizeCheckpointText(value.path),
      status: value.status,
      ...(value.summary === undefined
        ? {}
        : { summary: normalizeCheckpointText(value.summary) }),
    })),
    (value) => value.path,
  );
}

function normalizeTests(values: readonly CheckpointTestOutcome[]) {
  return uniqueBy(
    values.map((value) => ({
      command: normalizeCheckpointText(value.command),
      status: value.status,
      outcome: normalizeCheckpointText(value.outcome),
    })),
    (value) => `${value.command}\u0000${value.status}\u0000${value.outcome}`,
  );
}

function normalizeReferences(values: readonly CheckpointCriticalReference[]) {
  return uniqueBy(
    values.map((value) => ({
      kind: value.kind,
      id: normalizeCheckpointText(value.id),
      ...(value.uri === undefined
        ? {}
        : { uri: normalizeCheckpointText(value.uri) }),
      ...(value.label === undefined
        ? {}
        : { label: normalizeCheckpointText(value.label) }),
    })),
    (value) => `${value.kind}\u0000${value.id}`,
  );
}

function normalizePolicy(
  value: CheckpointContextPolicyState,
): CheckpointContextPolicyState {
  return {
    pressure: value.pressure,
    measurementSource: value.measurementSource,
    residentTokens: value.residentTokens,
    effectiveWireTokens: value.effectiveWireTokens,
    safeLimitTokens: value.safeLimitTokens,
    headroomTokens: value.headroomTokens,
    runwayRuns: value.runwayRuns,
    capturedAtMs: value.capturedAtMs,
    notes: uniqueStrings(value.notes),
  };
}

function normalizeOriginalSession(
  value: OriginalSessionPointer,
): OriginalSessionPointer {
  return {
    sessionId: normalizeCheckpointText(value.sessionId),
    ...(value.branchLeafId === undefined
      ? {}
      : { branchLeafId: normalizeCheckpointText(value.branchLeafId) }),
    ...(value.transcriptPath === undefined
      ? {}
      : { transcriptPath: normalizeCheckpointText(value.transcriptPath) }),
  };
}

/** Canonicalizes text, removes terminal controls, and de-duplicates without reordering. */
export function normalizeCheckpoint(
  checkpoint: ContextCheckpoint,
): ContextCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    goal: normalizeCheckpointText(checkpoint.goal),
    constraintsAndPreferences: uniqueStrings(
      checkpoint.constraintsAndPreferences,
    ),
    completedWork: uniqueStrings(checkpoint.completedWork),
    workingSet: uniqueStrings(checkpoint.workingSet),
    decisions: normalizeDecisions(checkpoint.decisions),
    changedFiles: normalizeChangedFiles(checkpoint.changedFiles),
    testsAndOutcomes: normalizeTests(checkpoint.testsAndOutcomes),
    unresolvedQuestions: uniqueStrings(checkpoint.unresolvedQuestions),
    blockers: uniqueStrings(checkpoint.blockers),
    nextActions: uniqueStrings(checkpoint.nextActions),
    criticalReferences: normalizeReferences(checkpoint.criticalReferences),
    contextPolicyState: normalizePolicy(checkpoint.contextPolicyState),
    ...(checkpoint.originalSession === undefined
      ? {}
      : {
          originalSession: normalizeOriginalSession(checkpoint.originalSession),
        }),
  };
}
