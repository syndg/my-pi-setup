import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  checkpointCore,
  formatCheckpointIssues,
  type CheckpointChangedFile,
  type CheckpointContextPolicyState,
  type CheckpointCriticalReference,
  type CheckpointTestOutcome,
  type ContextCheckpoint,
  type RunRecapInput,
} from "../../context-checkpoints/src/index.ts";
import {
  CHECKPOINT_ENTRY_TYPE,
  type CheckpointRecord,
  type CheckpointRequest,
  type PreparedCheckpoint,
  type SessionEvidence,
} from "./types.ts";

const MAX_RECENT_RECAPS = 8;
const MAX_WORKING_SET = 12;
const MAX_REFERENCES = 16;
const MAX_TEXT = 4_000;

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function bounded(value: string): string {
  const clean = value.trim();
  return clean.length <= MAX_TEXT
    ? clean
    : `${clean.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

function firstUserGoal(entries: readonly SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const text = textContent(entry.message.content);
      if (text) return bounded(text);
    }
  }
  return "";
}

function recaps(entries: readonly SessionEntry[]): RunRecapInput[] {
  return entries
    .flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== "summary-recap")
        return [];
      const data = entry.data as
        { recap?: unknown; next?: unknown } | undefined;
      return typeof data?.recap === "string" && typeof data.next === "string"
        ? [{ recap: bounded(data.recap), next: bounded(data.next) }]
        : [];
    })
    .slice(-MAX_RECENT_RECAPS);
}

function latestCheckpoint(
  entries: readonly SessionEntry[],
): ContextCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE)
      continue;
    const candidate = (entry.data as { checkpoint?: unknown } | undefined)
      ?.checkpoint;
    const validation = checkpointCore.validate(candidate);
    if (validation.ok) return validation.checkpoint;
  }
  return undefined;
}

function toolEvidence(entries: readonly SessionEntry[]) {
  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  const changed = new Map<string, CheckpointChangedFile>();
  const working = new Set<string>();
  const tests: CheckpointTestOutcome[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type !== "toolCall") continue;
        const args = block.arguments as Record<string, unknown>;
        calls.set(block.id, { name: block.name, args });
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (path) {
          working.add(path);
          if (block.name === "edit" || block.name === "write") {
            changed.set(path, {
              path,
              status: block.name === "write" ? "created" : "modified",
            });
          }
        }
      }
    } else if (entry.message.role === "toolResult") {
      const call = calls.get(entry.message.toolCallId);
      if (call?.name === "bash" && typeof call.args.command === "string") {
        tests.push({
          command: bounded(call.args.command),
          status: entry.message.isError ? "failed" : "passed",
          outcome: bounded(
            textContent(entry.message.content) ||
              (entry.message.isError
                ? "Command failed."
                : "Command completed."),
          ),
        });
      }
    }
  }
  return {
    changedFiles: [...changed.values()],
    workingSet: [...working].slice(-MAX_WORKING_SET),
    testsAndOutcomes: tests.slice(-20),
  };
}

function artifactReferences(
  value: unknown,
  found: Map<string, CheckpointCriticalReference>,
  depth = 0,
): void {
  if (depth > 5 || found.size >= MAX_REFERENCES || value === null) return;
  if (typeof value === "string") {
    const uri = value.match(
      /context:\/\/[a-f0-9]{24}\/[a-z0-9][a-z0-9_-]{0,79}/i,
    )?.[0];
    if (uri)
      found.set(uri, {
        kind: "artifact",
        id: uri.split("/").at(-1) as string,
        uri,
      });
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40))
      artifactReferences(item, found, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["fullOutputPath", "fullResultPath"] as const) {
    const path = record[key];
    if (typeof path === "string" && path.trim()) {
      const locator = path.trim().slice(0, MAX_TEXT);
      found.set(locator, {
        kind: "artifact",
        id: locator,
        uri: locator,
        label: "Existing spilled tool output",
      });
    }
  }
  const id = typeof record.id === "string" ? record.id : undefined;
  const uri =
    typeof record.uri === "string" && record.uri.startsWith("context://")
      ? record.uri
      : undefined;
  if (id && uri) found.set(id, { kind: "artifact", id, uri });
  for (const child of Object.values(record).slice(0, 40))
    artifactReferences(child, found, depth + 1);
}

function references(evidence: SessionEvidence): CheckpointCriticalReference[] {
  const found = new Map<string, CheckpointCriticalReference>();
  const important = [evidence.entries[0], evidence.entries.at(-1)].filter(
    (entry): entry is SessionEntry => entry !== undefined,
  );
  for (const entry of important)
    found.set(entry.id, { kind: "session-entry", id: entry.id });
  for (const entry of evidence.entries.slice(-100)) {
    if (entry.type === "message" && entry.message.role === "toolResult")
      artifactReferences(entry.message.details, found);
  }
  return [...found.values()].slice(0, MAX_REFERENCES);
}

export function unknownPolicy(
  capturedAtMs: number,
): CheckpointContextPolicyState {
  return {
    pressure: "unknown",
    measurementSource: "unknown",
    residentTokens: null,
    effectiveWireTokens: null,
    safeLimitTokens: null,
    headroomTokens: null,
    runwayRuns: null,
    capturedAtMs,
    notes: ["Governor state was unavailable; values were not inferred."],
  };
}

export function prepareDeterministicCheckpoint(
  request: CheckpointRequest,
): PreparedCheckpoint {
  const previous = latestCheckpoint(request.evidence.entries);
  const tools = toolEvidence(request.evidence.entries);
  const exactNext = request.exactNextAction?.trim();
  const merged = checkpointCore.merge({
    previous,
    recaps: recaps(request.evidence.entries),
    updates: {
      goal:
        request.goal?.trim() ||
        previous?.goal ||
        firstUserGoal(request.evidence.entries),
      workingSet: tools.workingSet,
      changedFiles: tools.changedFiles,
      testsAndOutcomes: tools.testsAndOutcomes,
      ...(exactNext ? { nextActions: [exactNext] } : {}),
      criticalReferences: references(request.evidence),
      contextPolicyState:
        request.governorState ?? unknownPolicy(request.evidence.capturedAtMs),
      originalSession: {
        sessionId: request.evidence.sessionId,
        ...(request.evidence.leafId
          ? { branchLeafId: request.evidence.leafId }
          : {}),
        ...(request.evidence.sessionFile
          ? { transcriptPath: request.evidence.sessionFile }
          : {}),
      },
    },
  });
  if (!merged.ok)
    throw new Error(
      `Checkpoint evidence is incomplete:\n${formatCheckpointIssues(merged.issues)}`,
    );
  if (merged.checkpoint.nextActions.length === 0) {
    throw new Error(
      "Checkpoint evidence is incomplete: an exact next action is required.",
    );
  }
  const serialized = checkpointCore.serialize(merged.checkpoint);
  const checkpointId = `cp-${createHash("sha256")
    .update(request.evidence.sessionId)
    .update("\0")
    .update(request.evidence.leafId ?? "root")
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 20)}`;
  const record: CheckpointRecord = {
    version: 1,
    checkpointId,
    createdAtMs: request.evidence.capturedAtMs,
    sourceSessionId: request.evidence.sessionId,
    sourceLeafId: request.evidence.leafId,
    artifactPath: "",
    checkpoint: merged.checkpoint,
  };
  return { record, serialized };
}
