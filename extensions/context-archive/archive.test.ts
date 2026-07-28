import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createContextArchive,
  identityRedactor,
  sessionScopeFor,
  type Redactor,
} from "./src/index.ts";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("stores a complete redacted artifact atomically with safe session paths and URI", async (t) => {
  const root = await temporaryRoot(t);
  const sessionId = "../../session/with secrets and spaces";
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId,
    idGenerator: () => "artifact-001",
    clock: () => 1234,
  });
  const secret = "sk-abcdefghijklmnop";
  const stored = await archive.store({
    content: `first line\n${secret}\nTOKEN=supersecret\nlast 😀`,
    toolName: "read\u0000\u001b[31m",
    outputClass: "read",
    tags: ["fixture", "fixture"],
    metadata: { password: "metadata-secret", note: `contains ${secret}` },
  });

  const scope = sessionScopeFor(sessionId);
  assert.equal(stored.reference.sessionScope, scope);
  assert.equal(stored.reference.uri, `context://${scope}/artifact-001`);
  assert.ok(stored.reference.path.startsWith(join(root, scope, "artifacts")));
  assert.equal(
    stored.metadata.originalBytes > stored.metadata.storedBytes,
    true,
  );
  assert.equal(stored.metadata.redactionCount, 4);
  assert.deepEqual(stored.metadata.tags, ["fixture"]);
  assert.equal(stored.metadata.sourceMetadata.password, "[REDACTED]");

  const content = await readFile(stored.reference.path, "utf8");
  assert.equal(content.includes(secret), false);
  assert.equal(content.includes("supersecret"), false);
  assert.equal(content.includes("last 😀"), true);
  assert.equal((await stat(stored.reference.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, scope))).mode & 0o777, 0o700);

  const recalled = await archive.recall({ artifact: stored.reference.uri });
  assert.equal(recalled.content, content);
  assert.equal(recalled.truncated, false);
  assert.equal(recalled.next, null);
});

test("custom redaction seam transforms content and metadata before persistence", async (t) => {
  const root = await temporaryRoot(t);
  const calls: string[] = [];
  const redactor: Redactor = ({ content, metadata }) => {
    calls.push(content);
    return {
      content: content.replaceAll("classified", "[CUSTOM]"),
      metadata: { ...metadata, owner: "[CUSTOM]" },
      redactionCount: 2,
    };
  };
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "redaction",
    redactor,
    idGenerator: () => "custom-1",
  });
  const artifact = await archive.store({
    content: "classified output",
    toolName: "mcp",
    outputClass: "mcp-result",
    metadata: { owner: "classified" },
  });
  assert.deepEqual(calls, ["classified output"]);
  assert.equal(
    await readFile(artifact.reference.path, "utf8"),
    "[CUSTOM] output",
  );
  assert.equal(artifact.metadata.sourceMetadata.owner, "[CUSTOM]");
});

test("recall enforces UTF-8-safe byte bounds and terminal safety", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "slices",
    redactor: identityRedactor,
    idGenerator: () => "slice-1",
    defaultRecallBytes: 4,
    maximumRecallBytes: 5,
  });
  const artifact = await archive.store({
    content: "A😀B\u001b[31mC",
    toolName: "read",
    outputClass: "read",
  });

  const emoji = await archive.recall({
    artifact: artifact.reference.id,
    slice: { kind: "bytes", offsetBytes: 1, maxBytes: 4 },
  });
  assert.equal(emoji.content, "😀");
  assert.deepEqual(emoji.range, { startByte: 1, endByte: 5 });
  assert.equal(emoji.next?.offsetBytes, 5);

  const continuationOffset = await archive.recall({
    artifact: artifact.reference.id,
    slice: { kind: "bytes", offsetBytes: 2, maxBytes: 5 },
  });
  assert.equal(continuationOffset.range.startByte, 5);
  assert.equal(continuationOffset.content.startsWith("B"), true);
  assert.equal(continuationOffset.content.includes("\u001b"), false);
  assert.ok(continuationOffset.returnedBytes <= 5);
});

test("line recall is one-based, line-bounded, byte-bounded, and resumable", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "lines",
    redactor: identityRedactor,
    idGenerator: () => "lines-1",
    defaultRecallBytes: 100,
    maximumRecallBytes: 100,
    maximumRecallLines: 2,
  });
  const artifact = await archive.store({
    content: "one\ntwo\nthree\nfour",
    toolName: "read",
    outputClass: "read",
  });
  const recalled = await archive.recall({
    artifact: artifact.reference.uri,
    slice: { kind: "lines", startLine: 2, lineCount: 99 },
  });
  assert.equal(recalled.content, "two\nthree\n");
  assert.equal(recalled.range.startLine, 2);
  assert.equal(recalled.range.endLine, 3);
  assert.equal(recalled.truncated, true);
  assert.ok(recalled.next !== null);
});

test("query uses the session index with metadata, tags, ordering, and limits", async (t) => {
  const root = await temporaryRoot(t);
  const ids = ["query-1", "query-2", "query-3"];
  let time = 9;
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "query-session",
    redactor: identityRedactor,
    idGenerator: () => ids.shift() ?? "unexpected",
    clock: () => ++time,
    maximumQueryResults: 2,
  });
  await archive.store({
    content: "alpha content",
    toolName: "rg",
    outputClass: "search",
    tags: ["code"],
    metadata: { project: "atlas" },
  });
  await archive.store({
    content: "beta content",
    toolName: "read",
    outputClass: "read",
    tags: ["code", "typescript"],
    metadata: { project: "atlas" },
  });
  await archive.store({
    content: "gamma content",
    toolName: "read",
    outputClass: "read",
    tags: ["notes"],
    metadata: { project: "other" },
  });

  const filtered = await archive.query({
    outputClass: "read",
    tags: ["code"],
    text: "atlas",
  });
  assert.equal(filtered.matched, 1);
  assert.equal(filtered.artifacts[0]?.reference.id, "query-2");

  const limited = await archive.query({ order: "oldest", limit: 99 });
  assert.equal(limited.matched, 3);
  assert.equal(limited.artifacts.length, 2);
  assert.equal(limited.limited, true);
  assert.deepEqual(
    limited.artifacts.map((item) => item.reference.id),
    ["query-1", "query-2"],
  );
});

test("rejects traversal, encoded paths, foreign-session URIs, and relative roots", async (t) => {
  const root = await temporaryRoot(t);
  assert.throws(
    () => createContextArchive({ rootDirectory: "relative", sessionId: "x" }),
    /absolute/,
  );
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "safe",
    idGenerator: () => "safe-1",
  });
  await archive.store({
    content: "safe",
    toolName: "read",
    outputClass: "read",
  });
  await assert.rejects(
    () => archive.recall({ artifact: "../safe-1" }),
    /safe artifact/,
  );
  await assert.rejects(
    () => archive.recall({ artifact: "%2e%2e%2fsafe-1" }),
    /safe artifact/,
  );
  await assert.rejects(
    () =>
      archive.recall({
        artifact: "context://000000000000000000000000/safe-1",
      }),
    /different session/,
  );
});

test("failed writes do not alter an existing committed artifact", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "collision",
    redactor: identityRedactor,
    idGenerator: () => "fixed-id",
  });
  const first = await archive.store({
    content: "durable first",
    toolName: "read",
    outputClass: "read",
  });
  await assert.rejects(
    () =>
      archive.store({
        content: "second",
        toolName: "read",
        outputClass: "read",
      }),
    /unique artifact ID/,
  );
  assert.equal(await readFile(first.reference.path, "utf8"), "durable first");
  const index = await readFile(
    join(root, first.reference.sessionScope, "index.jsonl"),
    "utf8",
  );
  assert.equal(index.trim().split("\n").length, 1);
});

test("integrity metadata detects content corruption", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "integrity",
    redactor: identityRedactor,
    idGenerator: () => "integrity-1",
  });
  const artifact = await archive.store({
    content: "complete",
    toolName: "read",
    outputClass: "read",
  });
  await writeFile(artifact.reference.path, "corrupt", "utf8");
  await assert.rejects(
    () => archive.recall({ artifact: artifact.reference.uri }),
    /integrity check failed/,
  );
});
