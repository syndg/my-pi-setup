import { createHash } from "node:crypto";

export interface TextFidelity {
  bom: "" | "\uFEFF";
  lineEnding: "\n" | "\r\n";
}

export interface LogicalText {
  lines: string[];
  finalNewline: boolean;
}

const fatalUtf8 = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export function computeByteIdentity(buffer: Buffer | Uint8Array) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function decodeText(buffer: Buffer) {
  let raw: string;
  try {
    raw = fatalUtf8.decode(buffer);
  } catch (error) {
    throw new Error("File is not valid UTF-8", { cause: error });
  }
  if (raw.includes("\0")) throw new Error("File contains NUL bytes");
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  if (/\r(?!\n)/.test(text)) {
    throw new Error("File contains a bare carriage return");
  }
  const firstLf = text.indexOf("\n");
  const lineEnding =
    firstLf > 0 && text[firstLf - 1] === "\r"
      ? ("\r\n" as const)
      : ("\n" as const);

  return {
    normalized: text.replace(/\r\n/g, "\n"),
    fidelity: { bom, lineEnding } satisfies TextFidelity,
    hasBareCarriageReturn: false,
  };
}

export function encodeText(normalized: string, fidelity: TextFidelity) {
  const restored =
    fidelity.lineEnding === "\r\n"
      ? normalized.replace(/\n/g, "\r\n")
      : normalized;
  return fidelity.bom + restored;
}

/** Counts logical rows without allocating a full-file line array. */
export function countLogicalLines(text: string) {
  if (text === "") return 0;
  let lineCount = text.endsWith("\n") ? 0 : 1;
  let newline = text.indexOf("\n");
  while (newline !== -1) {
    lineCount++;
    newline = text.indexOf("\n", newline + 1);
  }
  return lineCount;
}

export function splitLogicalText(text: string): LogicalText {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), finalNewline };
}

export function joinLogicalText({ lines, finalNewline }: LogicalText) {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}
