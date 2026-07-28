import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SearchMemoryResult } from "./types.ts";

export const MEMORY_SEARCH_TOOL_NAME = "memory_search";
export const EXPIRED_RECALL_PLACEHOLDER =
  "[Cross-session memory recall expired after its one provider turn. Run memory_search explicitly to recall again.]";

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (
    end > 0 &&
    (source[end] as number) >= 0x80 &&
    (source[end] as number) < 0xc0
  )
    end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function appendWithin(
  lines: string[],
  candidate: string,
  maximumBytes: number,
): boolean {
  const prefix = lines.length === 0 ? "" : "\n";
  if (
    utf8Bytes(lines.join("\n")) + utf8Bytes(prefix + candidate) >
    maximumBytes
  )
    return false;
  lines.push(candidate);
  return true;
}

export function formatMemorySearchResult(
  result: SearchMemoryResult,
  maximumBytes = result.maximumBytes,
): string {
  const hardMaximum = Math.max(1, Math.floor(maximumBytes));
  const lines: string[] = [];
  appendWithin(
    lines,
    `Cross-session stable memory recall: ${result.matches.length} returned of ${result.matched} match(es). One provider turn only.`,
    hardMaximum,
  );
  for (const match of result.matches) {
    const record = match.record;
    const scope =
      record.scope.kind === "global"
        ? "global"
        : `project:${record.scope.project}`;
    const sources = record.sources
      .map((source) => `${source.kind}:${source.reference}`)
      .join("; ");
    const line = `- [${record.id}] ${record.category} | ${scope} | confidence ${record.confidence.toFixed(3)} | ${record.fact} | source ${sources}`;
    if (!appendWithin(lines, line, hardMaximum)) break;
  }
  if (result.limited)
    appendWithin(
      lines,
      "[Recall bounded; additional matches omitted.]",
      hardMaximum,
    );
  const text = lines.join("\n");
  return utf8Bytes(text) <= hardMaximum
    ? text
    : truncateUtf8(text, hardMaximum);
}

function contentTextBytes(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): number {
  return message.content.reduce(
    (total, block) =>
      total + (block.type === "text" ? utf8Bytes(block.text) : 0),
    0,
  );
}

function boundedRecallMessage(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  maximumBytes: number,
): Extract<AgentMessage, { role: "toolResult" }> {
  if (contentTextBytes(message) <= maximumBytes) return message;
  const text = message.content
    .filter(
      (
        block,
      ): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  const marker = "\n[Recall truncated to the one-turn aggregate bound.]";
  const bodyMaximum = Math.max(0, maximumBytes - utf8Bytes(marker));
  const bounded = `${truncateUtf8(text, bodyMaximum)}${marker}`;
  return {
    ...message,
    content: [{ type: "text", text: truncateUtf8(bounded, maximumBytes) }],
  };
}

export interface OneTurnRecallGate {
  arm(toolCallId: string): void;
  transform(messages: readonly AgentMessage[]): readonly AgentMessage[];
  reset(): void;
  armedCount(): number;
}

/**
 * Request-time filter for the thin Pi adapter. A newly armed memory_search
 * result survives exactly one `context` event. Every older result keeps its
 * tool-pair position but is replaced with a byte-stable placeholder.
 */
export function createOneTurnRecallGate(
  maximumAggregateBytes = 12 * 1024,
): OneTurnRecallGate {
  const aggregateBound = Math.max(1, Math.floor(maximumAggregateBytes));
  const armed = new Set<string>();
  return Object.freeze({
    arm(toolCallId: string) {
      armed.add(toolCallId);
    },
    transform(messages: readonly AgentMessage[]) {
      let remaining = aggregateBound;
      const consumed = new Set<string>();
      const output = messages.map((message): AgentMessage => {
        if (
          message.role !== "toolResult" ||
          message.toolName !== MEMORY_SEARCH_TOOL_NAME
        )
          return message;
        if (!armed.has(message.toolCallId)) {
          return {
            ...message,
            content: [{ type: "text", text: EXPIRED_RECALL_PLACEHOLDER }],
          };
        }
        consumed.add(message.toolCallId);
        if (remaining <= 0) {
          return {
            ...message,
            content: [
              {
                type: "text",
                text: "[Cross-session memory recall omitted: one-turn aggregate bound reached.]",
              },
            ],
          };
        }
        const bounded = boundedRecallMessage(message, remaining);
        remaining = Math.max(0, remaining - contentTextBytes(bounded));
        return bounded;
      });
      for (const id of consumed) armed.delete(id);
      return Object.freeze(output);
    },
    reset() {
      armed.clear();
    },
    armedCount() {
      return armed.size;
    },
  });
}
