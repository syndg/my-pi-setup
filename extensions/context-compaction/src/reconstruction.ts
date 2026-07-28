import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { parseCheckpoint } from "../../context-checkpoints/src/index.ts";
import { hasValidToolStructure } from "./boundary.ts";
import type {
  CompactionTranscriptEntry,
  ReconstructedContext,
} from "./types.ts";

/**
 * Models Pi's documented reload assumption: one compaction summary followed by the
 * committed branch suffix beginning at firstKeptEntryId. It performs no persistence.
 */
export function projectPostCompactionContext(
  entries: readonly CompactionTranscriptEntry[],
  result: CompactionResult,
): ReconstructedContext {
  const parsed = parseCheckpoint(result.summary);
  if (!parsed.ok)
    throw new Error("Compaction summary is not a valid context checkpoint.");
  const index = entries.findIndex(
    (entry) => entry.id === result.firstKeptEntryId,
  );
  if (index < 0)
    throw new Error("firstKeptEntryId is absent from the committed branch.");
  const retainedEntries = entries.slice(index);
  if (!hasValidToolStructure(retainedEntries)) {
    throw new Error(
      "Retained suffix would orphan a tool result from its tool call.",
    );
  }
  return {
    summary: parsed.checkpoint,
    firstKeptEntryId: result.firstKeptEntryId,
    retainedEntries,
  };
}
