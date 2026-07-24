import * as Diff from "diff";
import { splitLogicalText } from "./text.ts";

export const MAX_POST_EDIT_CONTEXT_LINES = 40;
export const MAX_POST_EDIT_CONTEXT_BYTES = 12 * 1024;
const CONTEXT_RADIUS = 2;

export function selectPostEditContext(oldText: string, newText: string) {
  const changed = new Set<number>();
  let newLine = 1;
  for (const part of Diff.diffLines(oldText, newText)) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (part.added) {
      for (let offset = 0; offset < lines.length; offset++)
        changed.add(newLine + offset);
      newLine += lines.length;
    } else if (part.removed) {
      changed.add(newLine);
    } else {
      newLine += lines.length;
    }
  }

  const logical = splitLogicalText(newText);
  const candidates = new Set<number>();
  for (const anchor of changed) {
    const boundedAnchor = Math.max(1, Math.min(anchor, logical.lines.length));
    for (
      let line = Math.max(1, boundedAnchor - CONTEXT_RADIUS);
      line <= Math.min(logical.lines.length, boundedAnchor + CONTEXT_RADIUS);
      line++
    ) {
      candidates.add(line);
    }
  }

  const sorted = [...candidates].sort((left, right) => left - right);
  const selected: Array<{ line: number; text: string }> = [];
  let bytes = 0;
  for (const line of sorted) {
    if (selected.length >= MAX_POST_EDIT_CONTEXT_LINES) break;
    const text = logical.lines[line - 1]!;
    const formatted = `${line}:${text}`;
    const rowBytes =
      Buffer.byteLength(formatted, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + rowBytes > MAX_POST_EDIT_CONTEXT_BYTES) break;
    selected.push({ line, text });
    bytes += rowBytes;
  }

  return {
    rows: selected,
    truncated: selected.length < sorted.length,
  };
}

export function formatPostEditResult(input: {
  path: string;
  tag: string;
  operationCount: number;
  rows: ReadonlyArray<{ line: number; text: string }>;
  truncated: boolean;
}) {
  const numbered = input.rows.map((row) => `${row.line}:${row.text}`);
  const context = [`[${input.path}#${input.tag}]`, ...numbered].join("\n");
  const guidance = input.truncated
    ? "Post-edit context was truncated; call read before another edit."
    : "Re-ground the next edit from these visible rows, or call read for any other target.";
  return `Successfully applied ${input.operationCount} Hashline operation(s) to ${input.path}.\n${context}\n\n[${guidance}]`;
}
