import { HASHLINE_TAG_PATTERN, MAX_OPERATIONS } from "./schema.ts";
import { joinLogicalText, splitLogicalText } from "./text.ts";

export type LineOperation =
  | { op: "replace"; start: number; end: number; lines: string[] }
  | { op: "delete"; start: number; end: number }
  | { op: "insert-before" | "insert-after"; line: number; lines: string[] }
  | { op: "head" | "tail"; lines: string[] };

export interface ParsedEditInput {
  path: string;
  tag: string;
  operations: LineOperation[];
}

const TAG_RE = new RegExp(HASHLINE_TAG_PATTERN);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} has unexpected field(s): ${unexpected.join(", ")}`,
    );
  }
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function destinationLines(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.lines must be a non-empty array`);
  }
  if (
    value.some(
      (line) =>
        typeof line !== "string" || line.includes("\n") || line.includes("\r"),
    )
  ) {
    throw new Error(`${label}.lines must contain newline-free strings`);
  }
  return [...value] as string[];
}

export function parseOperation(value: unknown, index = 0): LineOperation {
  const label = `operations[${index}]`;
  if (!isRecord(value) || typeof value.op !== "string") {
    throw new Error(`${label} must be an operation object`);
  }

  switch (value.op) {
    case "replace":
      assertOnlyKeys(value, ["op", "start", "end", "lines"], label);
      return {
        op: value.op,
        start: positiveInteger(value.start, `${label}.start`),
        end: positiveInteger(value.end, `${label}.end`),
        lines: destinationLines(value.lines, label),
      };
    case "delete":
      assertOnlyKeys(value, ["op", "start", "end"], label);
      return {
        op: value.op,
        start: positiveInteger(value.start, `${label}.start`),
        end: positiveInteger(value.end, `${label}.end`),
      };
    case "insert-before":
    case "insert-after":
      assertOnlyKeys(value, ["op", "line", "lines"], label);
      return {
        op: value.op,
        line: positiveInteger(value.line, `${label}.line`),
        lines: destinationLines(value.lines, label),
      };
    case "head":
    case "tail":
      assertOnlyKeys(value, ["op", "lines"], label);
      return {
        op: value.op,
        lines: destinationLines(value.lines, label),
      };
    default:
      throw new Error(`${label}.op is unsupported`);
  }
}

export function parseEditInput(value: unknown): ParsedEditInput {
  if (!isRecord(value)) throw new Error("Edit input must be an object");
  assertOnlyKeys(value, ["path", "tag", "operations"], "Edit input");
  if (
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.includes("\0")
  ) {
    throw new Error("path must be a non-empty filesystem path");
  }
  if (typeof value.tag !== "string" || !TAG_RE.test(value.tag)) {
    throw new Error("tag must be exactly 16 uppercase hexadecimal characters");
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > MAX_OPERATIONS
  ) {
    throw new Error(`operations must contain 1..${MAX_OPERATIONS} entries`);
  }
  return {
    path: value.path,
    tag: value.tag,
    operations: value.operations.map(parseOperation),
  };
}

/** Streaming-tolerant parser: retain only the complete valid prefix. */
export function parseCompleteOperations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const complete: LineOperation[] = [];
  for (const [index, operation] of value.entries()) {
    try {
      complete.push(parseOperation(operation, index));
    } catch {
      break;
    }
  }
  return complete;
}

function assertLine(line: number, lineCount: number, label: string) {
  if (!Number.isSafeInteger(line) || line < 1 || line > lineCount) {
    throw new Error(`${label} line ${line} is outside 1..${lineCount}`);
  }
}

function assertSeen(
  seenLines: ReadonlySet<number>,
  line: number,
  label: string,
) {
  if (!seenLines.has(line)) {
    throw new Error(
      `${label} targets unseen line ${line}; re-read that line before editing`,
    );
  }
}

export function applyLineOperations(
  originalText: string,
  operations: readonly LineOperation[],
  seenLines: ReadonlySet<number>,
) {
  if (operations.length === 0)
    throw new Error("At least one complete operation is required");

  const original = splitLogicalText(originalText);
  const covered = new Set<number>();
  const replacements = new Map<number, { end: number; lines: string[] }>();
  const insertions = new Map<
    string,
    { line: number; side: "before" | "after"; lines: string[] }
  >();
  let head: string[] | undefined;
  let tail: string[] | undefined;

  for (const [index, operation] of operations.entries()) {
    const label = `operations[${index}]`;
    if (operation.op === "head" || operation.op === "tail") {
      if (operation.op === "head") {
        if (head) throw new Error("Only one head operation is allowed");
        head = operation.lines;
      } else {
        if (tail) throw new Error("Only one tail operation is allowed");
        tail = operation.lines;
      }
      continue;
    }

    if (operation.op === "insert-before" || operation.op === "insert-after") {
      assertLine(operation.line, original.lines.length, label);
      assertSeen(seenLines, operation.line, label);
      const side = operation.op === "insert-before" ? "before" : "after";
      const key = `${side}:${operation.line}`;
      if (insertions.has(key)) {
        throw new Error(
          `Multiple insertions at ${side} line ${operation.line} are not allowed`,
        );
      }
      insertions.set(key, {
        line: operation.line,
        side,
        lines: operation.lines,
      });
      continue;
    }

    if (operation.op !== "replace" && operation.op !== "delete") {
      throw new Error(`${label}.op is unsupported`);
    }
    assertLine(operation.start, original.lines.length, label);
    assertLine(operation.end, original.lines.length, label);
    if (operation.start > operation.end) {
      throw new Error(`${label} range starts after it ends`);
    }
    for (let line = operation.start; line <= operation.end; line++) {
      assertSeen(seenLines, line, label);
      if (covered.has(line))
        throw new Error(`${label} overlaps original line ${line}`);
      covered.add(line);
    }
    replacements.set(operation.start, {
      end: operation.end,
      lines: operation.op === "replace" ? operation.lines : [],
    });
  }

  for (const insertion of insertions.values()) {
    if (covered.has(insertion.line)) {
      throw new Error(
        `Insert anchor line ${insertion.line} is also replaced or deleted`,
      );
    }
  }

  const output = [...(head ?? [])];
  for (let line = 1; line <= original.lines.length; line++) {
    output.push(...(insertions.get(`before:${line}`)?.lines ?? []));
    const replacement = replacements.get(line);
    if (replacement) {
      output.push(...replacement.lines);
      line = replacement.end;
    } else if (!covered.has(line)) {
      output.push(original.lines[line - 1]!);
    }
    output.push(...(insertions.get(`after:${line}`)?.lines ?? []));
  }
  output.push(...(tail ?? []));

  const text = joinLogicalText({
    lines: output,
    finalNewline: original.finalNewline,
  });
  if (text === originalText)
    throw new Error("Hashline operations made no changes");
  return text;
}
