import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  emptyGovernorState,
  type GovernorState,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
import contextMaintenanceExtension from "./index.ts";
import {
  DEFAULT_CONTEXT_MAINTENANCE_CONFIG,
  parseContextMaintenanceConfig,
} from "./src/config.ts";
import {
  IGNORE_ENTRY_TYPE,
  MaintenancePressurePolicy,
  parseIgnoreOnceRecord,
  resolveMaintenanceChoices,
} from "./src/policy.ts";

type Handler = (
  event: any,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, Command>();
  readonly entries: Array<{ type: string; data: unknown }> = [];
  readonly notifications: string[] = [];
  compactCalls = 0;
  newSessionCalls = 0;
  private readonly bus = new Map<string, Set<(value: unknown) => void>>();

  readonly events = {
    on: (channel: string, handler: (value: unknown) => void) => {
      const listeners = this.bus.get(channel) ?? new Set();
      listeners.add(handler);
      this.bus.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit: (channel: string, value: unknown) => {
      for (const handler of this.bus.get(channel) ?? []) handler(value);
    },
  };

  on(name: string, handler: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  registerCommand(name: string, options: { handler: Command }) {
    this.commands.set(name, options.handler);
  }
  appendEntry(type: string, data: unknown) {
    this.entries.push({ type, data });
    return `entry-${this.entries.length}`;
  }
  async emit(name: string, event: unknown, ctx: ExtensionContext) {
    let result: unknown;
    for (const handler of this.handlers.get(name) ?? [])
      result = await handler(event, ctx);
    return result;
  }
}

function governor(level: PressureLevel, capturedAtMs = 1): GovernorState {
  return {
    ...emptyGovernorState(),
    capturedAtMs,
    sessionId: "session-a",
    branchLeafId: "leaf-a",
    model: { provider: "test", id: "model", contextWindow: 100_000 },
    measurement: {
      tokens: 65_000,
      contextWindow: 100_000,
      percent: 65,
      source: "pi-usage",
    },
    budget: {
      nativeLimitTokens: null,
      nativeSource: "disabled",
      nativeProactiveEnabled: false,
      advisoryLimitTokens: 70_000,
      effectiveSafeLimitTokens: 70_000,
      effectiveSource: "governor-percent",
    },
    headroomTokens: 5_000,
    safeLimitRatio: 65_000 / 70_000,
    pressure: { level, reasons: [`${level} fixture`] },
  };
}

function policyConfig(overrides: unknown = {}) {
  return parseContextMaintenanceConfig({
    automaticCheckpoint: {
      enabled: true,
      minimumIntervalMs: 100,
      maximumPerSession: 2,
    },
    recoverySettledRuns: 2,
    ...(overrides as object),
  });
}

test("choice mapping is deterministic, contract ordered, and config filtered", () => {
  const config = parseContextMaintenanceConfig({ choices: { compact: false } });
  const first = resolveMaintenanceChoices("red", config);
  const second = resolveMaintenanceChoices("red", config);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((choice) => choice.id),
    ["decay", "checkpoint", "handoff", "compact", "ignore-once"],
  );
  assert.equal(
    first.find((choice) => choice.id === "handoff")?.recommended,
    true,
  );
  assert.equal(first.find((choice) => choice.id === "compact")?.enabled, false);
  assert.equal(
    resolveMaintenanceChoices("green", config).find(
      (choice) => choice.id === "ignore-once",
    )?.enabled,
    false,
  );
});

test("settled transitions are edge-triggered, frequency bounded, and recovery is hysteretic", () => {
  const policy = new MaintenancePressurePolicy(policyConfig());
  policy.reset("session-a");

  const orange = policy.observeSettled(governor("orange"), 1_000);
  assert.equal(orange.transition, "entered-orange");
  assert.equal(orange.automaticCheckpoint, "orange");
  assert.equal(
    policy.observeSettled(governor("orange"), 1_010).automaticCheckpoint,
    null,
  );

  const redTooSoon = policy.observeSettled(governor("red"), 1_050);
  assert.equal(redTooSoon.transition, "entered-red");
  assert.equal(redTooSoon.automaticCheckpoint, null);

  assert.equal(
    policy.observeSettled(governor("yellow"), 1_200).heldPressure,
    "red",
  );
  const recovered = policy.observeSettled(governor("yellow"), 1_300);
  assert.equal(recovered.transition, "recovered");
  assert.equal(recovered.heldPressure, "yellow");

  const secondOrange = policy.observeSettled(governor("orange"), 1_400);
  assert.equal(secondOrange.automaticCheckpoint, "orange");
  policy.observeSettled(governor("yellow"), 1_500);
  policy.observeSettled(governor("yellow"), 1_600);
  assert.equal(
    policy.observeSettled(governor("orange"), 2_000).automaticCheckpoint,
    null,
  );
});

test("a sustained Red to Orange downgrade is not a new pressure-entry checkpoint", () => {
  const policy = new MaintenancePressurePolicy(policyConfig());
  policy.reset("session-a");
  assert.equal(
    policy.observeSettled(governor("red"), 1_000).automaticCheckpoint,
    "red",
  );
  assert.equal(
    policy.observeSettled(governor("orange"), 1_200).heldPressure,
    "red",
  );
  const downgraded = policy.observeSettled(governor("orange"), 1_300);
  assert.equal(downgraded.heldPressure, "orange");
  assert.equal(downgraded.transition, null);
  assert.equal(downgraded.automaticCheckpoint, null);
});

test("ignore-once is bounded non-context data and resets after sustained recovery", () => {
  const policy = new MaintenancePressurePolicy(policyConfig());
  policy.reset("session-a");
  policy.observeSettled(governor("red"), 100);
  const ignored = policy.ignoreOnce(governor("red"), 101);
  assert.ok(ignored);
  assert.equal(
    Buffer.byteLength(JSON.stringify(ignored)),
    Buffer.byteLength(JSON.stringify(parseIgnoreOnceRecord(ignored))),
  );
  assert.equal(
    policy.observeSettled(governor("red"), 102).offerMaintenance,
    false,
  );
  policy.observeSettled(governor("green"), 103);
  const recovered = policy.observeSettled(governor("green"), 104);
  assert.equal(recovered.transition, "recovered");
  assert.equal(policy.ignored(), null);
  assert.equal(
    parseIgnoreOnceRecord({ ...ignored, sessionId: "x".repeat(129) }),
    null,
  );
});

interface FakeContextController {
  readonly ctx: ExtensionCommandContext;
  readonly pi: FakePi;
  setUI(values: { select?: string; input?: string | undefined }): void;
}

function extensionFixture(
  options: { hasUI?: boolean; entries?: SessionEntry[] } = {},
): FakeContextController {
  const pi = new FakePi();
  let selected: string | undefined;
  let input: string | undefined;
  const entries = options.entries ?? [];
  const sessionManager = {
    getSessionId: () => "session-a",
    getSessionFile: () => "/tmp/session-a.jsonl",
    getLeafId: () => "leaf-a",
    getBranch: () => entries,
    buildContextEntries: () => entries,
  };
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    cwd: "/tmp",
    model: { provider: "test", id: "model", contextWindow: 100_000 },
    modelRegistry: {},
    sessionManager,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({}),
    waitForIdle: async () => {},
    compact: () => {
      pi.compactCalls += 1;
    },
    newSession: async () => {
      pi.newSessionCalls += 1;
      return { cancelled: false };
    },
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
    ui: {
      notify: (message: string) => pi.notifications.push(message),
      select: async () => selected,
      input: async () => input,
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext;
  contextMaintenanceExtension(pi as unknown as ExtensionAPI);
  return {
    ctx,
    pi,
    setUI(values) {
      selected = values.select;
      input = values.input;
    },
  };
}

async function start(fixture: FakeContextController) {
  await fixture.pi.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    fixture.ctx,
  );
}

test("selection cancellation and headless no-argument flow perform no action", async () => {
  const cancelled = extensionFixture();
  await start(cancelled);
  await cancelled.pi.commands.get("context-maintain")?.("", cancelled.ctx);
  assert.equal(cancelled.pi.compactCalls, 0);
  assert.equal(cancelled.pi.newSessionCalls, 0);
  assert.equal(cancelled.pi.entries.length, 0);

  const headless = extensionFixture({ hasUI: false });
  await start(headless);
  await headless.pi.commands.get("context-maintain")?.("", headless.ctx);
  assert.equal(headless.pi.compactCalls, 0);
  assert.equal(headless.pi.newSessionCalls, 0);
});

test("only an explicit compact choice calls ctx.compact; decay and ignore remain reversible", async () => {
  const fixture = extensionFixture();
  await start(fixture);
  fixture.pi.events.emit("dashboard:context-governor", governor("red"));
  const command = fixture.pi.commands.get("context-maintain");
  assert.ok(command);

  await command("decay", fixture.ctx);
  assert.equal(fixture.pi.compactCalls, 0);
  assert.equal(fixture.pi.newSessionCalls, 0);

  await command("ignore-once", fixture.ctx);
  assert.equal(fixture.pi.entries.at(-1)?.type, IGNORE_ENTRY_TYPE);
  assert.equal(fixture.pi.compactCalls, 0);

  await command("compact preserve exact errors", fixture.ctx);
  assert.equal(fixture.pi.compactCalls, 1);
  assert.equal(fixture.pi.newSessionCalls, 0);
});

test("active task guard blocks checkpoint, handoff, and compaction command actions", async () => {
  const fixture = extensionFixture();
  await start(fixture);
  await fixture.pi.emit(
    "tool_execution_start",
    { toolCallId: "call-bg", toolName: "bg_start" },
    fixture.ctx,
  );
  const command = fixture.pi.commands.get("context-maintain");
  assert.ok(command);
  await command("compact", fixture.ctx);
  await command("checkpoint Continue safely.", fixture.ctx);
  await command("handoff Continue safely.", fixture.ctx);
  assert.equal(fixture.pi.compactCalls, 0);
  assert.equal(fixture.pi.newSessionCalls, 0);
  assert.equal(fixture.pi.entries.length, 0);
  assert.ok(
    fixture.pi.notifications.filter((message) =>
      /active or uncertain/i.test(message),
    ).length >= 3,
  );
});

test("pressure lifecycle never autonomously compacts or hands off and failures fail open", async () => {
  const fixture = extensionFixture();
  await start(fixture);
  fixture.pi.events.emit("dashboard:context-governor", governor("red"));
  await fixture.pi.emit(
    "agent_settled",
    { type: "agent_settled" },
    fixture.ctx,
  );
  assert.equal(fixture.pi.compactCalls, 0);
  assert.equal(fixture.pi.newSessionCalls, 0);
  assert.ok(
    fixture.pi.notifications.some((message) =>
      /explicit choice/i.test(message),
    ),
  );
});

test("config parsing keeps safe defaults and never enables automatic decay", () => {
  const parsed = parseContextMaintenanceConfig({
    automaticCheckpoint: { maximumPerSession: 999, minimumIntervalMs: -1 },
    decay: { automaticMutationEnabled: true, allowExplicitApply: false },
  });
  assert.equal(parsed.automaticCheckpoint.maximumPerSession, 32);
  assert.equal(
    parsed.automaticCheckpoint.minimumIntervalMs,
    DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint.minimumIntervalMs,
  );
  assert.equal(parsed.decay.automaticMutationEnabled, false);
  assert.equal(parsed.decay.allowExplicitApply, false);
  assert.equal(
    DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint.enabled,
    false,
  );
});
