import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  createContextCompactionExtension,
  CONTEXT_COMPACTION_METRICS_ENTRY,
} from "./index.ts";
import { parseContextCompactionConfig } from "./src/config.ts";
import type {
  CheckpointSummaryModel,
  SummaryModelRequest,
} from "./src/types.ts";

const checkpoint = readFileSync(
  new URL("./fixtures/model-checkpoint.json", import.meta.url),
  "utf8",
);
const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const message = (value: unknown) => value as AgentMessage;
const entries = [
  {
    type: "message",
    id: "u0",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: message({ role: "user", content: "Goal", timestamp: 0 }),
  },
  {
    type: "message",
    id: "a0",
    parentId: "u0",
    timestamp: new Date(1).toISOString(),
    message: message({
      role: "assistant",
      content: [{ type: "text", text: "old" }],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 1,
    }),
  },
  {
    type: "message",
    id: "u1",
    parentId: "a0",
    timestamp: new Date(2).toISOString(),
    message: message({ role: "user", content: "Current task", timestamp: 2 }),
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: new Date(3).toISOString(),
    message: message({
      role: "assistant",
      content: [{ type: "text", text: "recent" }],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 3,
    }),
  },
] as SessionEntry[];

class Model implements CheckpointSummaryModel {
  requests: SummaryModelRequest[] = [];
  readonly output: string;
  constructor(output = checkpoint) {
    this.output = output;
  }
  async summarize(request: SummaryModelRequest) {
    this.requests.push(request);
    return { text: this.output, usage };
  }
}

class Pi {
  events = createEventBus();
  handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  entries: Array<{ type: string; data: unknown }> = [];
  on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
    this.handlers.set(name, handler);
  }
  appendEntry(type: string, data: unknown) {
    this.entries.push({ type, data });
  }
  async emit(name: string, event: unknown, ctx: unknown = {}) {
    return this.handlers.get(name)?.(event, ctx);
  }
}

function event(
  reason: "manual" | "threshold" | "overflow",
  signal = new AbortController().signal,
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "u1",
      messagesToSummarize: [
        entries[0]!.type === "message" ? entries[0].message : message({}),
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 50_000,
      previousSummary: undefined,
      fileOps: {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
      },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    },
    branchEntries: entries,
    reason,
    willRetry: reason === "overflow",
    signal,
  };
}

const config = parseContextCompactionConfig({
  manual: { custom: true },
  threshold: { custom: true, observationOptIn: true },
  overflow: { experimentalCustom: false },
  retainedBoundary: { minimumTokens: 1, targetTokens: 2, maximumTokens: 100 },
  metrics: {
    emitEvents: true,
    appendEntries: true,
    maximumEntriesPerSession: 2,
  },
});
const ctx = {
  modelRegistry: {},
  sessionManager: { getSessionId: () => "session" },
};

async function started(model: CheckpointSummaryModel, selected = config) {
  const pi = new Pi();
  createContextCompactionExtension({ config: selected, model, now: () => 123 })(
    pi as unknown as ExtensionAPI,
  );
  await pi.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    ctx,
  );
  return pi;
}

test("registers lifecycle, customizes manual and opted-in threshold, but leaves overflow native", async () => {
  const model = new Model();
  const pi = await started(model);
  for (const reason of ["manual", "threshold"] as const) {
    const result = await pi.emit("session_before_compact", event(reason));
    assert.ok((result as { compaction?: unknown } | undefined)?.compaction);
  }
  assert.equal(
    await pi.emit("session_before_compact", event("overflow")),
    undefined,
  );
  assert.equal(model.requests.length, 2);
  assert.ok(pi.handlers.has("session_compact"));
});

test("all adapter failures and aborts return undefined for native fallback", async () => {
  const malformed = await started(new Model("not json"));
  assert.equal(
    await malformed.emit("session_before_compact", event("manual")),
    undefined,
  );
  const controller = new AbortController();
  controller.abort();
  const aborted = await started(new Model());
  assert.equal(
    await aborted.emit(
      "session_before_compact",
      event("manual", controller.signal),
    ),
    undefined,
  );
  const missing = event("manual");
  missing.preparation.firstKeptEntryId = "missing";
  assert.equal(
    await aborted.emit("session_before_compact", missing),
    undefined,
  );
});

test("persists summary usage and observes post-reconstruction metrics without queue mutation", async () => {
  const pi = await started(new Model());
  const before = JSON.stringify(entries);
  const hook = (await pi.emit("session_before_compact", event("manual"))) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      usage: typeof usage;
    };
  };
  assert.equal(hook.compaction.usage.totalTokens, 12);
  await pi.emit("session_compact", {
    type: "session_compact",
    reason: "manual",
    willRetry: false,
    fromExtension: true,
    compactionEntry: {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      ...hook.compaction,
      fromHook: true,
    },
  });
  assert.equal(JSON.stringify(entries), before);
  assert.equal(pi.entries[0]?.type, CONTEXT_COMPACTION_METRICS_ENTRY);
  assert.equal(
    (pi.entries[0]?.data as { reconstructionValid: boolean })
      .reconstructionValid,
    true,
  );
});
