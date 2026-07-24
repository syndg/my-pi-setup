import * as Diff from "diff";

/**
 * Display diff and patch formatting adapted from Pi 0.82.0's MIT-licensed
 * edit-diff module so Hashline returns the exact public EditToolDetails shape.
 */
export function createEditDetails(
  path: string,
  oldContent: string,
  newContent: string,
) {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const maxLineNumber = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length,
  );
  const width = String(maxLineNumber).length;
  let oldLine = 1;
  let newLine = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  const contextLines = 4;

  const context = (line: string) => {
    output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
    oldLine++;
    newLine++;
  };

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();

    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(width, " ")} ${line}`);
          newLine++;
        } else {
          output.push(`-${String(oldLine).padStart(width, " ")} ${line}`);
          oldLine++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const next = parts[index + 1];
    const nextIsChange = Boolean(next?.added || next?.removed);
    if (lastWasChange && nextIsChange) {
      if (lines.length <= contextLines * 2) {
        for (const line of lines) context(line);
      } else {
        for (const line of lines.slice(0, contextLines)) context(line);
        const skipped = lines.length - contextLines * 2;
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
        for (const line of lines.slice(-contextLines)) context(line);
      }
    } else if (lastWasChange) {
      for (const line of lines.slice(0, contextLines)) context(line);
      const skipped = lines.length - Math.min(lines.length, contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
      }
    } else if (nextIsChange) {
      const skipped = Math.max(0, lines.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
      }
      for (const line of lines.slice(skipped)) context(line);
    } else {
      oldLine += lines.length;
      newLine += lines.length;
    }
    lastWasChange = false;
  }

  const patch = Diff.createTwoFilesPatch(
    path,
    path,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: contextLines, headerOptions: Diff.FILE_HEADERS_ONLY },
  );
  return { diff: output.join("\n"), patch, firstChangedLine };
}
