import {
  withFileMutationQueue,
  type EditOperations,
  type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { createEditDetails } from "./diff.ts";
import { applyLineOperations, parseEditInput } from "./operations.ts";
import { displayPath } from "./path.ts";
import { EDIT_DESCRIPTION, EDIT_GUIDELINES, EDIT_SNIPPET } from "./prompt.ts";
import {
  formatPostEditResult,
  selectPostEditContext,
} from "./result-context.ts";
import { editParameters, type EditInput } from "./schema.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { computeByteIdentity, decodeText, encodeText } from "./text.ts";

export interface HashlineEditOperations extends EditOperations {
  canonicalize: (absolutePath: string) => Promise<string>;
}

const defaultOperations: HashlineEditOperations = {
  readFile,
  writeFile: (path, content) => writeFile(path, content, "utf8"),
  access: (path) => access(path, constants.R_OK | constants.W_OK),
  canonicalize: realpath,
};

function aborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function accessError(path: string, error: unknown) {
  const message =
    error instanceof Error && "code" in error
      ? `Error code: ${String(error.code)}`
      : String(error);
  return new Error(`Could not edit file: ${path}. ${message}.`);
}

function identityChanged(path: string) {
  return new Error(
    `The resolved filesystem identity changed for ${path} after read. Re-read and retry.`,
  );
}

export async function executeHashlineEdit(input: {
  cwd: string;
  params: unknown;
  snapshots: SnapshotStore;
  signal?: AbortSignal;
  operations?: HashlineEditOperations;
}) {
  const parsed = parseEditInput(input.params);
  const operations = input.operations ?? defaultOperations;
  const shownPath = displayPath(parsed.path);
  const snapshot = input.snapshots.getForEdit(shownPath, parsed.tag);

  return withFileMutationQueue(snapshot.resolvedPath, async () => {
    aborted(input.signal);
    try {
      await operations.access(snapshot.resolvedPath);
    } catch (error) {
      aborted(input.signal);
      throw accessError(parsed.path, error);
    }
    aborted(input.signal);

    const canonicalBeforeRead = await operations.canonicalize(
      snapshot.resolvedPath,
    );
    aborted(input.signal);
    if (canonicalBeforeRead !== snapshot.canonicalPath) {
      throw identityChanged(shownPath);
    }

    const buffer = await operations.readFile(snapshot.resolvedPath);
    aborted(input.signal);
    const decoded = decodeText(buffer);
    if (
      snapshot.byteIdentity !== computeByteIdentity(buffer) ||
      snapshot.text !== decoded.normalized
    ) {
      throw new Error(
        `Stale snapshot ${shownPath}#${parsed.tag}; file bytes or text fidelity changed after read. Re-read and retry.`,
      );
    }

    const next = applyLineOperations(
      snapshot.text,
      parsed.operations,
      snapshot.seenLines,
    );
    const details = createEditDetails(shownPath, snapshot.text, next);
    const postEditContext = selectPostEditContext(snapshot.text, next);
    const encoded = encodeText(next, decoded.fidelity);
    const encodedBytes = Buffer.from(encoded, "utf8");

    // Reserve ledger capacity before the write. This makes post-write recording
    // synchronous and non-failing even if another file edits concurrently.
    input.snapshots.validateRecord({
      canonicalPath: snapshot.canonicalPath,
      resolvedPath: snapshot.resolvedPath,
      displayPath: shownPath,
      text: next,
      byteIdentity: computeByteIdentity(encodedBytes),
      seenLines: postEditContext.rows.map((row) => row.line),
    });

    const canonicalBeforeWrite = await operations.canonicalize(
      snapshot.resolvedPath,
    );
    aborted(input.signal);
    if (canonicalBeforeWrite !== snapshot.canonicalPath) {
      throw identityChanged(shownPath);
    }

    // Like Pi's built-in write, never release the queue while this promise is
    // unsettled. If abort arrives during the write, record resulting state
    // before observing it so a completed mutation never skips bookkeeping.
    await operations.writeFile(snapshot.resolvedPath, encoded);
    const fresh = input.snapshots.recordEdit({
      canonicalPath: snapshot.canonicalPath,
      resolvedPath: snapshot.resolvedPath,
      displayPath: shownPath,
      text: next,
      byteIdentity: computeByteIdentity(encodedBytes),
      seenLines: postEditContext.rows.map((row) => row.line),
    });
    aborted(input.signal);

    return {
      content: [
        {
          type: "text" as const,
          text: formatPostEditResult({
            path: shownPath,
            tag: fresh.tag,
            operationCount: parsed.operations.length,
            rows: postEditContext.rows,
            truncated: postEditContext.truncated,
          }),
        },
      ],
      details: details satisfies EditToolDetails,
    };
  });
}

export function createHashlineEditTool(input: {
  cwd: string;
  snapshots: SnapshotStore;
  operations?: HashlineEditOperations;
}) {
  return {
    name: "edit",
    label: "edit",
    description: EDIT_DESCRIPTION,
    promptSnippet: EDIT_SNIPPET,
    promptGuidelines: EDIT_GUIDELINES,
    parameters: editParameters,
    renderShell: "self" as const,
    async execute(
      _toolCallId: string,
      params: EditInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: { cwd: string },
    ) {
      return executeHashlineEdit({
        ...input,
        cwd: context.cwd,
        params,
        signal,
      });
    },
  };
}
