import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCacheTelemetryWriter } from "./src/telemetry.ts";
import type { CacheRunRecord } from "./src/types.ts";

function record(index: number): CacheRunRecord {
  return {
    schemaVersion: 1,
    timestampMs: index,
    sessionId: "session",
    runId: `run-${index}`,
    boundary: null,
    providers: [
      {
        provider: "provider",
        api: "anthropic-messages",
        model: "model",
        requests: 1,
        input: index,
        output: 1,
        cacheRead: index,
        cacheWrite: 0,
        cacheReadAvailability: "reported",
        cacheWriteAvailability: "reported",
      },
    ],
    cacheRatio: 0.5,
    prefix: {
      samples: 1,
      changes: 0,
      additiveChanges: 0,
      nonAdditiveChanges: 0,
      unexplainedChanges: 0,
      latestPrefixBytes: 100,
    },
    additiveActivations: [],
    decayEpochs: [],
  };
}

test("telemetry is bounded, process-isolated, mode 0600, and serializes concurrent appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-cache-"));
  try {
    const options = {
      enabled: true,
      directory: root,
      sessionId: "session",
      maxRecords: 7,
      maxBytes: 4096,
    };
    const first = createCacheTelemetryWriter({
      ...options,
      writerId: "process-a",
    });
    const second = createCacheTelemetryWriter({
      ...options,
      writerId: "process-b",
    });
    for (let index = 0; index < 30; index += 1) {
      first.append(record(index));
      second.append(record(100 + index));
    }
    await Promise.all([first.flush(), second.flush()]);
    assert.notEqual(first.path, second.path);
    for (const path of [first.path, second.path]) {
      const content = await readFile(path, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      assert.ok(lines.length <= 7);
      assert.ok(Buffer.byteLength(content) <= 4096);
      assert.doesNotThrow(() => lines.map((line) => JSON.parse(line)));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry failures and disabled telemetry fail open", async () => {
  const writer = createCacheTelemetryWriter({
    enabled: false,
    directory: "/not-used",
    sessionId: "session",
    maxRecords: 1,
    maxBytes: 1,
  });
  assert.doesNotThrow(() => writer.append(record(1)));
  await assert.doesNotReject(writer.flush());
});
