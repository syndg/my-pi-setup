import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReadToolDefinition,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { applyLineOperations } from "./operations.ts";
import {
  createHashlineReadTool,
  type HashlineReadDetails,
} from "./read-tool.ts";
import { SnapshotStore } from "./snapshot-store.ts";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-read-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function execute(
  tool: { execute: Function },
  input: { path: string; offset?: number; limit?: number },
  cwd: string,
) {
  return Reflect.apply(tool.execute, tool, [
    "call",
    input,
    undefined,
    undefined,
    { cwd, model: undefined },
  ]) as Promise<AgentToolResult<HashlineReadDetails | undefined>>;
}

function output(result: AgentToolResult<HashlineReadDetails | undefined>) {
  const part = result.content[0];
  assert.equal(part?.type, "text");
  return part.type === "text" ? part.text : "";
}

test("preserves built-in limit notice/details while numbering only displayed source rows", () =>
  withDirectory(async (directory) => {
    await writeFile(path.join(directory, "a.txt"), "one\ntwo\nthree\nfour\n");
    const snapshots = new SnapshotStore();
    const hashline = createHashlineReadTool(directory, snapshots);
    const builtin = createReadToolDefinition(directory);
    const input = { path: "a.txt", limit: 2 };

    const [actual, baseline] = await Promise.all([
      execute(hashline, input, directory),
      execute(builtin, input, directory),
    ]);
    assert.deepEqual(actual.details, baseline.details);
    assert.match(output(actual), /^\[a\.txt#[0-9A-F]{16}\]\n1:one\n2:two/);
    assert.match(
      output(actual),
      /\n\n\[3 more lines in file\. Use offset=3 to continue\.\]$/,
    );

    const header = output(actual).split("\n", 1)[0]!;
    const tag = header.slice(header.indexOf("#") + 1, -1);
    const snapshot = snapshots.getForPreview("a.txt", tag)!;
    assert.deepEqual([...snapshot.seenLines], [1, 2]);
    assert.throws(
      () =>
        applyLineOperations(
          snapshot.text,
          [{ op: "delete", start: 3, end: 3 }],
          snapshot.seenLines,
        ),
      /unseen line 3/,
    );
  }));

test("preserves built-in line truncation and continuation notice", () =>
  withDirectory(async (directory) => {
    const text = Array.from(
      { length: 2002 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    await writeFile(path.join(directory, "many.txt"), text);
    const snapshots = new SnapshotStore();
    const actual = await execute(
      createHashlineReadTool(directory, snapshots),
      { path: "many.txt" },
      directory,
    );
    const baseline = await execute(
      createReadToolDefinition(directory),
      { path: "many.txt" },
      directory,
    );

    assert.deepEqual(actual.details?.truncation, baseline.details?.truncation);
    assert.ok(actual.details?.fullOutputPath);
    assert.equal(actual.details?.truncation?.outputLines, 2000);
    assert.match(
      output(actual),
      /2000:line-2000\n\n\[Showing lines 1-2000 of 2002/,
    );
    const tag = output(actual).match(/^\[[^#]+#([0-9A-F]{16})\]/)?.[1];
    assert.ok(tag);
    assert.equal(
      snapshots.getForPreview("many.txt", tag)?.seenLines.has(2001),
      false,
    );
  }));

test("preserves byte-truncation notice and exact details", () =>
  withDirectory(async (directory) => {
    const text = Array.from(
      { length: 1000 },
      (_, index) => `${index}-${"x".repeat(100)}`,
    ).join("\n");
    await writeFile(path.join(directory, "bytes.txt"), text);
    const snapshots = new SnapshotStore();
    const input = { path: "bytes.txt" };
    const [actual, baseline] = await Promise.all([
      execute(createHashlineReadTool(directory, snapshots), input, directory),
      execute(createReadToolDefinition(directory), input, directory),
    ]);

    assert.deepEqual(actual.details?.truncation, baseline.details?.truncation);
    assert.ok(actual.details?.fullOutputPath);
    assert.equal(actual.details?.truncation?.truncatedBy, "bytes");
    assert.match(
      output(actual),
      /50\.0KB limit\)\. Use offset=\d+ to continue\.\]/,
    );
  }));

test("spills exactly the complete selected slice before truncation", () =>
  withDirectory(async (directory) => {
    const lines = Array.from(
      { length: 3_100 },
      (_, index) => `line-${index + 1}`,
    );
    await writeFile(path.join(directory, "slice.txt"), lines.join("\n"));
    const snapshots = new SnapshotStore();
    const result = await execute(
      createHashlineReadTool(directory, snapshots),
      { path: "slice.txt", offset: 501, limit: 2_500 },
      directory,
    );
    assert.equal(result.details?.truncation?.truncated, true);
    assert.ok(result.details?.fullOutputPath);
    assert.equal(
      await readFile(result.details.fullOutputPath, "utf8"),
      lines.slice(500, 3_000).join("\n"),
    );
    assert.match(output(result), /Complete selected text saved to:/);
    assert.doesNotMatch(
      await readFile(result.details.fullOutputPath, "utf8"),
      /line-500\n/,
    );
    const tag = output(result).match(/#([0-9A-F]{16})/)?.[1];
    assert.ok(tag);
    const snapshot = snapshots.getForPreview("slice.txt", tag);
    assert.equal(snapshot?.seenLines.has(2_500), true);
    assert.equal(snapshot?.seenLines.has(2_501), false);
  }));

test("spill failure preserves truncation without claiming a saved artifact", () =>
  withDirectory(async (directory) => {
    await writeFile(path.join(directory, "fail.txt"), "line\n".repeat(3_000));
    const result = await execute(
      createHashlineReadTool(directory, new SnapshotStore(), {
        persistSelectedText: () => Promise.reject(new Error("disk full")),
      }),
      { path: "fail.txt" },
      directory,
    );
    assert.equal(result.details?.truncation?.truncated, true);
    assert.equal(result.details?.fullOutputPath, undefined);
    assert.doesNotMatch(output(result), /Complete selected text saved to:/);
  }));

test("does not tag oversized-first-line output", () =>
  withDirectory(async (directory) => {
    await writeFile(path.join(directory, "wide.txt"), "x".repeat(60 * 1024));
    const snapshots = new SnapshotStore();
    const input = { path: "wide.txt" };
    const [actual, baseline] = await Promise.all([
      execute(createHashlineReadTool(directory, snapshots), input, directory),
      execute(createReadToolDefinition(directory), input, directory),
    ]);
    assert.ok(output(actual).startsWith(output(baseline)));
    assert.deepEqual(actual.details?.truncation, baseline.details?.truncation);
    assert.ok(actual.details?.fullOutputPath);
    assert.equal(
      await readFile(actual.details.fullOutputPath, "utf8"),
      "x".repeat(60 * 1024),
    );
    assert.equal(snapshots.size, 0);
  }));

test("images, errors, aborted calls, and unsafe snapshot-sized text never receive tags", () =>
  withDirectory(async (directory) => {
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64",
    );
    await writeFile(path.join(directory, "pixel.gif"), gif);
    const huge = `${"x".repeat(1024)}\n`.repeat(4097);
    await writeFile(path.join(directory, "huge.txt"), huge);
    const snapshots = new SnapshotStore();
    const tool = createHashlineReadTool(directory, snapshots);

    const image = await execute(tool, { path: "pixel.gif" }, directory);
    assert.doesNotMatch(output(image), /^\[/);
    assert.equal(
      image.content.some((part) => part.type === "image"),
      true,
    );

    await assert.rejects(execute(tool, { path: "missing.txt" }, directory));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      Reflect.apply(tool.execute, tool, [
        "aborted",
        { path: "huge.txt" },
        controller.signal,
        undefined,
        { cwd: directory, model: undefined },
      ]),
      /Operation aborted/,
    );

    const oversized = await execute(tool, { path: "huge.txt" }, directory);
    assert.doesNotMatch(output(oversized), /^\[huge\.txt#/);
    assert.equal(snapshots.size, 0);
  }));

test("malformed UTF-8, NUL, and bare-CR files retain Pi's original untagged result", () =>
  withDirectory(async (directory) => {
    const fixtures = [
      ["malformed.txt", Buffer.from([0xc3, 0x28])],
      ["nul.txt", Buffer.from("safe\0unsafe")],
      ["bare-cr.txt", Buffer.from("one\rtwo")],
    ] as const;
    for (const [name, bytes] of fixtures) {
      await writeFile(path.join(directory, name), bytes);
      const snapshots = new SnapshotStore();
      const input = { path: name };
      const [actual, baseline] = await Promise.all([
        execute(createHashlineReadTool(directory, snapshots), input, directory),
        execute(createReadToolDefinition(directory), input, directory),
      ]);
      assert.equal(output(actual), output(baseline));
      assert.equal(snapshots.size, 0);
    }
  }));

test("Pi curly-quote and NFD fallback paths retain the resolved target", () =>
  withDirectory(async (directory) => {
    for (const [actualName, displayedName] of [
      ["Capture d’écran.txt", "Capture d'écran.txt"],
      ["Cafe\u0301.txt", "Café.txt"],
    ]) {
      await writeFile(path.join(directory, actualName), "one\ntwo\n");
      const snapshots = new SnapshotStore();
      const result = await execute(
        createHashlineReadTool(directory, snapshots),
        { path: displayedName },
        directory,
      );
      const tag = output(result).match(/#([0-9A-F]{16})/)?.[1];
      assert.ok(tag);
      const snapshot = snapshots.getForPreview(displayedName, tag);
      assert.equal(
        snapshot?.resolvedPath.normalize("NFD"),
        path.join(directory, actualName).normalize("NFD"),
      );
      assert.equal(
        snapshot?.canonicalPath,
        await realpath(path.join(directory, actualName)),
      );
    }
  }));

test("a detected tag collision leaves the second read in safe built-in form", () =>
  withDirectory(async (directory) => {
    const absolute = path.join(directory, "collision.txt");
    await writeFile(absolute, "first");
    const snapshots = new SnapshotStore({ tagger: () => "AAAAAAAAAAAAAAAA" });
    const tool = createHashlineReadTool(directory, snapshots);
    assert.match(
      output(await execute(tool, { path: "collision.txt" }, directory)),
      /#AAAAAAAAAAAAAAAA/,
    );
    await writeFile(absolute, "second");
    const collision = await execute(tool, { path: "collision.txt" }, directory);
    assert.equal(output(collision), "second");
    assert.equal(snapshots.size, 1);
  }));

test("partial reads union provenance for the same full normalized snapshot", () =>
  withDirectory(async (directory) => {
    await writeFile(path.join(directory, "partial.txt"), "a\nb\nc\nd");
    const snapshots = new SnapshotStore();
    const tool = createHashlineReadTool(directory, snapshots);
    const first = await execute(
      tool,
      { path: "partial.txt", limit: 1 },
      directory,
    );
    const second = await execute(
      tool,
      { path: "partial.txt", offset: 3, limit: 1 },
      directory,
    );
    const firstTag = output(first).match(/#([0-9A-F]{16})/)?.[1];
    const secondTag = output(second).match(/#([0-9A-F]{16})/)?.[1];
    assert.equal(firstTag, secondTag);
    assert.deepEqual(
      [...snapshots.getForPreview("partial.txt", firstTag!)!.seenLines],
      [1, 3],
    );
  }));
