import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  CONTEXT_GOVERNOR_REFRESH_CHANNEL,
  isGovernorState,
  type GovernorState,
} from "../shared/context-governor-state.ts";
import contextGovernorExtension, {
  accumulateToolResultBytes,
  appendContextNotice,
} from "./index.ts";
import { DEFAULT_GOVERNOR_CONFIG } from "./src/config.ts";
import { createContextGovernor, resolveBudget } from "./src/governor.ts";
import {
  measureContext,
  normalizeNativeCompactionSettings,
  normalizeRuntimeCompactionThreshold,
  readNativeCompactionSettings,
} from "./src/measurement.ts";

type EventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

class FakePi {
  readonly handlers = new Map<string, EventHandler[]>();
  readonly commands = new Map<string, CommandHandler>();
  readonly published: GovernorState[] = [];
  readonly notifications: string[] = [];
  persistentWrites = 0;
  private readonly busHandlers = new Map<
    string,
    Set<(data: unknown) => void>
  >();

  readonly events = {
    emit: (channel: string, data: unknown) => {
      if (channel === CONTEXT_GOVERNOR_CHANNEL && isGovernorState(data)) {
        this.published.push(data);
      }
      for (const handler of this.busHandlers.get(channel) ?? []) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      const handlers = this.busHandlers.get(channel) ?? new Set();
      handlers.add(handler);
      this.busHandlers.set(channel, handlers);
      return () => handlers.delete(handler);
    },
  };

  on(name: string, handler: unknown) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler as EventHandler);
    this.handlers.set(name, handlers);
  }

  registerCommand(name: string, options: unknown) {
    if (
      typeof options === "object" &&
      options !== null &&
      "handler" in options &&
      typeof options.handler === "function"
    ) {
      this.commands.set(name, options.handler as CommandHandler);
    }
  }

  appendEntry() {
    this.persistentWrites += 1;
  }

  sendMessage() {
    this.persistentWrites += 1;
  }

  async emit(name: string, event: unknown, ctx: ExtensionContext) {
    let result: unknown;
    for (const handler of this.handlers.get(name) ?? []) {
      result = await handler(event, ctx);
    }
    return result;
  }
}

function resultMessages(value: unknown): AgentMessage[] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("messages" in value) ||
    !Array.isArray(value.messages)
  ) {
    return undefined;
  }
  return value.messages as AgentMessage[];
}

test("measurement rejects stale model usage and estimates the active message payload", () => {
  const oldAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "old response" }],
    api: "test-api",
    provider: "provider",
    model: "old-model",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as AgentMessage;

  const measurement = measureContext({
    model: { provider: "provider", id: "new-model", contextWindow: 100_000 },
    usage: { tokens: 80_000, contextWindow: 100_000, percent: 80 },
    messages: [oldAssistant],
  });

  assert.equal(measurement.source, "message-estimate");
  assert.ok(measurement.tokens !== null && measurement.tokens < 100);
});

test("notice appends to a new array only at Yellow+ and tool bytes count once", () => {
  const governor = createContextGovernor(DEFAULT_GOVERNOR_CONFIG);
  const budget = resolveBudget({
    contextWindow: 100_000,
    nativeProactiveEnabled: true,
    reserveTokens: 16_384,
    advisorySafePercent: 70,
  });
  const state = governor.observe({
    capturedAtMs: 1,
    sessionId: "session",
    branchLeafId: null,
    model: { provider: "provider", id: "model", contextWindow: 100_000 },
    measurement: {
      tokens: 60_000,
      contextWindow: 100_000,
      percent: 60,
      source: "pi-usage",
    },
    budget,
    event: { kind: "session-start" },
  });
  const original: AgentMessage[] = [
    { role: "user", content: "hello", timestamp: 1 },
  ];
  const outgoing = appendContextNotice(
    original,
    state,
    DEFAULT_GOVERNOR_CONFIG,
    2,
  );

  assert.ok(outgoing);
  assert.notEqual(outgoing, original);
  assert.equal(original.length, 1);
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[1]?.role, "custom");
  if (outgoing[1]?.role === "custom") {
    assert.equal(outgoing[1].display, false);
  }
  assert.ok(
    outgoing[1]?.role !== "custom" ||
      outgoing[1].content.length <=
        DEFAULT_GOVERNOR_CONFIG.notice.maxCharacters,
  );
  assert.equal(
    appendContextNotice(
      original,
      { ...state, pressure: { level: "green", reasons: [] } },
      DEFAULT_GOVERNOR_CONFIG,
      2,
    ),
    null,
  );
  assert.equal(
    appendContextNotice(
      original,
      { ...state, pressure: { level: null, reasons: [] } },
      DEFAULT_GOVERNOR_CONFIG,
      2,
    ),
    null,
  );

  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "é" }],
    isError: false,
    timestamp: 1,
  };
  const seen = new Set<string>();
  const totals = new Map<string, number>();
  accumulateToolResultBytes([result], seen, totals);
  accumulateToolResultBytes([result], seen, totals);
  assert.equal(totals.get("read"), 2);
});

test("adapter keeps one umbrella run through overflow retry and never persists notices", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const pi = new FakePi();
    let usageTokens: number | null = 40_000;
    let model = {
      provider: "provider",
      id: "model-a",
      name: "Model A",
      contextWindow: 100_000,
    };
    const context = {
      cwd: agentDir,
      get model() {
        return model;
      },
      getContextUsage: () => ({
        tokens: usageTokens,
        contextWindow: model.contextWindow,
        percent:
          usageTokens === null
            ? null
            : (usageTokens / model.contextWindow) * 100,
      }),
      isProjectTrusted: () => true,
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "session-a",
        getLeafId: () => "leaf-a",
        buildContextEntries: () => [],
      },
      ui: {
        notify: (message: string) => pi.notifications.push(message),
      },
    } as unknown as ExtensionContext;

    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      context,
    );
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    await pi.emit("agent_start", { type: "agent_start" }, context);

    const inputMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
    ];
    usageTokens = 60_000;
    const firstContext = resultMessages(
      await pi.emit(
        "context",
        { type: "context", messages: inputMessages },
        context,
      ),
    );
    const secondContext = resultMessages(
      await pi.emit(
        "context",
        { type: "context", messages: inputMessages },
        context,
      ),
    );
    assert.equal(firstContext?.length, 2);
    assert.equal(secondContext?.length, 2);
    assert.equal(inputMessages.length, 1);

    usageTokens = 62_000;
    await pi.emit(
      "agent_end",
      { type: "agent_end", messages: inputMessages },
      context,
    );
    await pi.emit(
      "session_before_compact",
      { type: "session_before_compact", reason: "overflow" },
      context,
    );
    assert.equal(pi.published.at(-1)?.pressure.level, "emergency");

    usageTokens = null;
    await pi.emit(
      "session_compact",
      { type: "session_compact", reason: "overflow", willRetry: true },
      context,
    );

    usageTokens = 10_000;
    await pi.emit("agent_start", { type: "agent_start" }, context);
    usageTokens = 15_000;
    await pi.emit(
      "context",
      { type: "context", messages: inputMessages },
      context,
    );

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "é" }],
      isError: false,
      timestamp: 1,
    };
    await pi.emit(
      "turn_end",
      { type: "turn_end", toolResults: [toolResult] },
      context,
    );
    await pi.emit(
      "turn_end",
      { type: "turn_end", toolResults: [toolResult] },
      context,
    );

    usageTokens = 18_000;
    await pi.emit("agent_start", { type: "agent_start" }, context);
    usageTokens = 20_000;
    await pi.emit(
      "agent_end",
      { type: "agent_end", messages: inputMessages },
      context,
    );
    await pi.emit("agent_settled", { type: "agent_settled" }, context);

    const settled = pi.published.at(-1);
    assert.ok(settled);
    assert.equal(settled.growth.latestTokens, 10_000);
    assert.equal(settled.growth.sampleCount, 1);
    assert.equal(settled.toolResultBytesByTool.read, 2);
    assert.equal(Object.isFrozen(settled), true);
    assert.equal(Object.isFrozen(settled.pressure.reasons), true);
    assert.equal(pi.persistentWrites, 0);

    pi.events.emit(CONTEXT_GOVERNOR_REFRESH_CHANNEL, undefined);
    const command = pi.commands.get("context-status");
    assert.ok(command);
    await command("", context as unknown as ExtensionCommandContext);
    const report = pi.notifications.at(-1) ?? "";
    assert.match(report, /advisory only/i);
    assert.match(report, /pi-usage/);
    assert.match(report, /settings-file derived/);
    assert.match(report, /read: 2 bytes/);
    assert.match(report, /P95 warming 1\/5/);
    assert.match(report, /runway pressure warming 1\/3/);
    assert.match(report, /config\.private\.json/);
    assert.match(report, /session-a\.[^.]+\.jsonl/);
    assert.equal(pi.persistentWrites, 0);

    model = { ...model, contextWindow: 120_000 };
    await pi.emit(
      "context",
      { type: "context", messages: inputMessages },
      context,
    );
    assert.equal(pi.published.at(-1)?.measurement.source, "message-estimate");
    assert.equal(pi.published.at(-1)?.growth.sampleCount, 0);

    model = { ...model, id: "model-b", name: "Model B" };
    await pi.emit("model_select", { type: "model_select", model }, context);
    assert.equal(
      pi.published.at(-1)?.measurement.unknownReason,
      "model-changed",
    );
    assert.equal(pi.published.at(-1)?.growth.sampleCount, 0);

    await pi.emit("session_tree", { type: "session_tree" }, context);
    assert.equal(pi.published.at(-1)?.growth.sampleCount, 0);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
    const telemetry = await telemetryRecords(agentDir, "session-a");
    assert.deepEqual(
      telemetry.map((record) => record.eventKind),
      [
        "session-start",
        "compaction",
        "run-settled",
        "model-reset",
        "model-reset",
        "tree-reset",
      ],
    );
    const settledRecord = telemetry.find(
      (record) => record.eventKind === "run-settled",
    );
    assert.equal(settledRecord?.runStartBaselineTokens, 10_000);
    assert.equal(settledRecord?.peakTokens, 20_000);
    assert.equal(settledRecord?.endpointTokens, 20_000);
    assert.equal(settledRecord?.comparisonResetReason, "compaction");
    assert.equal(settledRecord?.comparisonGeneration, 2);
    assert.equal(settledRecord?.growthSampleAccepted, true);
    assert.equal(JSON.stringify(telemetry).includes("hello"), false);
    assert.equal(pi.persistentWrites, 0);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("runtime compaction threshold duck type validates new fields", () => {
  assert.deepEqual(
    normalizeRuntimeCompactionThreshold({
      tokens: 75_000,
      source: "percentage",
      percentage: 75,
    }),
    { tokens: 75_000, source: "percentage", percentage: 75 },
  );
  assert.deepEqual(
    normalizeRuntimeCompactionThreshold({
      tokens: 83_616,
      source: "reserve",
      reserveTokens: 16_384,
    }),
    { tokens: 83_616, source: "reserve", reserveTokens: 16_384 },
  );
  assert.equal(
    normalizeRuntimeCompactionThreshold({ tokens: 1, source: "percentage" }),
    null,
  );
});

test("legacy native settings and settings parse errors become structurally unavailable", async () => {
  assert.deepEqual(
    normalizeNativeCompactionSettings({
      enabled: true,
      reserveTokens: 12_345,
    }),
    {
      enabled: true,
      thresholdPercent: undefined,
      reserveTokens: 12_345,
    },
  );

  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-settings-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await writeFile(join(agentDir, "settings.json"), "{ invalid json", "utf8");
    assert.equal(
      readNativeCompactionSettings({
        cwd: agentDir,
        isProjectTrusted: () => true,
      }),
      null,
    );

    const pi = new FakePi();
    const { context } = createLifecycleContext(pi, agentDir, "settings-error");
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);
    const state = pi.published.at(-1);
    assert.equal(state?.budget.nativeSource, "unavailable");
    assert.equal(state?.budget.nativeProactiveEnabled, null);

    const command = pi.commands.get("context-status");
    assert.ok(command);
    await command("", context as unknown as ExtensionCommandContext);
    assert.match(
      pi.notifications.at(-1) ?? "",
      /Native limit: unavailable \(settings unavailable; proactive unknown\)/,
    );
    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

interface LifecycleContextController {
  readonly context: ExtensionContext;
  setIdle(value: boolean): void;
  setUsage(value: number | null): void;
  setContextWindow(value: number): void;
}

function createLifecycleContext(
  pi: FakePi,
  agentDir: string,
  sessionId: string,
): LifecycleContextController {
  let idle = true;
  let usageTokens: number | null = 40_000;
  let model = {
    provider: "provider",
    id: "model",
    name: "Model",
    contextWindow: 100_000,
  };
  const context = {
    cwd: agentDir,
    get model() {
      return model;
    },
    getContextUsage: () => ({
      tokens: usageTokens,
      contextWindow: model.contextWindow,
      percent:
        usageTokens === null ? null : (usageTokens / model.contextWindow) * 100,
    }),
    isIdle: () => idle,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf",
      buildContextEntries: () => [],
    },
    ui: {
      notify: (message: string) => pi.notifications.push(message),
    },
  } as unknown as ExtensionContext;

  return {
    context,
    setIdle(value) {
      idle = value;
    },
    setUsage(value) {
      usageTokens = value;
    },
    setContextWindow(value) {
      model = { ...model, contextWindow: value };
    },
  };
}

function textToolResult(id = "call-1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "x" }],
    isError: false,
    timestamp: 1,
  };
}

async function telemetryLines(agentDir: string, sessionId: string) {
  const directory = join(agentDir, "context-governor", "telemetry");
  const names = (await readdir(directory)).filter(
    (name) => name.startsWith(`${sessionId}.`) && name.endsWith(".jsonl"),
  );
  assert.equal(names.length, 1);
  const content = await readFile(join(directory, names[0] ?? ""), "utf8");
  return content.trim().split("\n").filter(Boolean);
}

async function telemetryRecords(agentDir: string, sessionId: string) {
  return (await telemetryLines(agentDir, sessionId)).map((line) =>
    JSON.parse(line),
  );
}

test("non-retrying compaction does not manufacture zero growth and settles tool bytes once", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-nonretry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = new FakePi();
    const controller = createLifecycleContext(pi, agentDir, "nonretry");
    const { context } = controller;
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    await pi.emit("agent_start", { type: "agent_start" }, context);
    controller.setUsage(50_000);
    await pi.emit("context", { type: "context", messages: [] }, context);
    await pi.emit(
      "turn_end",
      { type: "turn_end", toolResults: [textToolResult()] },
      context,
    );
    controller.setUsage(55_000);
    await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
    controller.setUsage(null);
    await pi.emit(
      "session_compact",
      { type: "session_compact", reason: "threshold", willRetry: false },
      context,
    );
    const compacted = pi.published.at(-1);
    assert.equal(compacted?.pressure.level, "green");
    assert.equal(compacted?.runwayRuns, null);
    assert.equal(compacted?.growth.sampleCount, 0);
    controller.setUsage(10_000);
    await pi.emit("agent_settled", { type: "agent_settled" }, context);

    const settled = pi.published.at(-1);
    assert.ok(settled);
    assert.equal(settled.growth.latestTokens, null);
    assert.equal(settled.growth.sampleCount, 0);
    assert.equal(settled.toolResultBytesByTool.read, 1);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
    const records = await telemetryRecords(agentDir, "nonretry");
    assert.deepEqual(
      records.map((record) => record.eventKind),
      ["session-start", "compaction", "run-settled"],
    );
    assert.equal(records[1]?.growthSampleAccepted, false);
    assert.equal(records[1]?.comparisonResetReason, "compaction");
    assert.equal(records[2]?.growthSampleAccepted, false);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("manual compaction records session and comparison reset telemetry", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-manual-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = new FakePi();
    const { context } = createLifecycleContext(pi, agentDir, "manual");
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);
    await pi.emit(
      "session_compact",
      { type: "session_compact", reason: "manual", willRetry: false },
      context,
    );
    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
    const records = await telemetryRecords(agentDir, "manual");
    assert.deepEqual(
      records.map((record) => record.eventKind),
      ["session-start", "compaction"],
    );
    assert.equal(records[1]?.comparisonResetReason, "compaction");
    assert.equal(records[1]?.runStartBaselineTokens, null);
    assert.equal(records[1]?.peakTokens, null);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("same model ID with a changed context window resets the comparison epoch", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-window-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = new FakePi();
    const controller = createLifecycleContext(pi, agentDir, "window-reset");
    const { context } = controller;
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    controller.setUsage(50_000);
    await pi.emit("context", { type: "context", messages: [] }, context);
    await pi.emit("agent_settled", { type: "agent_settled" }, context);
    assert.equal(pi.published.at(-1)?.growth.sampleCount, 1);

    controller.setContextWindow(120_000);
    controller.setUsage(60_000);
    await pi.emit("context", { type: "context", messages: [] }, context);
    const reset = pi.published.at(-1);
    assert.equal(reset?.model?.id, "model");
    assert.equal(reset?.model?.contextWindow, 120_000);
    assert.equal(reset?.growth.sampleCount, 0);
    assert.equal(reset?.measurement.source, "message-estimate");
    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("a nested run started by an earlier settled handler keeps the umbrella open", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-nested-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = new FakePi();
    const controller = createLifecycleContext(pi, agentDir, "nested");
    const { context } = controller;
    let nestedStarted = false;
    pi.on("agent_settled", async () => {
      if (nestedStarted) return;
      nestedStarted = true;
      controller.setIdle(false);
      await pi.emit(
        "before_agent_start",
        { type: "before_agent_start" },
        context,
      );
      await pi.emit("agent_start", { type: "agent_start" }, context);
    });
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    await pi.emit("agent_start", { type: "agent_start" }, context);
    controller.setUsage(45_000);
    await pi.emit("context", { type: "context", messages: [] }, context);
    await pi.emit(
      "turn_end",
      { type: "turn_end", toolResults: [textToolResult()] },
      context,
    );

    await pi.emit("agent_settled", { type: "agent_settled" }, context);
    assert.equal(pi.published.at(-1)?.growth.sampleCount, 0);

    controller.setUsage(55_000);
    await pi.emit("context", { type: "context", messages: [] }, context);
    controller.setIdle(true);
    await pi.emit("agent_settled", { type: "agent_settled" }, context);
    const settled = pi.published.at(-1);
    assert.equal(settled?.growth.latestTokens, 15_000);
    assert.equal(settled?.growth.sampleCount, 1);
    assert.equal(settled?.toolResultBytesByTool.read, 1);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
    assert.deepEqual(
      (await telemetryRecords(agentDir, "nested")).map(
        (record) => record.eventKind,
      ),
      ["session-start", "run-settled"],
    );
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("lifecycle rejects a zero-baseline warm-up and audits the later clean comparison", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "context-governor-warmup-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = new FakePi();
    const controller = createLifecycleContext(pi, agentDir, "warmup");
    const { context } = controller;
    controller.setContextWindow(1_000_000);
    controller.setUsage(0);
    contextGovernorExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", { type: "session_start" }, context);

    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    controller.setUsage(143_740);
    await pi.emit("agent_settled", { type: "agent_settled" }, context);
    let settled = pi.published.at(-1);
    assert.equal(settled?.growth.latestTokens, null);
    assert.equal(settled?.growth.sampleCount, 0);
    assert.equal(settled?.runwayRuns, null);

    controller.setUsage(null);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start" },
      context,
    );
    controller.setUsage(150_888);
    await pi.emit("agent_settled", { type: "agent_settled" }, context);
    settled = pi.published.at(-1);
    assert.equal(settled?.growth.latestTokens, 7_148);
    assert.equal(settled?.growth.sampleCount, 1);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, context);
    const records = await telemetryRecords(agentDir, "warmup");
    assert.deepEqual(
      records.map((record) => record.eventKind),
      ["session-start", "run-settled", "run-settled"],
    );
    assert.equal(records[1]?.runStartBaselineTokens, null);
    assert.equal(records[1]?.peakTokens, 143_740);
    assert.equal(records[1]?.endpointTokens, 143_740);
    assert.equal(records[1]?.growthSampleAccepted, false);
    assert.equal(records[2]?.runStartBaselineTokens, 143_740);
    assert.equal(records[2]?.baselineSource, "previous-endpoint");
    assert.equal(records[2]?.peakTokens, 150_888);
    assert.equal(records[2]?.endpointTokens, 150_888);
    assert.equal(records[2]?.growthSampleAccepted, true);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
