import { validateLineOperations, type LineOperation } from "./operations.ts";
import { countLogicalLines } from "./text.ts";

function collectSourceLineNumbers(operations: readonly LineOperation[]) {
  const requested = new Set<number>();
  for (const operation of operations) {
    if (operation.op !== "replace" && operation.op !== "delete") continue;
    for (let line = operation.start; line <= operation.end; line++) {
      requested.add(line);
    }
  }
  return requested;
}

function selectSourceLines(text: string, requested: ReadonlySet<number>) {
  const selected = new Map<number, string>();
  if (requested.size === 0) return selected;

  let line = 1;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    if (requested.has(line)) selected.set(line, text.slice(start, end));
    if (selected.size === requested.size || newline === -1) break;
    start = newline + 1;
    line++;
  }
  return selected;
}

function replacementChangesSource(
  operation: Extract<LineOperation, { op: "replace" }>,
  sourceLines: ReadonlyMap<number, string>,
) {
  if (operation.lines.length !== operation.end - operation.start + 1) {
    return true;
  }
  return operation.lines.some(
    (line, index) => sourceLines.get(operation.start + index) !== line,
  );
}

function operationsChangeText(
  originalText: string,
  lineCount: number,
  operations: readonly LineOperation[],
  sourceLines: ReadonlyMap<number, string>,
) {
  let changed = false;
  let boundaryRows = 0;
  let firstBoundaryLine: string | undefined;

  for (const operation of operations) {
    switch (operation.op) {
      case "delete":
        changed = true;
        break;
      case "replace":
        changed ||= replacementChangesSource(operation, sourceLines);
        break;
      case "insert-before":
      case "insert-after":
        changed ||= operation.lines.length > 0;
        break;
      case "head":
      case "tail":
        if (boundaryRows === 0) firstBoundaryLine = operation.lines[0];
        boundaryRows += operation.lines.length;
        break;
    }
  }

  if (lineCount > 0) return changed || boundaryRows > 0;
  return (
    changed ||
    boundaryRows > 1 ||
    (boundaryRows === 1 && firstBoundaryLine !== "")
  );
}

/**
 * Builds a pending preview directly from validated operations. It scans source
 * metadata and changed rows only; the whole edited file and full-file line
 * arrays are intentionally never materialized.
 */
export function createStreamingPreview(
  originalText: string,
  operations: readonly LineOperation[],
  seenLines: ReadonlySet<number>,
) {
  const lineCount = countLogicalLines(originalText);
  validateLineOperations(lineCount, operations, seenLines);
  const sourceLines = selectSourceLines(
    originalText,
    collectSourceLineNumbers(operations),
  );
  if (!operationsChangeText(originalText, lineCount, operations, sourceLines)) {
    throw new Error("Hashline operations made no changes");
  }

  const width = String(Math.max(1, lineCount)).length;
  const rows: string[] = [];
  const add = (lines: readonly string[], anchor: number) => {
    for (const [index, line] of lines.entries()) {
      rows.push(`+${String(anchor + index).padStart(width, " ")} ${line}`);
    }
  };

  for (const operation of operations) {
    switch (operation.op) {
      case "replace":
      case "delete":
        for (let line = operation.start; line <= operation.end; line++) {
          const source = sourceLines.get(line);
          if (source === undefined) {
            throw new Error(`Missing source line ${line} while previewing`);
          }
          rows.push(`-${String(line).padStart(width, " ")} ${source}`);
        }
        if (operation.op === "replace") add(operation.lines, operation.start);
        break;
      case "insert-before":
        add(operation.lines, operation.line);
        break;
      case "insert-after":
        add(operation.lines, operation.line + 1);
        break;
      case "head":
        add(operation.lines, 1);
        break;
      case "tail":
        add(operation.lines, lineCount + 1);
        break;
    }
  }

  return rows.join("\n");
}
