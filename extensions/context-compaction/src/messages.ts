import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionTranscriptEntry } from "./types.ts";

interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function messageRole(message: AgentMessage): string {
  const value = record(message);
  return typeof value?.role === "string" ? value.role : "unknown";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value = record(block);
      if (!value) return "";
      if (value.type === "text" && typeof value.text === "string")
        return value.text;
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return value.thinking;
      }
      if (value.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function messageText(message: AgentMessage): string {
  const value = record(message);
  if (!value) return "";
  const role = messageRole(message);
  if (role === "bashExecution") {
    return `${typeof value.command === "string" ? value.command : ""}\n${typeof value.output === "string" ? value.output : ""}`.trim();
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return typeof value.summary === "string" ? value.summary : "";
  }
  return textFromContent(value.content);
}

export function toolCalls(message: AgentMessage): readonly ToolCallView[] {
  const value = record(message);
  if (!value || !Array.isArray(value.content)) return [];
  const calls: ToolCallView[] = [];
  for (const block of value.content) {
    const item = record(block);
    if (
      item?.type === "toolCall" &&
      typeof item.id === "string" &&
      typeof item.name === "string"
    ) {
      calls.push({ id: item.id, name: item.name, arguments: item.arguments });
    }
  }
  return calls;
}

export function toolResultCallId(message: AgentMessage): string | undefined {
  const value = record(message);
  return messageRole(message) === "toolResult" &&
    typeof value?.toolCallId === "string"
    ? value.toolCallId
    : undefined;
}

export function toolResultName(message: AgentMessage): string | undefined {
  const value = record(message);
  return messageRole(message) === "toolResult" &&
    typeof value?.toolName === "string"
    ? value.toolName
    : undefined;
}

export function isToolResultError(message: AgentMessage): boolean {
  const value = record(message);
  return messageRole(message) === "toolResult" && value?.isError === true;
}

export function isTurnStart(message: AgentMessage): boolean {
  return [
    "user",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ].includes(messageRole(message));
}

function contentCharacters(message: AgentMessage): number {
  const value = record(message);
  if (!value) return 0;
  let characters = messageText(message).length;
  for (const call of toolCalls(message)) {
    characters +=
      call.name.length + JSON.stringify(call.arguments ?? {}).length;
  }
  return characters;
}

export function estimateEntryTokens(entry: CompactionTranscriptEntry): number {
  if (
    typeof entry.estimatedTokens === "number" &&
    Number.isFinite(entry.estimatedTokens) &&
    entry.estimatedTokens >= 0
  ) {
    return Math.ceil(entry.estimatedTokens);
  }
  return Math.ceil(contentCharacters(entry.message) / 4);
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function prefixByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

/** UTF-8-safe head/tail truncation with an explicit, deterministic omission marker. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = "\n[… bounded input omitted …]\n";
  const markerBytes = utf8Bytes(marker);
  if (maxBytes <= markerBytes) return prefixByBytes(marker, maxBytes);
  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available * 0.7);
  const tailBudget = available - headBudget;
  const head = prefixByBytes(value, headBudget);
  const reversedTail = prefixByBytes([...value].reverse().join(""), tailBudget);
  const tail = [...reversedTail].reverse().join("");
  return `${head}${marker}${tail}`;
}

function serializeAssistant(message: AgentMessage): string {
  const value = record(message);
  const content = Array.isArray(value?.content) ? value.content : [];
  const sections: string[] = [];
  const thinking: string[] = [];
  const text: string[] = [];
  for (const block of content) {
    const item = record(block);
    if (item?.type === "thinking" && typeof item.thinking === "string")
      thinking.push(item.thinking);
    if (item?.type === "text" && typeof item.text === "string")
      text.push(item.text);
  }
  if (thinking.length > 0)
    sections.push(`[Assistant thinking]: ${thinking.join("\n")}`);
  if (text.length > 0) sections.push(`[Assistant]: ${text.join("\n")}`);
  const calls = toolCalls(message);
  if (calls.length > 0) {
    sections.push(
      `[Assistant tool calls]: ${calls
        .map(
          (call) =>
            `${call.name}#${call.id}(${JSON.stringify(call.arguments ?? {})})`,
        )
        .join("; ")}`,
    );
  }
  return sections.join("\n");
}

export function serializeMessage(
  message: AgentMessage,
  toolResultBytes: number,
): string {
  const role = messageRole(message);
  if (role === "assistant") return serializeAssistant(message);
  if (role === "toolResult") {
    const name = toolResultName(message) ?? "unknown";
    const id = toolResultCallId(message) ?? "unknown";
    return `[Tool result ${name}#${id}]: ${truncateUtf8(messageText(message), toolResultBytes)}`;
  }
  if (role === "bashExecution")
    return `[Bash execution]: ${messageText(message)}`;
  if (role === "custom") return `[Custom message]: ${messageText(message)}`;
  if (role === "branchSummary")
    return `[Branch summary]: ${messageText(message)}`;
  if (role === "compactionSummary")
    return `[Compaction summary]: ${messageText(message)}`;
  if (role === "user") return `[User]: ${messageText(message)}`;
  return `[${role}]: ${messageText(message)}`;
}

export function serializeEntries(
  entries: readonly CompactionTranscriptEntry[],
  limits: { readonly messageBytes: number; readonly toolResultBytes: number },
): string {
  return entries
    .map(
      (entry) =>
        `[Entry ${entry.id}]\n${truncateUtf8(
          serializeMessage(entry.message, limits.toolResultBytes),
          limits.messageBytes,
        )}`,
    )
    .join("\n\n");
}
