import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  CompactionResult,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { parseCheckpoint } from "../../context-checkpoints/src/index.ts";
import { CHECKPOINT_ENTRY_TYPE } from "../../context-handoff/src/types.ts";
import { createContextCompactionPrototype } from "./engine.ts";
import { messageRole } from "./messages.ts";
import { projectPostCompactionContext } from "./reconstruction.ts";
import type {
  CheckpointSummaryModel,
  CheckpointVerifier,
  CompactionTranscriptEntry,
} from "./types.ts";
import type { ContextCompactionConfig } from "./config.ts";
import { customEnabledForReason } from "./config.ts";

export interface ProductionCompactionAttempt {
  readonly reason: SessionBeforeCompactEvent["reason"];
  readonly entries: readonly CompactionTranscriptEntry[];
  readonly result?: CompactionResult;
  readonly outcome: "custom" | "native-policy" | "native-fallback";
  readonly fallbackCode?: string;
}

function latestPreviousCheckpoint(entries: readonly SessionEntry[]): unknown {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE)
      continue;
    return (entry.data as { checkpoint?: unknown } | undefined)?.checkpoint;
  }
  return undefined;
}

function relevantBranch(entries: readonly SessionEntry[]) {
  let previousCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      previousCompactionIndex = index;
      break;
    }
  }
  if (previousCompactionIndex < 0) return entries;
  const previous = entries[previousCompactionIndex];
  if (previous?.type !== "compaction") return entries;
  const kept = entries.findIndex(
    (entry) => entry.id === previous.firstKeptEntryId,
  );
  return entries.slice(kept >= 0 ? kept : previousCompactionIndex + 1);
}

function transcriptEntries(
  entries: readonly SessionEntry[],
): CompactionTranscriptEntry[] {
  const result: CompactionTranscriptEntry[] = [];
  const ids = new Set<string>();
  for (const entry of relevantBranch(entries)) {
    if (entry.type === "compaction") continue;
    const messages = sessionEntryToContextMessages(entry);
    if (messages.length > 1 || (messages.length === 1 && ids.has(entry.id))) {
      throw new Error(
        "Compaction branch cannot be projected to unique committed entry boundaries.",
      );
    }
    if (messages[0]) {
      ids.add(entry.id);
      result.push({ id: entry.id, message: messages[0] });
    }
  }
  return result;
}

function validBoundaryRole(message: AgentMessage) {
  return [
    "user",
    "assistant",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ].includes(messageRole(message));
}

function validatePreparation(
  event: SessionBeforeCompactEvent,
  entries: readonly CompactionTranscriptEntry[],
) {
  const kept = entries.find(
    (entry) => entry.id === event.preparation.firstKeptEntryId,
  );
  if (!kept || !validBoundaryRole(kept.message)) {
    throw new Error(
      "Pi preparation has no structurally valid committed first-kept boundary.",
    );
  }
  if (
    !Number.isFinite(event.preparation.tokensBefore) ||
    event.preparation.tokensBefore < 0
  ) {
    throw new Error("Pi preparation tokensBefore is invalid.");
  }
  if (
    event.preparation.messagesToSummarize.length === 0 &&
    event.preparation.turnPrefixMessages.length === 0
  ) {
    throw new Error("Pi preparation contains no messages to compact.");
  }
}

export function validateReconstructedCompactionResult(options: {
  readonly entries: readonly CompactionTranscriptEntry[];
  readonly result: CompactionResult;
}) {
  const { result } = options;
  if (typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error("Custom compaction summary is empty.");
  }
  const kept = options.entries.find(
    (entry) => entry.id === result.firstKeptEntryId,
  );
  if (!kept || !validBoundaryRole(kept.message)) {
    throw new Error(
      "Custom compaction firstKeptEntryId is not a valid turn/tool boundary.",
    );
  }
  if (!parseCheckpoint(result.summary).ok) {
    throw new Error(
      "Custom compaction summary is not a valid context checkpoint.",
    );
  }
  projectPostCompactionContext(options.entries, result);
  return result;
}

export function validateProductionCompactionResult(options: {
  readonly event: SessionBeforeCompactEvent;
  readonly entries: readonly CompactionTranscriptEntry[];
  readonly result: CompactionResult;
}) {
  if (options.result.tokensBefore !== options.event.preparation.tokensBefore) {
    throw new Error(
      "Custom compaction tokensBefore diverges from Pi preparation.",
    );
  }
  return validateReconstructedCompactionResult(options);
}

export function createModelCheckpointVerifier(
  model: CheckpointSummaryModel,
  maxOutputTokens: number,
): CheckpointVerifier {
  return {
    async verify(request) {
      const response = await model.summarize({
        systemPrompt:
          'Verify a context checkpoint against bounded source data. Return exactly JSON: {"ok":boolean,"message":string}. Reject unsupported claims, missing continuation-critical state, or malformed boundaries.',
        prompt: `Checkpoint:\n${JSON.stringify(request.checkpoint)}\n\nBounded source:\n${request.serializedInput}`,
        reason: request.reason,
        maxOutputTokens,
        signal: request.signal,
      });
      const parsed: unknown = JSON.parse(response.text);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Verifier output is not an object.");
      }
      const value = parsed as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(",");
      if (
        keys !== "message,ok" ||
        typeof value.ok !== "boolean" ||
        typeof value.message !== "string"
      ) {
        throw new Error("Verifier output does not match the exact contract.");
      }
      return { ok: value.ok, message: value.message, usage: response.usage };
    },
  };
}

export function createProductionCompactionAdapter(options: {
  readonly config: ContextCompactionConfig;
  readonly model: CheckpointSummaryModel;
  readonly verifier?: CheckpointVerifier;
  readonly observe?: (attempt: ProductionCompactionAttempt) => void;
}) {
  const verifier =
    options.verifier ??
    (options.config.verifier.enabled
      ? createModelCheckpointVerifier(
          options.model,
          options.config.verifier.maxOutputTokens,
        )
      : undefined);
  const engine = createContextCompactionPrototype({
    model: options.model,
    verifier,
  });

  return async (event: SessionBeforeCompactEvent) => {
    let entries: readonly CompactionTranscriptEntry[] = [];
    try {
      if (!customEnabledForReason(event.reason, options.config)) {
        options.observe?.({
          reason: event.reason,
          entries,
          outcome: "native-policy",
        });
        return undefined;
      }
      if (event.signal.aborted) return undefined;
      entries = transcriptEntries(event.branchEntries);
      validatePreparation(event, entries);
      const decision = await engine.compact({
        reason: event.reason,
        entries,
        tokensBefore: event.preparation.tokensBefore,
        previousSummary: event.preparation.previousSummary,
        previousCheckpoint: latestPreviousCheckpoint(event.branchEntries),
        customInstructions: event.customInstructions,
        boundary: options.config.retainedBoundary,
        maxOutputTokens: options.config.maxOutputTokens,
        signal: event.signal,
        reasonPolicy: {
          manual: { action: "custom", onFailure: "native" },
          threshold: { action: "custom", onFailure: "native" },
          overflow: { action: "custom", onFailure: "native" },
        },
      });
      if (event.signal.aborted || decision.kind !== "custom") {
        options.observe?.({
          reason: event.reason,
          entries,
          outcome: "native-fallback",
          ...(decision.kind === "native-fallback"
            ? { fallbackCode: decision.code }
            : {}),
        });
        return undefined;
      }
      const result = validateProductionCompactionResult({
        event,
        entries,
        result: decision.result,
      });
      options.observe?.({
        reason: event.reason,
        entries,
        result,
        outcome: "custom",
      });
      return { compaction: result };
    } catch {
      options.observe?.({
        reason: event.reason,
        entries,
        outcome: "native-fallback",
        fallbackCode: "adapter-error",
      });
      return undefined;
    }
  };
}
