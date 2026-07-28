import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createContextArchive,
  createOutputBroker,
  identityRedactor,
  type ArchiveQueryResult,
  type ArtifactMetadata,
  type ContextArchive,
  type RecallResult,
  type StoredArtifact,
} from "./src/index.ts";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "output-broker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeArtifact(content = "preview"): StoredArtifact {
  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    id: "fake-1",
    sessionScope: "0123456789abcdef01234567",
    createdAtMs: 1,
    toolName: "read",
    outputClass: "read",
    tags: [],
    synopsis: "safe synopsis",
    originalBytes: 99,
    storedBytes: Buffer.byteLength(content),
    storedLines: 1,
    storedSha256: "0".repeat(64),
    redactionCount: 0,
    sourceMetadata: {},
  };
  return {
    reference: {
      id: metadata.id,
      sessionScope: metadata.sessionScope,
      uri: `context://${metadata.sessionScope}/${metadata.id}`,
      path: `/safe/${metadata.sessionScope}/${metadata.id}/content.txt`,
    },
    metadata,
  };
}

function fakeRecall(
  artifact: StoredArtifact,
  content = "preview",
): RecallResult {
  return {
    reference: artifact.reference,
    metadata: artifact.metadata,
    content,
    returnedBytes: Buffer.byteLength(content),
    range: { startByte: 0, endByte: Buffer.byteLength(content) },
    truncated: false,
    next: null,
  };
}

const emptyQuery: ArchiveQueryResult = {
  artifacts: [],
  matched: 0,
  limited: false,
};

test("preserves output exactly at the byte boundary and archives one byte over", async (t) => {
  const root = await temporaryRoot(t);
  let nextId = 0;
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "boundary",
    redactor: identityRedactor,
    idGenerator: () => `boundary-${++nextId}`,
  });
  const broker = createOutputBroker({ archive });
  const exact = "x".repeat(20 * 1024);
  const inline = await broker.process({
    toolName: "read",
    pressure: "green",
    rawOutput: exact,
  });
  assert.equal(inline.disposition, "inline");
  assert.equal(inline.output, exact);
  assert.equal(inline.artifact, null);

  const oversized = `${exact}x`;
  const archived = await broker.process({
    toolName: "read",
    pressure: "green",
    rawOutput: oversized,
  });
  assert.equal(archived.disposition, "archived");
  assert.equal(archived.shortened, true);
  assert.ok(archived.artifact !== null);
  assert.ok(Buffer.byteLength(archived.output) <= 20 * 1024);
  assert.equal(
    await readFile(archived.artifact.reference.path, "utf8"),
    oversized,
  );
  assert.match(archived.output, /Artifact: context:\/\//);
  assert.match(archived.retrievalInstructions ?? "", /ContextArchive\.recall/);
});

test("awaits durable store before constructing or returning a replacement", async () => {
  const events: string[] = [];
  const artifact = fakeArtifact();
  let releaseStore = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseStore = resolve;
  });
  const archive: ContextArchive = {
    async store() {
      events.push("store-start");
      await gate;
      events.push("store-committed");
      return artifact;
    },
    async recall() {
      events.push("recall");
      return fakeRecall(artifact);
    },
    async query() {
      return emptyQuery;
    },
  };
  const broker = createOutputBroker({ archive });
  let settled = false;
  const pending = broker
    .process({
      toolName: "read",
      pressure: "red",
      explicitLimitBytes: 1_000,
      rawOutput: "x".repeat(2_000),
    })
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["store-start"]);
  assert.equal(settled, false);

  releaseStore();
  const result = await pending;
  assert.deepEqual(events, ["store-start", "store-committed", "recall"]);
  assert.equal(result.disposition, "archived");
});

test("persistence failure fails open with exact raw output and explicit metrics", async () => {
  const raw = "never lose me\u0000\u001b[31m";
  const archive: ContextArchive = {
    async store() {
      throw new Error("disk unavailable");
    },
    async recall() {
      throw new Error("unexpected");
    },
    async query() {
      return emptyQuery;
    },
  };
  const broker = createOutputBroker({ archive });
  const result = await broker.process({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 1,
    rawOutput: raw,
  });
  assert.equal(result.disposition, "fail-open");
  assert.equal(result.output, raw);
  assert.equal(result.shortened, false);
  assert.match(result.persistenceError ?? "", /disk unavailable/);
  assert.equal(result.metrics.bytesSaved, 0);
  assert.equal(result.metrics.estimatedTokensSaved, 0);
  assert.equal(result.metrics.failOpen, true);
});

test("recall failure after a committed store also returns raw output with its artifact", async () => {
  const artifact = fakeArtifact();
  const archive: ContextArchive = {
    async store() {
      return artifact;
    },
    async recall() {
      throw new Error("recall read failed");
    },
    async query() {
      return emptyQuery;
    },
  };
  const raw = "z".repeat(2_000);
  const result = await createOutputBroker({ archive }).process({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 1_000,
    rawOutput: raw,
  });
  assert.equal(result.disposition, "fail-open");
  assert.equal(result.output, raw);
  assert.equal(result.artifact?.reference.id, "fake-1");
  assert.equal(result.metrics.artifactStored, true);
});

test("oversized previews are secret-redacted, terminal-safe, UTF-8-safe, and capped", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "safe-output",
    idGenerator: () => "safe-output-1",
  });
  const broker = createOutputBroker({ archive });
  const secret = "sk-abcdefghijklmnop";
  const raw = `\u001b[31m😀 ${secret} line\u0000\n${"é".repeat(2_000)}`;
  const result = await broker.process({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 900,
    rawOutput: raw,
  });
  assert.equal(result.disposition, "archived");
  assert.ok(Buffer.byteLength(result.output) <= 900);
  assert.equal(result.output.includes(secret), false);
  assert.equal(result.output.includes("\u001b"), false);
  assert.equal(result.output.includes("\u0000"), false);
  assert.ok(result.artifact !== null);
  const stored = await readFile(result.artifact.reference.path, "utf8");
  assert.equal(stored.includes(secret), false);
  assert.equal(stored.includes("[REDACTED]"), true);
});

test("reports bytes and token savings through both envelope and metrics seam", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "metrics",
    redactor: identityRedactor,
    idGenerator: () => "metrics-1",
  });
  const observed: unknown[] = [];
  const raw = "a".repeat(4_000);
  const result = await createOutputBroker({
    archive,
    estimateTokens: (value) => value.length,
    onMetrics: (metrics) => observed.push(metrics),
  }).process({
    toolName: "rg",
    pressure: "red",
    explicitLimitBytes: 800,
    rawOutput: raw,
  });
  assert.equal(observed.length, 1);
  assert.strictEqual(observed[0], result.metrics);
  assert.equal(result.metrics.inputBytes, 4_000);
  assert.equal(result.metrics.deliveredBytes, Buffer.byteLength(result.output));
  assert.equal(
    result.metrics.bytesSaved,
    4_000 - result.metrics.deliveredBytes,
  );
  assert.equal(result.metrics.estimatedInputTokens, 4_000);
  assert.equal(
    result.metrics.estimatedTokensSaved,
    4_000 - result.output.length,
  );
});

test("Red background completion stores full output and returns status-only payload", async (t) => {
  const root = await temporaryRoot(t);
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "background",
    redactor: identityRedactor,
    idGenerator: () => "background-1",
  });
  const result = await createOutputBroker({ archive }).process({
    toolName: "bg_status",
    outputClass: "background-completion",
    pressure: "red",
    rawOutput: "complete log",
  });
  assert.equal(result.budget.appliedLimitBytes, 0);
  assert.equal(result.output, "");
  assert.equal(result.disposition, "archived");
  assert.equal(result.artifact?.metadata.storedBytes, 12);
});

test("a real atomic filesystem failure never replaces output", async (t) => {
  const root = await temporaryRoot(t);
  const rootFile = join(root, "not-a-directory");
  await writeFile(rootFile, "occupied", "utf8");
  const archive = createContextArchive({
    rootDirectory: rootFile,
    sessionId: "atomic-failure",
    idGenerator: () => "failure-1",
  });
  const raw = "full output survives";
  const result = await createOutputBroker({ archive }).process({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 1,
    rawOutput: raw,
  });
  assert.equal(result.disposition, "fail-open");
  assert.equal(result.output, raw);
  assert.equal(await readFile(rootFile, "utf8"), "occupied");
});
