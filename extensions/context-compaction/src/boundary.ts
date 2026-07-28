import {
  estimateEntryTokens,
  isTurnStart,
  messageRole,
  toolCalls,
  toolResultCallId,
} from "./messages.ts";
import {
  DEFAULT_RETAINED_BOUNDARY,
  type BoundarySelection,
  type CompactionTranscriptEntry,
  type RetainedBoundaryConfig,
} from "./types.ts";

export function normalizeBoundaryConfig(
  config: Partial<RetainedBoundaryConfig> = {},
): RetainedBoundaryConfig {
  const merged = { ...DEFAULT_RETAINED_BOUNDARY, ...config };
  if (
    !Number.isFinite(merged.minimumTokens) ||
    !Number.isFinite(merged.targetTokens) ||
    !Number.isFinite(merged.maximumTokens) ||
    merged.minimumTokens < 0 ||
    merged.minimumTokens > merged.targetTokens ||
    merged.targetTokens > merged.maximumTokens
  ) {
    throw new Error(
      "Retained boundary tokens must be finite and ordered minimum <= target <= maximum.",
    );
  }
  return {
    minimumTokens: Math.floor(merged.minimumTokens),
    targetTokens: Math.floor(merged.targetTokens),
    maximumTokens: Math.floor(merged.maximumTokens),
  };
}

/** True when every retained tool result still has its assistant tool call in the retained tail. */
export function hasValidToolStructure(
  entries: readonly CompactionTranscriptEntry[],
): boolean {
  const calls = new Set<string>();
  for (const entry of entries) {
    for (const call of toolCalls(entry.message)) calls.add(call.id);
    const resultId = toolResultCallId(entry.message);
    if (resultId !== undefined && !calls.has(resultId)) return false;
  }
  return true;
}

function candidateDistance(
  tokens: number,
  config: RetainedBoundaryConfig,
): number {
  if (tokens < config.minimumTokens) return config.minimumTokens - tokens;
  if (tokens > config.maximumTokens) return tokens - config.maximumTokens;
  return 0;
}

function findTurnStart(
  entries: readonly CompactionTranscriptEntry[],
  boundaryIndex: number,
  startIndex: number,
): number | null {
  for (let index = boundaryIndex; index >= startIndex; index -= 1) {
    const entry = entries[index];
    if (entry && isTurnStart(entry.message)) return index;
  }
  return null;
}

export function isStructurallyValidBoundaryStart(
  entry: CompactionTranscriptEntry,
) {
  return [
    "user",
    "assistant",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ].includes(messageRole(entry.message));
}

/**
 * Selects the valid committed-entry cut closest to the configured 8–12K-style band.
 * It never starts retained context at a tool result and rejects orphan-result tails.
 */
export function chooseRetainedBoundary(
  entries: readonly CompactionTranscriptEntry[],
  configInput: Partial<RetainedBoundaryConfig> = {},
  summarizeFromEntryId?: string,
): BoundarySelection | undefined {
  const config = normalizeBoundaryConfig(configInput);
  const startIndex = summarizeFromEntryId
    ? entries.findIndex((entry) => entry.id === summarizeFromEntryId)
    : 0;
  if (startIndex < 0 || entries.length < 2) return undefined;

  const suffixTokens = new Array<number>(entries.length + 1).fill(0);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] =
      (suffixTokens[index + 1] ?? 0) + estimateEntryTokens(entries[index]!);
  }

  const candidates: Array<{
    index: number;
    tokens: number;
    distance: number;
    targetDistance: number;
    splitPenalty: number;
  }> = [];
  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!isStructurallyValidBoundaryStart(entry)) continue;
    const retained = entries.slice(index);
    if (!hasValidToolStructure(retained)) continue;
    const tokens = suffixTokens[index] ?? 0;
    candidates.push({
      index,
      tokens,
      distance: candidateDistance(tokens, config),
      targetDistance: Math.abs(tokens - config.targetTokens),
      splitPenalty: isTurnStart(entry.message) ? 0 : 1,
    });
  }
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.targetDistance - right.targetDistance ||
      left.splitPenalty - right.splitPenalty ||
      left.index - right.index,
  );
  const selected = candidates[0];
  if (!selected) return undefined;

  const firstKept = entries[selected.index]!;
  const splitTurn = !isTurnStart(firstKept.message);
  const turnStartIndex = splitTurn
    ? findTurnStart(entries, selected.index, startIndex)
    : null;
  const effectiveSplit = turnStartIndex !== null;
  const historyEnd = effectiveSplit ? turnStartIndex : selected.index;
  const history = entries.slice(startIndex, historyEnd);
  const splitTurnPrefix = effectiveSplit
    ? entries.slice(turnStartIndex, selected.index)
    : [];
  const summarized = entries.slice(startIndex, selected.index);

  return {
    firstKeptEntryId: firstKept.id,
    firstKeptIndex: selected.index,
    retainedEstimatedTokens: selected.tokens,
    summarizedEstimatedTokens: summarized.reduce(
      (total, entry) => total + estimateEntryTokens(entry),
      0,
    ),
    isSplitTurn: effectiveSplit,
    turnStartIndex: effectiveSplit ? turnStartIndex : null,
    history,
    splitTurnPrefix,
    retainedSuffix: entries.slice(selected.index),
  };
}
