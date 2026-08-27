import { CODE_MODE_LIMITS } from "./limits.ts";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const TRUNCATION_SUFFIX = "\n… [truncated]";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function truncateUtf8(value: string, maxBytes: number) {
  if (byteLength(value) <= maxBytes) return value;

  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  if (maxBytes <= suffixBytes) {
    let content = Buffer.from(value, "utf8")
      .subarray(0, maxBytes)
      .toString("utf8");
    while (byteLength(content) > maxBytes) {
      content = content.slice(0, -1);
    }
    return content;
  }

  const contentBytes = maxBytes - suffixBytes;
  let content = Buffer.from(value, "utf8")
    .subarray(0, contentBytes)
    .toString("utf8");

  while (byteLength(content) > contentBytes) {
    content = content.slice(0, -1);
  }

  return content + TRUNCATION_SUFFIX;
}

export function parseProgramResult(stdout: string, sentinel: string) {
  const markerIndex = stdout.lastIndexOf(sentinel);
  if (markerIndex === -1) {
    return {
      found: false as const,
      stdout: truncateUtf8(stdout, CODE_MODE_LIMITS.maxStdoutBytes),
    };
  }

  if (markerIndex > 0 && stdout[markerIndex - 1] !== "\n") {
    throw new Error("Malformed Code Mode return record");
  }

  const payloadStart = markerIndex + sentinel.length;
  const lineEnd = stdout.indexOf("\n", payloadStart);
  const payload = stdout.slice(
    payloadStart,
    lineEnd === -1 ? stdout.length : lineEnd,
  );

  if (byteLength(payload) > CODE_MODE_LIMITS.maxReturnBytes) {
    throw new RangeError(
      `Code Mode return value exceeds ${CODE_MODE_LIMITS.maxReturnBytes} bytes`,
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw new Error("Malformed Code Mode return value");
  }

  if (
    !isRecord(envelope) ||
    typeof envelope.hasValue !== "boolean" ||
    (envelope.hasValue && !Object.hasOwn(envelope, "value"))
  ) {
    throw new Error("Malformed Code Mode return envelope");
  }

  const before = stdout.slice(0, markerIndex);
  const after = lineEnd === -1 ? "" : stdout.slice(lineEnd + 1);

  return {
    found: true as const,
    value: envelope.hasValue ? envelope.value : undefined,
    stdout: truncateUtf8(before + after, CODE_MODE_LIMITS.maxStdoutBytes),
  };
}

export function boundStderr(stderr: string) {
  return truncateUtf8(stderr, CODE_MODE_LIMITS.maxStderrBytes);
}
