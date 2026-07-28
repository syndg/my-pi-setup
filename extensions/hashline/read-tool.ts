import {
  createReadToolDefinition,
  truncateHead,
  type ReadOperations,
  type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImageMimeFromFile } from "./image-mime.ts";
import { displayPath } from "./path.ts";
import { READ_DESCRIPTION, READ_GUIDELINES, READ_SNIPPET } from "./prompt.ts";
import { readParameters, type ReadInput } from "./schema.ts";
import {
  SNAPSHOT_TEXT_LIMIT_BYTES,
  type SnapshotStore,
} from "./snapshot-store.ts";
import { computeByteIdentity, decodeText, splitLogicalText } from "./text.ts";

interface HashlineReadOperations extends ReadOperations {
  canonicalize: (absolutePath: string) => Promise<string>;
}

export interface HashlineReadDetails extends ReadToolDetails {
  fullOutputPath?: string;
}

type PersistSelectedText = (text: string) => Promise<string>;

function safeTempSegment(value: string | undefined) {
  const normalized = value?.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return normalized || `process-${process.pid}`;
}

async function persistSelectedText(text: string) {
  const directory = await mkdtemp(
    join(
      tmpdir(),
      `pi-hashline-${safeTempSegment(process.env.PI_SESSION_ID)}-`,
    ),
  );
  const outputPath = join(directory, "selected.txt");
  await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
  return outputPath;
}

const defaultOperations: HashlineReadOperations = {
  readFile,
  access: (path) => access(path, constants.R_OK),
  detectImageMimeType: detectImageMimeFromFile,
  canonicalize: realpath,
};

function selectedSource(buffer: Buffer, input: ReadInput) {
  const raw = buffer.toString("utf8");
  const allLines = raw.split("\n");
  const startIndex = input.offset ? Math.max(0, input.offset - 1) : 0;
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= allLines.length
  ) {
    return undefined;
  }
  const endIndex =
    input.limit === undefined
      ? allLines.length
      : Math.min(startIndex + input.limit, allLines.length);
  if (!Number.isSafeInteger(endIndex) || endIndex < startIndex)
    return undefined;
  const selected = allLines.slice(startIndex, endIndex).join("\n");
  const truncation = truncateHead(selected);
  return {
    startLine: startIndex + 1,
    selectedText: selected,
    sourcePrefix: truncation.content,
    displayedRows: truncation.outputLines,
    truncated: truncation.truncated,
    firstLineExceedsLimit: truncation.firstLineExceedsLimit,
  };
}

export function formatHashlineRead(input: {
  path: string;
  tag: string;
  text: string;
  startLine: number;
  displayedRows: number;
  suffix: string;
}) {
  const logical = splitLogicalText(input.text);
  const rows: string[] = [];
  for (
    let line = input.startLine;
    line < input.startLine + input.displayedRows;
    line++
  ) {
    const source = logical.lines[line - 1];
    if (source === undefined) break;
    rows.push(`${line}:${source}`);
  }
  const body = rows.length > 0 ? `\n${rows.join("\n")}` : "";
  return {
    text: `[${input.path}#${input.tag}]${body}${input.suffix}`,
    seenLines: rows.map((_, index) => input.startLine + index),
  };
}

export function createHashlineReadTool(
  cwd: string,
  snapshots: SnapshotStore,
  options: {
    operations?: HashlineReadOperations;
    persistSelectedText?: PersistSelectedText;
  } = {},
) {
  const operations = options.operations ?? defaultOperations;
  const persist = options.persistSelectedText ?? persistSelectedText;
  const renderer = createReadToolDefinition(cwd);

  return {
    ...renderer,
    parameters: readParameters,
    label: "read",
    description: READ_DESCRIPTION,
    promptSnippet: READ_SNIPPET,
    promptGuidelines: READ_GUIDELINES,
    async execute(
      toolCallId: string,
      input: ReadInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof renderer.execute>[3],
      context: Parameters<typeof renderer.execute>[4],
    ) {
      let capturedPath: string | undefined;
      let capturedBuffer: Buffer | undefined;
      let mimeType: string | null | undefined;
      let selectedSpillPath: string | undefined;
      const wrapped = createReadToolDefinition(context.cwd, {
        operations: {
          access: operations.access,
          async detectImageMimeType(path) {
            capturedPath = path;
            mimeType = await operations.detectImageMimeType?.(path);
            return mimeType;
          },
          async readFile(path) {
            capturedPath = path;
            capturedBuffer = await operations.readFile(path);
            if (!mimeType) {
              const selected = selectedSource(capturedBuffer, input);
              if (selected?.truncated) {
                try {
                  selectedSpillPath = await persist(selected.selectedText);
                } catch {
                  selectedSpillPath = undefined;
                }
              }
            }
            return capturedBuffer;
          },
        },
      });
      const result = await wrapped.execute(
        toolCallId,
        input,
        signal,
        onUpdate,
        context,
      );
      const baseResult = selectedSpillPath
        ? {
            ...result,
            content: result.content.map((part, index) =>
              index === 0 && part.type === "text"
                ? {
                    ...part,
                    text: `${part.text}\n\n[Complete selected text saved to: ${selectedSpillPath}]`,
                  }
                : part,
            ),
            details: {
              ...(result.details ?? {}),
              fullOutputPath: selectedSpillPath,
            } satisfies HashlineReadDetails,
          }
        : result;
      const output = baseResult.content[0];
      if (
        !capturedPath ||
        !capturedBuffer ||
        mimeType ||
        output?.type !== "text" ||
        capturedBuffer.byteLength > SNAPSHOT_TEXT_LIMIT_BYTES
      ) {
        return baseResult;
      }

      let decoded: ReturnType<typeof decodeText>;
      try {
        decoded = decodeText(capturedBuffer);
      } catch {
        return baseResult;
      }
      const selected = selectedSource(capturedBuffer, input);
      if (
        !selected ||
        selected.firstLineExceedsLimit ||
        !output.text.startsWith(selected.sourcePrefix)
      ) {
        return baseResult;
      }

      if (signal?.aborted) throw new Error("Operation aborted");
      let canonicalPath: string;
      try {
        canonicalPath = await operations.canonicalize(capturedPath);
      } catch {
        return baseResult;
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const shownPath = displayPath(input.path);
      const suffix = output.text.slice(selected.sourcePrefix.length);
      try {
        const provisional = formatHashlineRead({
          path: shownPath,
          tag: "0000000000000000",
          text: decoded.normalized,
          startLine: selected.startLine,
          displayedRows: selected.displayedRows,
          suffix,
        });
        const snapshot = snapshots.recordRead({
          canonicalPath,
          resolvedPath: capturedPath,
          displayPath: shownPath,
          text: decoded.normalized,
          byteIdentity: computeByteIdentity(capturedBuffer),
          seenLines: provisional.seenLines,
        });
        const formatted = formatHashlineRead({
          path: shownPath,
          tag: snapshot.tag,
          text: decoded.normalized,
          startLine: selected.startLine,
          displayedRows: selected.displayedRows,
          suffix,
        });
        return {
          ...baseResult,
          content: baseResult.content.map((part, index) =>
            index === 0 && part.type === "text"
              ? { type: "text" as const, text: formatted.text }
              : part,
          ),
        };
      } catch (error) {
        if (error instanceof Error) return baseResult;
        throw error;
      }
    },
  };
}
