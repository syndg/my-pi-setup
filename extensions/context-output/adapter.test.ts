import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createContextArchive,
  createOutputBroker,
  identityRedactor,
  type ContextArchive,
} from "../context-archive/src/index.ts";
import { brokerToolResult } from "./src/adapter.ts";
import { parseContextOutputConfig } from "./src/config.ts";

function event(
  text: string,
  isError = false,
  details: unknown = { keep: true },
) {
  return {
    type: "tool_result" as const,
    toolName: "read",
    toolCallId: "call-1",
    input: {},
    content: [
      { type: "text" as const, text },
      { type: "image" as const, data: "image-data", mimeType: "image/png" },
    ],
    details,
    isError,
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "context-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = createContextArchive({
    rootDirectory: root,
    sessionId: "session",
    redactor: identityRedactor,
    idGenerator: () => "artifact-1",
  });
  return { archive, broker: createOutputBroker({ archive }) };
}

for (const [pressure, limit] of [
  ["green", 20 * 1024],
  ["yellow", 14 * 1024],
  ["orange", 8 * 1024],
  ["red", 4 * 1024],
] as const) {
  test(`${pressure} cap is observed in shadow and enforced only when enabled`, async (t) => {
    const { broker } = await fixture(t);
    const oversized = "x".repeat(limit + 1);
    const shadow = await brokerToolResult({
      event: event(oversized),
      outputClass: "read",
      pressure,
      mode: "shadow",
      broker,
    });
    assert.equal(shadow.patch, undefined);
    assert.equal(shadow.observation.outcome, "would-shorten");
    const enforced = await brokerToolResult({
      event: event(oversized),
      outputClass: "read",
      pressure,
      mode: "enforce",
      broker,
    });
    assert.equal(enforced.observation.outcome, "shortened");
    assert.deepEqual(enforced.patch?.content.at(-1), {
      type: "image",
      data: "image-data",
      mimeType: "image/png",
    });
    assert.equal(enforced.envelope?.artifact === null, false);
    assert.equal((enforced.patch?.details as any).keep, true);
    assert.equal(
      (enforced.patch?.details as any).contextArtifact.uri,
      enforced.envelope?.artifact?.reference.uri,
    );
  });
}

test("shadow observations honor private broker budget overrides", async (t) => {
  const { archive } = await fixture(t);
  const brokerConfig = { budgets: { read: { red: 100 } } };
  const broker = createOutputBroker({ archive, config: brokerConfig });
  const result = await brokerToolResult({
    event: event("x".repeat(101)),
    outputClass: "read",
    pressure: "red",
    mode: "shadow",
    broker,
    brokerConfig,
  });
  assert.equal(result.observation.outcome, "would-shorten");
  assert.equal(result.observation.appliedLimitBytes, 100);
});

test("archive commits complete text before replacement and fail-open never shortens", async (t) => {
  const { broker } = await fixture(t);
  const raw = "complete".repeat(1000);
  const result = await brokerToolResult({
    event: event(raw),
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker,
  });
  assert.equal(
    await readFile(result.envelope!.artifact!.reference.path, "utf8"),
    raw,
  );

  const failed: ContextArchive = {
    async store() {
      throw new Error("disk down");
    },
    async recall() {
      throw new Error("unused");
    },
    async query() {
      return { artifacts: [], matched: 0, limited: false };
    },
  };
  const open = await brokerToolResult({
    event: event(raw),
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker: createOutputBroker({ archive: failed }),
  });
  assert.equal(open.patch, undefined);
  assert.equal(open.observation.outcome, "fail-open");
});

test("error byte boundary stays exact; one byte over archives before shortening", async (t) => {
  const { broker } = await fixture(t);
  const exactText = "é".repeat(4 * 1024);
  const exactEvent = event(exactText, true);
  const exact = await brokerToolResult({
    event: exactEvent,
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker,
  });
  assert.equal(exact.patch, undefined);
  assert.equal(exact.envelope, undefined);
  assert.equal(exact.observation.outcome, "error-preserved");
  assert.equal(exact.observation.appliedLimitBytes, 8 * 1024);

  const oversizedText = `${exactText}x`;
  const oversized = await brokerToolResult({
    event: event(oversizedText, true),
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker,
  });
  assert.equal(oversized.observation.outcome, "shortened");
  assert.equal(
    await readFile(oversized.envelope!.artifact!.reference.path, "utf8"),
    oversizedText,
  );
  const synopsis = oversized.patch!.content.find(
    (block) => block.type === "text",
  )?.text;
  assert.ok(synopsis);
  assert.ok(Buffer.byteLength(synopsis, "utf8") <= 8 * 1024);
  assert.match(synopsis, /Oversized tool error archived/);
  assert.match(synopsis, /Error synopsis:/);
  assert.match(synopsis, /context_recall.*context:\/\//);
});

test("huge textual errors preserve error state, usage, and every image block", async (t) => {
  const { broker } = await fixture(t);
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    cost: {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.3,
      cacheWrite: 0.4,
      total: 1,
    },
  };
  const source = event(`fatal: root cause\n${"trace\n".repeat(400_000)}`, true);
  source.content.splice(1, 0, {
    type: "image",
    data: "second-image",
    mimeType: "image/jpeg",
  });
  const withUsage = { ...source, toolName: "unconfigured_failure_tool", usage };
  const result = await brokerToolResult({
    event: withUsage,
    outputClass: null,
    pressure: "red",
    mode: "enforce",
    broker,
  });
  assert.equal(result.patch?.isError, true);
  assert.strictEqual(result.patch?.usage, usage);
  assert.deepEqual(
    result.patch?.content.filter((block) => block.type === "image"),
    [
      { type: "image", data: "second-image", mimeType: "image/jpeg" },
      { type: "image", data: "image-data", mimeType: "image/png" },
    ],
  );
  assert.equal(
    result.envelope?.artifact?.metadata.sourceMetadata.isError,
    true,
  );
  assert.equal(result.observation.outputClass, "mcp-result");
  assert.ok(result.observation.inputBytes > 1_000_000);
  assert.ok(result.observation.deliveredBytes <= 8 * 1024);
});

test("oversized error archive failure returns the exact original without a patch", async () => {
  const failed: ContextArchive = {
    async store() {
      throw new Error("error archive unavailable");
    },
    async recall() {
      throw new Error("unused");
    },
    async query() {
      return { artifacts: [], matched: 0, limited: false };
    },
  };
  const raw = `fatal\u0000\u001b[31m${"never lose this".repeat(1000)}`;
  const original = event(raw, true);
  const result = await brokerToolResult({
    event: original,
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker: createOutputBroker({ archive: failed }),
  });
  assert.equal(result.patch, undefined);
  assert.equal(result.envelope?.output, raw);
  assert.equal(result.observation.outcome, "fail-open");
  assert.equal(result.observation.deliveredBytes, Buffer.byteLength(raw));
  assert.equal(result.observation.bytesSaved, 0);
  assert.equal(result.observation.failOpen, true);
});

test("producer details artifacts and spill references survive error brokerage", async (t) => {
  const { broker } = await fixture(t);
  const producerArtifact = {
    id: "producer-1",
    uri: "context://producer/reference",
  };
  const details = {
    keep: true,
    contextArtifact: producerArtifact,
    spillPath: "/tmp/producer-full-error.log",
  };
  const result = await brokerToolResult({
    event: event("error".repeat(3_000), true, details),
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker,
  });
  const patched = result.patch?.details as Record<string, unknown>;
  assert.strictEqual(patched.contextArtifact, producerArtifact);
  assert.equal(patched.spillPath, details.spillPath);
  assert.equal(
    (patched.contextOutputArtifact as any).uri,
    result.envelope?.artifact?.reference.uri,
  );
});

test("error observations are pressure-aware and report count-only savings telemetry", async (t) => {
  const { archive } = await fixture(t);
  const defaults = parseContextOutputConfig(undefined).errors.limitsBytes;
  assert.ok(defaults.green >= 20 * 1024);
  assert.ok(defaults.green > defaults.yellow);
  assert.ok(defaults.yellow > defaults.orange);
  assert.ok(defaults.orange > defaults.red);
  const config = parseContextOutputConfig({
    errors: {
      hardCeilingBytes: 2_000,
      limitsBytes: { green: 5_000, yellow: 1_500, orange: 1_000, red: 500 },
    },
  });
  assert.deepEqual(config.errors.limitsBytes, {
    green: 2_000,
    yellow: 1_500,
    orange: 1_000,
    red: 500,
  });
  const errorBroker = createOutputBroker({
    archive,
    config: { hardCeilingBytes: config.errors.hardCeilingBytes },
  });
  const raw = "telemetry-error".repeat(100);
  const shadow = await brokerToolResult({
    event: event(raw, true),
    outputClass: "read",
    pressure: "red",
    mode: "shadow",
    broker: errorBroker,
    errorBroker,
    errorConfig: config.errors,
  });
  assert.equal(shadow.patch, undefined);
  assert.equal(shadow.observation.outcome, "would-shorten");
  assert.equal(
    shadow.observation.deliveredBytes,
    shadow.observation.inputBytes,
  );
  assert.equal(shadow.observation.artifactStored, false);

  const enforced = await brokerToolResult({
    event: event(raw, true),
    outputClass: "read",
    pressure: "red",
    mode: "enforce",
    broker: errorBroker,
    errorBroker,
    errorConfig: config.errors,
  });
  assert.deepEqual(
    {
      isError: enforced.observation.isError,
      limit: enforced.observation.appliedLimitBytes,
      stored: enforced.observation.artifactStored,
      failOpen: enforced.observation.failOpen,
    },
    { isError: true, limit: 500, stored: true, failOpen: false },
  );
  assert.equal(
    enforced.observation.bytesSaved,
    enforced.observation.inputBytes - enforced.observation.deliveredBytes,
  );
  assert.ok(enforced.observation.deliveredBytes <= 500);
  const compactSynopsis = enforced.patch?.content.find(
    (block) => block.type === "text",
  )?.text;
  assert.ok(compactSynopsis);
  assert.match(compactSynopsis, /Oversized error/);
  assert.match(compactSynopsis, /context_recall.*context:\/\//);
});
