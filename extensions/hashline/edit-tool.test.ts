import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWriteToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  executeHashlineEdit,
  type HashlineEditOperations,
} from "./edit-tool.ts";
import { createHashlineReadTool } from "./read-tool.ts";
import { SnapshotStore, computeTag } from "./snapshot-store.ts";
import { computeByteIdentity, decodeText } from "./text.ts";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-edit-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordFile(
  store: SnapshotStore,
  absolutePath: string,
  shownPath: string,
  seenLines: number[],
) {
  const raw = await readFile(absolutePath);
  const decoded = decodeText(raw);
  return store.recordRead({
    canonicalPath: await realpath(absolutePath),
    resolvedPath: absolutePath,
    displayPath: shownPath,
    text: decoded.normalized,
    byteIdentity: computeByteIdentity(raw),
    seenLines,
  });
}

test("applies complete preflight once and returns exact Pi EditToolDetails", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "a.txt");
    await writeFile(absolute, "one\ntwo\nthree\n");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(snapshots, absolute, "a.txt", [1, 2, 3]);

    const result = await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "a.txt",
        tag: snapshot.tag,
        operations: [
          { op: "replace", start: 2, end: 2, lines: ["TWO"] },
          { op: "tail", lines: ["four"] },
        ],
      },
    });

    assert.equal(await readFile(absolute, "utf8"), "one\nTWO\nthree\nfour\n");
    assert.deepEqual(Object.keys(result.details).sort(), [
      "diff",
      "firstChangedLine",
      "patch",
    ]);
    assert.match(result.details.diff, /-2 two\n\+2 TWO/);
    assert.match(result.details.patch, /^--- a\.txt\n\+\+\+ a\.txt/m);
    assert.equal(result.details.firstChangedLine, 2);

    const modelText = result.content[0]!.text;
    const freshTag = modelText.match(/#([0-9A-F]{16})/)?.[1];
    assert.ok(freshTag);
    assert.notEqual(freshTag, snapshot.tag);
    assert.match(modelText, /2:TWO/);
    assert.match(modelText, /4:four/);
    const fresh = snapshots.getForPreview("a.txt", freshTag);
    assert.ok(fresh?.seenLines.has(4));

    await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "a.txt",
        tag: freshTag,
        operations: [{ op: "replace", start: 4, end: 4, lines: ["FOUR"] }],
      },
    });
    assert.equal(await readFile(absolute, "utf8"), "one\nTWO\nthree\nFOUR\n");
  }));

test("preserves BOM, CRLF, and final newline", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "windows.txt");
    await writeFile(absolute, "\uFEFFone\r\ntwo\r\n");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(
      snapshots,
      absolute,
      "windows.txt",
      [1, 2],
    );
    await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "windows.txt",
        tag: snapshot.tag,
        operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
      },
    });
    assert.equal(await readFile(absolute, "utf8"), "\uFEFFone\r\nTWO\r\n");
  }));

test("rejects LF/CRLF and BOM fidelity changes even when normalized text matches", () =>
  withDirectory(async (directory) => {
    for (const [name, before, changed] of [
      ["ending.txt", "one\r\ntwo\r\n", "one\ntwo\n"],
      ["bom.txt", "\uFEFFone\ntwo\n", "one\ntwo\n"],
    ] as const) {
      const absolute = path.join(directory, name);
      await writeFile(absolute, before);
      const snapshots = new SnapshotStore();
      const snapshot = await recordFile(snapshots, absolute, name, [1, 2]);
      await writeFile(absolute, changed);
      await assert.rejects(
        executeHashlineEdit({
          cwd: directory,
          snapshots,
          params: {
            path: name,
            tag: snapshot.tag,
            operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
          },
        }),
        /fidelity|changed after read/,
      );
      assert.equal(await readFile(absolute, "utf8"), changed);
    }
  }));

test("edit uses Pi's trusted fallback-resolved path rather than re-resolving displayed input", () =>
  withDirectory(async (directory) => {
    const actualName = "Capture d’écran.txt";
    const displayedName = "Capture d'écran.txt";
    const absolute = path.join(directory, actualName);
    await writeFile(absolute, "one\ntwo\n");
    const snapshots = new SnapshotStore();
    const readTool = createHashlineReadTool(directory, snapshots);
    const readResult = await Reflect.apply(readTool.execute, readTool, [
      "fallback-read",
      { path: displayedName },
      undefined,
      undefined,
      { cwd: directory, model: undefined },
    ]);
    const readPart = readResult.content[0];
    assert.equal(readPart?.type, "text");
    const tag =
      readPart?.type === "text"
        ? readPart.text.match(/#([0-9A-F]{16})/)?.[1]
        : undefined;
    assert.ok(tag);
    await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: displayedName,
        tag,
        operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
      },
    });
    assert.equal(await readFile(absolute, "utf8"), "one\nTWO\n");
  }));

test("unknown, stale, unseen, overlap, and no-op failures never write", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "guarded.txt");
    await writeFile(absolute, "one\ntwo\nthree");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(
      snapshots,
      absolute,
      "guarded.txt",
      [1, 2],
    );
    let writes = 0;
    const operations: HashlineEditOperations = {
      access: async () => {},
      canonicalize: realpath,
      readFile,
      async writeFile(target, content) {
        writes++;
        await writeFile(target, content);
      },
    };
    const run = (params: unknown) =>
      executeHashlineEdit({ cwd: directory, snapshots, params, operations });

    await assert.rejects(
      run({
        path: "guarded.txt",
        tag: "0000000000000000",
        operations: [{ op: "head", lines: ["x"] }],
      }),
      /Unrecognized snapshot/,
    );
    await assert.rejects(
      run({
        path: "guarded.txt",
        tag: snapshot.tag,
        operations: [{ op: "delete", start: 3, end: 3 }],
      }),
      /unseen line 3/,
    );
    await assert.rejects(
      run({
        path: "guarded.txt",
        tag: snapshot.tag,
        operations: [{ op: "replace", start: 2, end: 2, lines: ["two"] }],
      }),
      /made no changes/,
    );
    await writeFile(absolute, "changed\ntwo\nthree");
    await assert.rejects(
      run({
        path: "guarded.txt",
        tag: snapshot.tag,
        operations: [{ op: "delete", start: 2, end: 2 }],
      }),
      /Stale snapshot/,
    );
    assert.equal(writes, 0);
  }));

test("canonical identity accepts the read symlink alias and direct write preserves it", () =>
  withDirectory(async (directory) => {
    const target = path.join(directory, "target.txt");
    const link = path.join(directory, "alias.txt");
    await writeFile(target, "one\ntwo\n");
    await symlink(target, link);
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(snapshots, link, "alias.txt", [1, 2]);

    await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "alias.txt",
        tag: snapshot.tag,
        operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
      },
    });

    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "one\nTWO\n");
  }));

test("symlink replacement after read fails canonical identity revalidation", () =>
  withDirectory(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const link = path.join(directory, "alias.txt");
    await writeFile(first, "one\ntwo\n");
    await writeFile(second, "one\ntwo\n");
    await symlink(first, link);
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(snapshots, link, "alias.txt", [1, 2]);
    await rm(link);
    await symlink(second, link);

    await assert.rejects(
      executeHashlineEdit({
        cwd: directory,
        snapshots,
        params: {
          path: "alias.txt",
          tag: snapshot.tag,
          operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
        },
      }),
      /identity changed/,
    );
    assert.equal(await readFile(second, "utf8"), "one\ntwo\n");
  }));

test("symlink identity is revalidated again immediately before writing", () =>
  withDirectory(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const link = path.join(directory, "late-alias.txt");
    await writeFile(first, "one\ntwo\n");
    await writeFile(second, "one\ntwo\n");
    await symlink(first, link);
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(
      snapshots,
      link,
      "late-alias.txt",
      [1, 2],
    );
    let writes = 0;
    await assert.rejects(
      executeHashlineEdit({
        cwd: directory,
        snapshots,
        operations: {
          access: async () => {},
          canonicalize: realpath,
          async readFile(target) {
            const bytes = await readFile(target);
            await rm(link);
            await symlink(second, link);
            return bytes;
          },
          async writeFile() {
            writes++;
          },
        },
        params: {
          path: "late-alias.txt",
          tag: snapshot.tag,
          operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
        },
      }),
      /identity changed/,
    );
    assert.equal(writes, 0);
    assert.equal(await readFile(second, "utf8"), "one\ntwo\n");
  }));

test("post-edit revert replaces old provenance instead of unioning it", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "revert.txt");
    const original = Array.from(
      { length: 10 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    await writeFile(absolute, original);
    const snapshots = new SnapshotStore();
    const first = await recordFile(
      snapshots,
      absolute,
      "revert.txt",
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    const changed = await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "revert.txt",
        tag: first.tag,
        operations: [{ op: "replace", start: 1, end: 1, lines: ["changed"] }],
      },
    });
    const changedTag = changed.content[0]!.text.match(/#([0-9A-F]{16})/)?.[1];
    assert.ok(changedTag);
    const reverted = await executeHashlineEdit({
      cwd: directory,
      snapshots,
      params: {
        path: "revert.txt",
        tag: changedTag,
        operations: [{ op: "replace", start: 1, end: 1, lines: ["line-1"] }],
      },
    });
    const revertedTag = reverted.content[0]!.text.match(/#([0-9A-F]{16})/)?.[1];
    assert.equal(revertedTag, first.tag);
    assert.deepEqual(
      [...snapshots.getForPreview("revert.txt", revertedTag!)!.seenLines],
      [1, 2, 3],
    );
  }));

test("abort observed after a settled write still records the resulting fresh snapshot", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "abort.txt");
    await writeFile(absolute, "one\ntwo");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(snapshots, absolute, "abort.txt", [1, 2]);
    const controller = new AbortController();
    await assert.rejects(
      executeHashlineEdit({
        cwd: directory,
        snapshots,
        signal: controller.signal,
        operations: {
          access: async () => {},
          canonicalize: realpath,
          readFile,
          async writeFile(target, content) {
            await writeFile(target, content);
            controller.abort();
          },
        },
        params: {
          path: "abort.txt",
          tag: snapshot.tag,
          operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
        },
      }),
      /Operation aborted/,
    );
    assert.equal(await readFile(absolute, "utf8"), "one\nTWO");
    assert.ok(snapshots.getForPreview("abort.txt", computeTag("one\nTWO")));
  }));

test("entire read-modify-write waits inside Pi's canonical mutation queue", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "queued.txt");
    await writeFile(absolute, "one\ntwo");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(
      snapshots,
      absolute,
      "queued.txt",
      [1, 2],
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accesses = 0;
    const blocker = withFileMutationQueue(absolute, async () => gate);
    const pending = executeHashlineEdit({
      cwd: directory,
      snapshots,
      operations: {
        async access() {
          accesses++;
        },
        canonicalize: realpath,
        readFile,
        writeFile: (target, content) => writeFile(target, content),
      },
      params: {
        path: "queued.txt",
        tag: snapshot.tag,
        operations: [{ op: "tail", lines: ["three"] }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(accesses, 0);
    release();
    await blocker;
    await pending;
    assert.equal(accesses, 1);
  }));

test("serialization shares the host package queue with Pi's built-in write", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "host-queue.txt");
    await writeFile(absolute, "one\ntwo");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(
      snapshots,
      absolute,
      "host-queue.txt",
      [1, 2],
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accesses = 0;
    const hostWrite = createWriteToolDefinition(directory, {
      operations: {
        mkdir: async () => {},
        async writeFile(target, content) {
          await gate;
          await writeFile(target, content);
        },
      },
    });
    const writing = Reflect.apply(hostWrite.execute, hostWrite, [
      "host-write",
      { path: "host-queue.txt", content: "host" },
      undefined,
      undefined,
      { cwd: directory },
    ]);
    const editing = executeHashlineEdit({
      cwd: directory,
      snapshots,
      operations: {
        async access() {
          accesses++;
        },
        canonicalize: realpath,
        readFile,
        writeFile: (target, content) => writeFile(target, content),
      },
      params: {
        path: "host-queue.txt",
        tag: snapshot.tag,
        operations: [{ op: "tail", lines: ["three"] }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(accesses, 0);
    release();
    await writing;
    await assert.rejects(editing, /changed after read/);
  }));

test("two same-tag edits serialize; the second observes freshness and cannot overwrite", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "race.txt");
    await writeFile(absolute, "one\ntwo");
    const snapshots = new SnapshotStore();
    const snapshot = await recordFile(snapshots, absolute, "race.txt", [1, 2]);
    const params = (line: string) => ({
      path: "race.txt",
      tag: snapshot.tag,
      operations: [{ op: "tail", lines: [line] }],
    });
    const settled = await Promise.allSettled([
      executeHashlineEdit({
        cwd: directory,
        snapshots,
        params: params("first"),
      }),
      executeHashlineEdit({
        cwd: directory,
        snapshots,
        params: params("second"),
      }),
    ]);
    assert.deepEqual(settled.map((result) => result.status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    assert.match(
      await readFile(absolute, "utf8"),
      /^one\ntwo\n(first|second)$/,
    );
  }));
