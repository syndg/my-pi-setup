import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  emptyGovernorState,
  type GovernorState,
} from "../shared/context-governor-state.ts";
import type { ComparisonAudit } from "./src/governor.ts";
import {
  createTelemetryWriter,
  telemetryFilePath,
  telemetryRecord,
} from "./src/telemetry.ts";

function state(sequence: number): GovernorState {
  return {
    ...emptyGovernorState(),
    capturedAtMs: sequence,
    sessionId: "session-a",
    branchLeafId: `leaf-${sequence}`,
    model: {
      provider: "provider",
      id: "model",
      contextWindow: 100_000,
    },
    measurement: {
      tokens: 50_000 + sequence,
      contextWindow: 100_000,
      percent: 50,
      source: "pi-usage",
    },
    budget: {
      nativeLimitTokens: 85_000,
      nativeSource: "threshold-percent",
      nativeProactiveEnabled: true,
      advisoryLimitTokens: 70_000,
      effectiveSafeLimitTokens: 70_000,
      effectiveSource: "minimum-of-governor-and-native",
    },
    headroomTokens: 20_000 - sequence,
    safeLimitRatio: 0.71,
    growth: {
      latestTokens: 10_000,
      ewmaTokens: 9_000,
      p95Tokens: 12_000,
      conservativeTokens: 12_000,
      sampleCount: sequence,
    },
    runwayRuns: 1.5,
    pressure: { level: "orange", reasons: ["bounded reason"] },
    toolResultBytesByTool: { read: 2_048, rg: 1_024 },
  };
}

function audit(
  sequence: number,
  overrides: Partial<ComparisonAudit> = {},
): ComparisonAudit {
  return {
    eventKind: "run-settled",
    comparisonGeneration: sequence,
    comparisonResetReason: "session-start",
    runStartBaselineTokens: 40_000,
    baselineSource: "run-start",
    peakTokens: 50_000 + sequence,
    endpointTokens: 49_000 + sequence,
    growthSampleAccepted: true,
    ...overrides,
  };
}

test("telemetry is writer-scoped within a session, body-free, and bounded by records and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-governor-"));
  const writer = createTelemetryWriter({
    enabled: true,
    directory,
    sessionId: "session/a",
    writerId: "writer:1",
    maxRecords: 3,
    maxBytes: 4_096,
  });

  for (let sequence = 1; sequence <= 5; sequence += 1) {
    writer.append(state(sequence), audit(sequence));
  }
  await writer.flush();

  assert.equal(
    writer.path,
    telemetryFilePath(directory, "session/a", "writer:1"),
  );
  assert.equal(writer.path, join(directory, "session_a.writer_1.jsonl"));
  assert.equal(
    telemetryFilePath(directory, "session/a"),
    join(directory, `session_a.${process.pid}.jsonl`),
  );
  const content = await readFile(writer.path, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(Buffer.byteLength(content, "utf8") <= 4_096);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).timestampMs),
    [3, 4, 5],
  );
  assert.equal(content.includes("message body"), false);
  assert.equal(content.includes("tool arguments"), false);
  assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
});

test("independent writers for one session do not clobber each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-governor-writers-"));
  const first = createTelemetryWriter({
    enabled: true,
    directory,
    sessionId: "shared-session",
    writerId: "process-101",
    maxRecords: 2,
    maxBytes: 4_096,
  });
  const second = createTelemetryWriter({
    enabled: true,
    directory,
    sessionId: "shared-session",
    writerId: "process-202",
    maxRecords: 2,
    maxBytes: 4_096,
  });

  first.append(state(1), audit(1));
  first.append(state(2), audit(2));
  second.append(state(101), audit(101));
  second.append(state(102), audit(102));
  await Promise.all([first.flush(), second.flush()]);

  assert.notEqual(first.path, second.path);
  const [firstContent, secondContent] = await Promise.all([
    readFile(first.path, "utf8"),
    readFile(second.path, "utf8"),
  ]);
  assert.deepEqual(
    firstContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).timestampMs),
    [1, 2],
  );
  assert.deepEqual(
    secondContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).timestampMs),
    [101, 102],
  );
});

test("telemetry projection contains metrics only and bounds attacker-controlled labels", () => {
  const projected = telemetryRecord(
    {
      ...state(1),
      sessionId: `session-${"x".repeat(1_000)}`,
      pressure: {
        level: "yellow",
        reasons: ["reason\u0000".repeat(100)],
      },
      toolResultBytesByTool: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `tool-${index}-${"x".repeat(100)}`,
          index,
        ]),
      ),
    },
    audit(7, {
      comparisonResetReason: "compaction",
      runStartBaselineTokens: 15_247,
      peakTokens: 21_000,
      endpointTokens: 20_000,
    }),
  );

  const encoded = JSON.stringify(projected);
  assert.ok(projected.sessionId.length <= 120);
  assert.ok(projected.pressure.reasons[0]?.length <= 160);
  assert.ok(Object.keys(projected.toolResultBytesByTool).length <= 64);
  assert.equal(projected.eventKind, "run-settled");
  assert.equal(projected.comparisonGeneration, 7);
  assert.equal(projected.comparisonResetReason, "compaction");
  assert.equal(projected.runStartBaselineTokens, 15_247);
  assert.equal(projected.peakTokens, 21_000);
  assert.equal(projected.endpointTokens, 20_000);
  assert.equal(projected.growthSampleAccepted, true);
  assert.equal(encoded.includes("content"), false);
  assert.equal(encoded.includes("arguments"), false);
  assert.equal(encoded.includes("details"), false);
});

test("telemetry I/O failures are fail-open", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-governor-failure-"));
  const file = join(root, "not-a-directory");
  await writeFile(file, "occupied", "utf8");
  const writer = createTelemetryWriter({
    enabled: true,
    directory: join(file, "telemetry"),
    sessionId: "session-a",
    maxRecords: 2,
    maxBytes: 1_024,
  });

  writer.append(state(1), audit(1));
  await assert.doesNotReject(writer.flush());
});
