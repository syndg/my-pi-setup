import type { CodeModeContent, CodeModeMcpResult } from "../types.ts";
import { redactSecrets, redactSecretTokens } from "./permissions.ts";

export const MAX_MCP_RESULT_BYTES = 5 * 1024 * 1024;
export const MAX_INTERMEDIATE_MCP_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_CONTENT_BLOCKS = 1_000;
const MAX_MCP_STRUCTURED_CONTENT_DEPTH = 100;

export type NormalizeMcpResultOptions = {
  maxResultBytes?: number;
  remainingBytes?: number;
  maxContentBlocks?: number;
  budget?: McpOutputBudget;
};

export class McpOutputLimitError extends Error {
  readonly code = "MCP_OUTPUT_LIMIT";
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`MCP output exceeded the ${maxBytes}-byte limit`);
    this.name = "McpOutputLimitError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class McpOutputBudget {
  readonly maxBytes: number;
  readonly maxResultBytes: number;
  #usedBytes = 0;

  constructor(
    maxBytes = MAX_INTERMEDIATE_MCP_BYTES,
    maxResultBytes = MAX_MCP_RESULT_BYTES,
  ) {
    this.maxBytes = positiveInteger(maxBytes) ?? MAX_INTERMEDIATE_MCP_BYTES;
    this.maxResultBytes =
      positiveInteger(maxResultBytes) ?? MAX_MCP_RESULT_BYTES;
  }

  get usedBytes() {
    return this.#usedBytes;
  }

  get remainingBytes() {
    return Math.max(0, this.maxBytes - this.#usedBytes);
  }

  check(value: unknown) {
    const bytes = serializedByteLength(value);
    if (bytes > this.maxResultBytes) {
      throw new McpOutputLimitError(bytes, this.maxResultBytes);
    }
    if (bytes > this.remainingBytes) {
      throw new McpOutputLimitError(this.#usedBytes + bytes, this.maxBytes);
    }
    return bytes;
  }

  consume(value: unknown) {
    const bytes = this.check(value);
    this.#usedBytes += bytes;
    return bytes;
  }
}

export const IntermediateOutputBudget = McpOutputBudget;

export function normalizeMcpResult(
  result: unknown,
  options: NormalizeMcpResultOptions = {},
): CodeModeMcpResult {
  if (!isRecord(result)) throw new TypeError("Invalid MCP tool result");
  if (result.content !== undefined && !Array.isArray(result.content)) {
    throw new TypeError("Invalid MCP tool result content");
  }

  const maxResultBytes =
    positiveInteger(options.maxResultBytes) ?? MAX_MCP_RESULT_BYTES;
  const remainingBytes =
    options.remainingBytes === undefined
      ? maxResultBytes
      : (nonNegativeInteger(options.remainingBytes) ?? maxResultBytes);
  const effectiveLimit = Math.min(maxResultBytes, remainingBytes);
  const budgetLimit = options.budget
    ? Math.min(options.budget.maxResultBytes, options.budget.remainingBytes)
    : maxResultBytes;
  const structuredContentLimit = Math.min(effectiveLimit, budgetLimit);
  guardMcpResultBytes(result, effectiveLimit);
  options.budget?.check(result);

  const contentInput = Array.isArray(result.content) ? result.content : [];
  const maxBlocks =
    positiveInteger(options.maxContentBlocks) ?? MAX_MCP_CONTENT_BLOCKS;
  const content = contentInput.slice(0, maxBlocks).map(normalizeContentBlock);
  if (contentInput.length > maxBlocks) {
    content.push({
      type: "text",
      text: `[${contentInput.length - maxBlocks} MCP content blocks omitted]`,
    });
  }

  const isError = result.isError === true;
  const structuredContent = Object.hasOwn(result, "structuredContent")
    ? redactSecrets(result.structuredContent, {
        maxDepth: MAX_MCP_STRUCTURED_CONTENT_DEPTH,
        maxProperties: structuredContentLimit,
        maxStringBytes: structuredContentLimit,
        limitBehavior: "throw",
      })
    : undefined;
  const normalized: CodeModeMcpResult = {
    ok: !isError,
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(isError
      ? {
          error: {
            code: "MCP_TOOL_ERROR",
            message: errorMessage(content),
          },
        }
      : {}),
  };

  guardMcpResultBytes(normalized, effectiveLimit);
  options.budget?.consume(normalized);
  return normalized;
}

export const normalizeMcpContent = normalizeMcpResult;

export function guardMcpResultBytes(
  value: unknown,
  maxBytes = MAX_MCP_RESULT_BYTES,
) {
  const safeLimit = nonNegativeInteger(maxBytes) ?? MAX_MCP_RESULT_BYTES;
  const bytes = serializedByteLength(value);
  if (bytes > safeLimit) throw new McpOutputLimitError(bytes, safeLimit);
  return bytes;
}

export function serializedByteLength(value: unknown) {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized =
      JSON.stringify(value, (_key, current: unknown) => {
        if (typeof current === "bigint") return current.toString();
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }
        return current;
      }) ?? "";
  } catch {
    serialized = String(value);
  }
  return Buffer.byteLength(serialized, "utf8");
}

function normalizeContentBlock(value: unknown): CodeModeContent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return unsupportedContent("malformed");
  }

  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: redactSecretTokens(value.text) };
  }

  if (value.type === "image" && typeof value.data === "string") {
    const mediaType =
      typeof value.mimeType === "string" && value.mimeType.trim()
        ? value.mimeType.trim().slice(0, 100)
        : "application/octet-stream";
    return { type: "image", mediaType, data: value.data };
  }

  if (value.type === "resource") {
    const resource = isRecord(value.resource) ? value.resource : value;
    if (typeof resource.uri === "string") {
      return {
        type: "resource",
        uri: redactSecretTokens(resource.uri),
        ...(typeof resource.text === "string"
          ? { text: redactSecretTokens(resource.text) }
          : {}),
      };
    }
  }

  if (value.type === "resource_link" && typeof value.uri === "string") {
    return { type: "resource", uri: redactSecretTokens(value.uri) };
  }

  return unsupportedContent(value.type);
}

function unsupportedContent(type: string): CodeModeContent {
  const safeType =
    type.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
  return {
    type: "text",
    text: `[Unsupported MCP content omitted: ${safeType}]`,
  };
}

function errorMessage(content: CodeModeContent[]) {
  const text = content.find((block) => block.type === "text")?.text;
  if (!text) return "MCP tool reported an error";
  return truncateUtf8(text, 1_024);
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > target) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
