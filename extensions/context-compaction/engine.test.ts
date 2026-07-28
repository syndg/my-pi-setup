import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { parseCheckpoint } from "../context-checkpoints/src/index.ts";
import {
  CHECKPOINT_SUMMARY_SYSTEM_PROMPT,
  chooseRetainedBoundary,
  createContextCompactionPrototype,
  hasValidToolStructure,
  projectPostCompactionContext,
  resolveReasonPolicy,
  serializeBoundedCompactionInput,
  type CheckpointSummaryModel,
  type CompactionPrototypeInput,
  type CompactionTranscriptEntry,
  type SummaryModelRequest,
} from "./src/index.ts";

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function asMessage(value: unknown) {
  return value as AgentMessage;
}

function user(
  id: string,
  tokens: number,
  text = id,
): CompactionTranscriptEntry {
  return {
    id,
    estimatedTokens: tokens,
    message: asMessage({ role: "user", content: text, timestamp: 1 }),
  };
}

function assistant(
  id: string,
  tokens: number,
  options: {
    text?: string;
    call?: { id: string; name: string; arguments?: unknown };
  } = {},
): CompactionTranscriptEntry {
  const content: unknown[] = [];
  if (options.text !== undefined)
    content.push({ type: "text", text: options.text });
  if (options.call) {
    content.push({
      type: "toolCall",
      id: options.call.id,
      name: options.call.name,
      arguments: options.call.arguments ?? {},
    });
  }
  return {
    id,
    estimatedTokens: tokens,
    message: asMessage({
      role: "assistant",
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage: usage(0),
      stopReason: "stop",
      timestamp: 1,
    }),
  };
}

function result(
  id: string,
  tokens: number,
  callId: string,
  text = "ok",
): CompactionTranscriptEntry {
  return {
    id,
    estimatedTokens: tokens,
    message: asMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    }),
  };
}

function usage(input: number, output = 2): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  };
}

function standardEntries(): readonly CompactionTranscriptEntry[] {
  return [
    user("u0", 1_000, "Build structured compaction."),
    assistant("a0", 1_000, { text: "Investigating." }),
    user("u1", 1_000, "Preserve prior state."),
    assistant("a1", 1_000, { text: "Prior state preserved." }),
    user("u2", 5_000, "Continue implementation."),
    assistant("a2", 5_000, { text: "Recent work." }),
  ];
}

class FakeModel implements CheckpointSummaryModel {
  readonly requests: SummaryModelRequest[] = [];
  readonly text: string;
  readonly modelUsage: Usage | undefined;
  readonly error: Error | undefined;

  constructor(
    text: string,
    modelUsage: Usage | undefined = usage(10),
    error?: Error,
  ) {
    this.text = text;
    this.modelUsage = modelUsage;
    this.error = error;
  }

  async summarize(request: SummaryModelRequest) {
    this.requests.push(request);
    if (this.error) throw this.error;
    return { text: this.text, usage: this.modelUsage };
  }
}

function baseInput(
  overrides: Partial<CompactionPrototypeInput> = {},
): CompactionPrototypeInput {
  return {
    reason: "manual",
    entries: standardEntries(),
    tokensBefore: 50_000,
    previousCheckpoint: fixture("previous-checkpoint.json"),
    ...overrides,
  };
}

test("selects a valid retained boundary near 10K without cutting at a tool result", () => {
  const entries = [
    user("u0", 500),
    assistant("a0", 500),
    user("u1", 500),
    assistant("call", 1_000, { call: { id: "tc1", name: "read" } }),
    result("result", 7_000, "tc1"),
    assistant("suffix", 2_000, { text: "Use the result." }),
  ];
  const boundary = chooseRetainedBoundary(entries);
  assert.ok(boundary);
  assert.equal(boundary.firstKeptEntryId, "call");
  assert.equal(boundary.retainedEstimatedTokens, 10_000);
  assert.equal(boundary.isSplitTurn, true);
  assert.deepEqual(
    boundary.splitTurnPrefix.map((entry) => entry.id),
    ["u1"],
  );
  assert.equal(hasValidToolStructure(boundary.retainedSuffix), true);
  assert.notEqual(boundary.retainedSuffix[0]?.id, "result");
});

test("rejects an orphan-result transcript when no safe committed boundary exists", () => {
  const entries = [user("u0", 1), result("orphan", 10_000, "missing")];
  assert.equal(chooseRetainedBoundary(entries), undefined);
});

test("serializes bounded history, split prefix, retained preview, previous summary, and checkpoint", () => {
  const entries = [
    user("u0", 500, "request"),
    assistant("a0", 500, { text: "history" }),
    user("u1", 500, "split request"),
    assistant("call", 1_000, { call: { id: "tc1", name: "read" } }),
    result("result", 7_000, "tc1", "x".repeat(20_000)),
    assistant("suffix", 2_000, { text: "suffix" }),
  ];
  const boundary = chooseRetainedBoundary(entries)!;
  const previous = parseCheckpoint(fixture("previous-checkpoint.json"));
  assert.equal(previous.ok, true);
  if (!previous.ok) throw new Error("fixture invalid");
  const packet = serializeBoundedCompactionInput({
    input: baseInput({
      entries,
      previousSummary: "s".repeat(20_000),
      serialization: { totalBytes: 8_000, toolResultBytes: 500 },
    }),
    boundary,
    previousCheckpoint: previous.checkpoint,
  });
  assert.ok(packet.bytes <= 8_000);
  assert.match(packet.text, /previousSummary/);
  assert.match(packet.text, /previousCheckpointJson/);
  assert.match(packet.text, /splitTurnPrefix/);
  assert.match(packet.text, /retainedSuffixPreview/);
  assert.ok(packet.truncatedSections.length > 0);
});

test("uses the dedicated exact-JSON prompt and merges durable previous checkpoint state", async () => {
  const model = new FakeModel(fixture("model-checkpoint.json"));
  const decision = await createContextCompactionPrototype({ model }).compact(
    baseInput(),
  );
  assert.equal(decision.kind, "custom");
  if (decision.kind !== "custom") throw new Error("expected custom compaction");
  assert.equal(decision.source, "model");
  assert.equal(decision.result.firstKeptEntryId, "u2");
  assert.equal(decision.result.tokensBefore, 50_000);
  assert.equal(decision.result.usage?.input, 10);
  assert.ok(
    decision.checkpoint.completedWork.includes(
      "Stabilized the checkpoint schema.",
    ),
  );
  assert.ok(
    decision.checkpoint.completedWork.includes(
      "Implemented boundary selection.",
    ),
  );
  assert.ok(
    decision.checkpoint.constraintsAndPreferences.includes(
      "Preserve native overflow recovery.",
    ),
  );
  assert.equal(model.requests.length, 1);
  assert.equal(
    model.requests[0]?.systemPrompt,
    CHECKPOINT_SUMMARY_SYSTEM_PROMPT,
  );
  assert.match(
    model.requests[0]?.prompt ?? "",
    /Return exactly one JSON object|bounded compaction input/i,
  );
  assert.doesNotMatch(decision.result.summary, /```/);
  assert.equal(parseCheckpoint(decision.result.summary).ok, true);
});

test("recognizes a checkpoint-shaped previous summary and merges it", async () => {
  const model = new FakeModel(fixture("model-checkpoint.json"));
  const decision = await createContextCompactionPrototype({ model }).compact(
    baseInput({
      previousCheckpoint: undefined,
      previousSummary: fixture("previous-checkpoint.json"),
    }),
  );
  assert.equal(decision.kind, "custom");
  if (decision.kind !== "custom") throw new Error("expected custom compaction");
  assert.ok(
    decision.checkpoint.decisions.some(
      (item) => item.decision === "Use exact JSON.",
    ),
  );
  assert.match(model.requests[0]?.prompt ?? "", /previousCheckpointJson/);
});

test("malformed model output falls back locally while retaining incurred model usage", async () => {
  const model = new FakeModel(fixture("malformed-model-output.txt"), usage(12));
  const decision = await createContextCompactionPrototype({ model }).compact(
    baseInput(),
  );
  assert.equal(decision.kind, "custom");
  if (decision.kind !== "custom") throw new Error("expected custom compaction");
  assert.equal(decision.source, "local-fallback");
  assert.equal(decision.result.details?.source, "local-fallback");
  assert.equal(decision.result.usage?.input, 12);
  assert.ok(
    decision.checkpoint.completedWork.includes(
      "Stabilized the checkpoint schema.",
    ),
  );
  assert.match(decision.diagnostics.join("\n"), /Repair the checkpoint JSON/);
});

test("verifier rejection uses local fallback and aggregates verifier usage", async () => {
  const model = new FakeModel(fixture("model-checkpoint.json"), usage(10));
  const verifier = {
    async verify() {
      return {
        ok: false,
        message: "Missing continuation evidence.",
        usage: usage(3),
      };
    },
  };
  const decision = await createContextCompactionPrototype({
    model,
    verifier,
  }).compact(baseInput());
  assert.equal(decision.kind, "custom");
  if (decision.kind !== "custom") throw new Error("expected custom compaction");
  assert.equal(decision.source, "local-fallback");
  assert.equal(decision.result.details?.verifier, "failed");
  assert.equal(decision.result.usage?.input, 13);
  assert.equal(decision.result.usage?.totalTokens, 17);
});

test("reason policy covers manual, threshold, and overflow with native overflow safety", async () => {
  assert.deepEqual(resolveReasonPolicy("manual"), {
    reason: "manual",
    action: "custom",
    onFailure: "local",
  });
  assert.deepEqual(resolveReasonPolicy("threshold"), {
    reason: "threshold",
    action: "custom",
    onFailure: "local",
  });
  assert.deepEqual(resolveReasonPolicy("overflow"), {
    reason: "overflow",
    action: "native",
    onFailure: "native",
  });

  const model = new FakeModel(fixture("model-checkpoint.json"));
  const engine = createContextCompactionPrototype({ model });
  const manual = await engine.compact(baseInput({ reason: "manual" }));
  const threshold = await engine.compact(baseInput({ reason: "threshold" }));
  const overflow = await engine.compact(baseInput({ reason: "overflow" }));
  assert.equal(manual.kind, "custom");
  assert.equal(threshold.kind, "custom");
  assert.deepEqual(
    overflow.kind === "native-fallback"
      ? [overflow.code, overflow.message]
      : [],
    [
      "reason-policy",
      "overflow compaction remains assigned to native Pi recovery.",
    ],
  );
  assert.equal(model.requests.length, 2);
});

test("experimental overflow model failures still decide native fallback", async () => {
  const model = new FakeModel(fixture("malformed-model-output.txt"));
  const decision = await createContextCompactionPrototype({ model }).compact(
    baseInput({
      reason: "overflow",
      reasonPolicy: { overflow: { action: "custom", onFailure: "local" } },
    }),
  );
  assert.equal(decision.kind, "native-fallback");
  if (decision.kind !== "native-fallback")
    throw new Error("expected native fallback");
  assert.equal(decision.code, "malformed-model-output");
  assert.equal(model.requests.length, 1);
});

test("queued messages do not affect serialization, boundary choice, or result", async () => {
  const firstModel = new FakeModel(fixture("model-checkpoint.json"));
  const secondModel = new FakeModel(fixture("model-checkpoint.json"));
  const first = await createContextCompactionPrototype({
    model: firstModel,
  }).compact(baseInput({ queuedMessages: ["queue A"] }));
  const second = await createContextCompactionPrototype({
    model: secondModel,
  }).compact(
    baseInput({ queuedMessages: ["queue B", { secret: "not committed" }] }),
  );
  assert.equal(first.kind, "custom");
  assert.equal(second.kind, "custom");
  if (first.kind !== "custom" || second.kind !== "custom")
    throw new Error("expected custom");
  assert.equal(
    first.boundary.firstKeptEntryId,
    second.boundary.firstKeptEntryId,
  );
  assert.equal(firstModel.requests[0]?.prompt, secondModel.requests[0]?.prompt);
  assert.equal(first.result.summary, second.result.summary);
  assert.doesNotMatch(
    firstModel.requests[0]?.prompt ?? "",
    /queue A|queue B|secret/,
  );
});

test("post-compaction projection is checkpoint plus committed retained suffix only", async () => {
  const entries = standardEntries();
  const decision = await createContextCompactionPrototype({
    model: new FakeModel(fixture("model-checkpoint.json")),
  }).compact(baseInput({ entries, queuedMessages: [user("queued", 1)] }));
  assert.equal(decision.kind, "custom");
  if (decision.kind !== "custom") throw new Error("expected custom compaction");
  const reconstructed = projectPostCompactionContext(entries, decision.result);
  assert.equal(reconstructed.summary.schemaVersion, "context-checkpoint/v1");
  assert.equal(reconstructed.firstKeptEntryId, "u2");
  assert.deepEqual(
    reconstructed.retainedEntries.map((entry) => entry.id),
    ["u2", "a2"],
  );
  assert.ok(
    !reconstructed.retainedEntries.some((entry) => entry.id === "queued"),
  );
  assert.equal(
    decision.result.estimatedTokensAfter,
    Math.ceil(Buffer.byteLength(decision.result.summary, "utf8") / 4) + 10_000,
  );
});
