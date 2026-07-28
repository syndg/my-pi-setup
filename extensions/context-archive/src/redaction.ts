import type {
  JsonObject,
  JsonValue,
  RedactionResult,
  Redactor,
} from "./types.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:api.?key|access.?token|authorization|credential|password|passwd|private.?key|secret|token)/i;

const CONTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|access[_-]?token|password|passwd|secret|token)\s*[:=]\s*)(["']?)[^\s,"']+\2/gi,
];

function redactText(value: string): { value: string; count: number } {
  let result = value;
  let count = 0;
  for (const pattern of CONTENT_PATTERNS) {
    result = result.replace(pattern, (match: string, prefix?: string) => {
      count += 1;
      if (typeof prefix === "string" && prefix.length > 0) {
        return `${prefix}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return { value: result, count };
}

function redactJson(
  value: JsonValue,
  key = "",
): { value: JsonValue; count: number } {
  if (SENSITIVE_KEY.test(key) && value !== null) {
    return { value: REDACTED, count: 1 };
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    let count = 0;
    const redacted = value.map((item) => {
      const result = redactJson(item);
      count += result.count;
      return result.value;
    });
    return { value: redacted, count };
  }
  if (typeof value === "object" && value !== null) {
    let count = 0;
    const entries = Object.entries(value).map(([childKey, childValue]) => {
      const result = redactJson(childValue, childKey);
      count += result.count;
      return [childKey, result.value] as const;
    });
    return { value: Object.fromEntries(entries), count };
  }
  return { value, count: 0 };
}

/** Conservative built-in redactor. Callers may inject a domain-specific seam. */
export const redactCommonSecrets: Redactor = ({ content, metadata }) => {
  const contentResult = redactText(content);
  const metadataResult = redactJson(metadata);
  return {
    content: contentResult.value,
    metadata: metadataResult.value as JsonObject,
    redactionCount: contentResult.count + metadataResult.count,
  } satisfies RedactionResult;
};

export const identityRedactor: Redactor = ({ content, metadata }) => ({
  content,
  metadata,
  redactionCount: 0,
});
