const ANSI_PATTERN =
  /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[()[\]#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

/** Removes terminal control sequences while retaining tabs and line breaks. */
export function terminalSafe(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function utf8PrefixWithBytes(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly bytes: number } {
  const limit = Math.max(0, Math.floor(maximumBytes));
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= limit) return { text: value, bytes: buffer.length };

  let end = Math.min(limit, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buffer.subarray(0, end).toString("utf8"), bytes: end };
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  return utf8PrefixWithBytes(value, maximumBytes).text;
}

export function safeBufferSlice(
  buffer: Buffer,
  requestedStart: number,
  maximumBytes: number,
): { readonly buffer: Buffer; readonly start: number; readonly end: number } {
  let start = Math.min(buffer.length, Math.max(0, Math.floor(requestedStart)));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;

  const limit = Math.max(0, Math.floor(maximumBytes));
  let end = Math.min(buffer.length, start + limit);
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { buffer: buffer.subarray(start, end), start, end };
}

export function lineCount(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function conciseLabel(value: string, maximumCharacters = 160): string {
  return terminalSafe(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumCharacters);
}
