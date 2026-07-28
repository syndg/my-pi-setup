import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  applyDecayEpoch,
  mapMessageIdentities,
  planContextDecay,
  validateContextSequence,
} from "./src/engine.ts";
import {
  createAutomaticDecayController,
  createContextDecayShadowController,
  createShadowReport,
} from "./src/adapter.ts";
import {
  DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
  parseContextDecayConfig,
} from "./src/config.ts";
import {
  cacheAdvisorySignalFromAudit,
  createAutomaticDecayPolicyState,
  evaluateAutomaticDecayPolicy,
  recordAutomaticDecaySettledRun,
  type AutomaticCacheAdvisorySignal,
  type AutomaticDecayIdentity,
  type AutomaticGovernorSignal,
} from "./src/automatic-policy.ts";
import {
  CONTEXT_DECAY_CONTROL_CHANNEL,
  isContextDecayControlEvent,
  requestContextDecayControl,
} from "./src/control.ts";
import type { DecayContext, DecayMessageInput } from "./src/types.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp };
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  timestamp: number,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp,
  };
}

function result(
  id: string,
  name: string,
  text: string,
  timestamp: number,
  isError = false,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

function assistant(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

function context(
  messages: readonly (AgentMessage | DecayMessageInput)[],
  overrides: Partial<
    Pick<DecayContext, "sessionId" | "modelKey" | "contextGeneration">
  > = {},
): DecayContext {
  return {
    sessionId: overrides.sessionId ?? "session-a",
    modelKey: overrides.modelKey ?? "openai/test/100000",
    contextGeneration: overrides.contextGeneration ?? "uncompacted",
    messages: messages.map((item, index) =>
      "message" in item
        ? item
        : { message: item, entryId: `entry-${index}`, entryRecallable: true },
    ),
  };
}

const permissive = {
  protectedRecentTokens: 1,
  oldLargeResultTokens: 20,
  minimumReplacementSavingsTokens: 1,
};

test("classifies superseded reads and protects the latest relevant read", () => {
  const source = context([
    user("inspect file"),
    call("r1", "read", { path: "src/a.ts", offset: 1, limit: 100 }, 2),
    result("r1", "read", "old ".repeat(500), 3),
    assistant("Need a newer authoritative slice", 4),
    call("r2", "read", { path: "src/a.ts", offset: 1, limit: 200 }, 5),
    result("r2", "read", "new ".repeat(500), 6),
    assistant("done", 7),
  ]);
  const plan = planContextDecay(source, permissive);
  const old = plan.candidates.find((item) => item.identity === "entry:entry-2");
  assert.equal(old?.classification, "superseded-read");
  assert.equal(old?.selected, true);
  assert.deepEqual(plan.protectedIdentities["entry:entry-5"], [
    "latest-relevant-read",
  ]);
  const output = applyDecayEpoch(source, plan.epoch);
  assert.match(
    (output.messages[2] as { content: Array<{ text: string }> }).content[0]
      ?.text ?? "",
    /superseded-read/,
  );
  assert.equal(output.messages.length, source.messages.length);
});

test("classifies superseded/consumed searches, acknowledged async results, empty output, duplicates, and old large output", () => {
  const repeated = "duplicate payload ".repeat(80);
  const source = context([
    user("search and wait"),
    call("s1", "rg", { pattern: "foo", path: "src" }, 2),
    result("s1", "rg", "first search ".repeat(100), 3),
    assistant("search again", 4),
    call("s2", "rg", { pattern: "foo", path: "src" }, 5),
    result("s2", "rg", "second search ".repeat(100), 6),
    assistant("I consumed it", 7),
    call("b1", "bg_status", { id: "1" }, 8),
    result("b1", "bg_status", "completed successfully ".repeat(100), 9),
    assistant("acknowledged", 10),
    call("e1", "bash", { command: "true" }, 11),
    result("e1", "bash", "", 12),
    assistant("continue", 13),
    call("d1", "bash", { command: "printf x" }, 14),
    result("d1", "bash", repeated, 15),
    assistant("again", 16),
    call("d2", "bash", { command: "printf x" }, 17),
    result("d2", "bash", repeated, 18),
    assistant("finish", 19),
  ]);
  const plan = planContextDecay(source, permissive);
  const byIndex = new Map(
    plan.candidates.map((item) => [item.messageIndex, item.classification]),
  );
  assert.equal(byIndex.get(2), "superseded-search");
  assert.equal(byIndex.get(5), "consumed-search");
  assert.equal(byIndex.get(8), "acknowledged-async");
  assert.equal(byIndex.get(11), "empty-output");
  assert.equal(byIndex.get(14), "duplicate");
  assert.equal(byIndex.get(17), "old-large-result");
});

test("protects recent working set, current goal, unresolved errors, pins, and latest checkpoint", () => {
  const source = context([
    { message: user("old goal"), entryId: "goal-old" },
    {
      message: {
        role: "custom",
        customType: "checkpoint",
        content: "checkpoint old",
        display: false,
        timestamp: 2,
      },
      entryId: "cp-old",
    },
    {
      message: {
        role: "custom",
        customType: "handoff-state",
        content: "handoff latest",
        display: false,
        timestamp: 3,
      },
      entryId: "cp-latest",
    },
    {
      message: call("bad", "bash", { command: "false" }, 4),
      entryId: "call-bad",
    },
    {
      message: result("bad", "bash", "fatal error ".repeat(200), 5, true),
      entryId: "bad-result",
    },
    {
      message: user("current goal with constraints", 6),
      entryId: "goal-current",
    },
    {
      message: call("pin", "bash", { command: "echo x" }, 7),
      entryId: "call-pin",
    },
    {
      message: result("pin", "bash", "large pinned ".repeat(200), 8),
      entryId: "pinned",
      labels: ["pin"],
    },
  ]);
  const plan = planContextDecay(source, {
    ...permissive,
    protectedRecentTokens: 100,
    pinnedIdentities: ["entry:bad-result"],
  });
  assert.ok(
    plan.protectedIdentities["entry:goal-current"]?.includes(
      "current-goal-constraints",
    ),
  );
  assert.ok(
    plan.protectedIdentities["entry:bad-result"]?.includes("unresolved-error"),
  );
  assert.ok(
    plan.protectedIdentities["entry:bad-result"]?.includes("explicit-pin"),
  );
  assert.ok(plan.protectedIdentities["entry:pinned"]?.includes("explicit-pin"));
  assert.ok(
    plan.protectedIdentities["entry:cp-latest"]?.includes(
      "latest-checkpoint-handoff",
    ),
  );
  assert.ok(
    plan.candidates.some(
      (item) =>
        item.identity === "entry:pinned" && item.blockedReason === "protected",
    ),
  );
});

test("preserves tool pairing, message order, and assistant provider metadata", () => {
  const source = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "A".repeat(2_000), 3),
    assistant("done", 4),
  ]);
  const plan = planContextDecay(source, permissive);
  const output = applyDecayEpoch(source, plan.epoch);
  assert.equal(plan.inputValidation.valid, true);
  assert.equal(output.validation.valid, true);
  assert.deepEqual(
    output.messages.map((message) => message.role),
    source.messages.map((item) => item.message.role),
  );
  assert.equal((output.messages[1] as { provider: string }).provider, "openai");
  assert.equal((output.messages[2] as { toolCallId: string }).toolCallId, "a");
  assert.equal(validateContextSequence(output.messages).valid, true);
});

test("refuses replacements when the input tool sequence is invalid", () => {
  const source = context([
    user("go"),
    result("missing", "bash", "X".repeat(2_000), 2),
  ]);
  const plan = planContextDecay(source, permissive);
  assert.equal(plan.inputValidation.valid, false);
  assert.equal(plan.epoch.replacementOrder.length, 0);
});

test("produces byte-stable plans, placeholders, epochs, and repeated output", () => {
  const source = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "A".repeat(4_000), 3),
    assistant("done", 4),
  ]);
  const first = planContextDecay(source, permissive);
  const second = planContextDecay(source, permissive);
  assert.deepEqual(first, second);
  assert.equal(first.epoch.id, second.epoch.id);
  assert.deepEqual(
    applyDecayEpoch(source, first.epoch),
    applyDecayEpoch(source, first.epoch),
  );
});

test("an epoch stays stable as context is appended and does not classify new messages", () => {
  const original = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "A".repeat(4_000), 3),
    assistant("done", 4),
  ]);
  const epoch = planContextDecay(original, permissive).epoch;
  const extended = context([
    ...original.messages,
    { message: user("next", 5), entryId: "next" },
    { message: assistant("new reply", 6), entryId: "reply" },
  ]);
  const output = applyDecayEpoch(extended, epoch);
  assert.equal(output.epoch.id, epoch.id);
  assert.equal(output.messages[4]?.role, "user");
  assert.equal(output.messages[5]?.role, "assistant");
});

test("synthetic identity mapping is deterministic and unrecoverable messages are not elided", () => {
  const source = context([
    { message: user("go") },
    { message: call("a", "bash", { command: "echo a" }, 2) },
    { message: result("a", "bash", "A".repeat(4_000), 3) },
    { message: assistant("done", 4) },
  ]);
  const identities = mapMessageIdentities(source);
  assert.deepEqual(identities, mapMessageIdentities(source));
  const candidate = planContextDecay(source, permissive).candidates.find(
    (item) => item.messageIndex === 2,
  );
  assert.equal(candidate?.identity, "tool-result:a");
  assert.equal(candidate?.blockedReason, "protected");
  assert.ok(
    planContextDecay(source, permissive).protectedIdentities[
      "tool-result:a"
    ]?.includes("unrecallable-source"),
  );
});

test("explicit apply is disabled by default and remains available by private opt-in", () => {
  const source = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "A".repeat(4_000), 3),
    assistant("done", 4),
  ]);
  const snapshot = JSON.stringify(source);
  const defaultController = createContextDecayShadowController(
    DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
  );
  assert.equal(defaultController.requestExplicitApply(source).applied, false);
  assert.equal(defaultController.transform(source), null);

  const enabled = createContextDecayShadowController(
    parseContextDecayConfig({
      ...permissive,
      allowExplicitApply: true,
    }),
  );
  assert.equal(enabled.requestExplicitApply(source).applied, true);
  assert.ok(enabled.transform(source));
  assert.equal(JSON.stringify(source), snapshot);
  enabled.reset();
  assert.equal(enabled.transform(source), null);
});

test("explicit epochs reset safely across compaction and model generations", () => {
  const source = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "A".repeat(4_000), 3),
    assistant("done", 4),
  ]);
  const controller = createContextDecayShadowController(
    parseContextDecayConfig({
      ...permissive,
      allowExplicitApply: true,
    }),
  );
  controller.requestExplicitApply(source);
  assert.equal(
    controller.transform(
      context(source.messages, { contextGeneration: "compaction:c1" }),
    ),
    null,
  );
  controller.requestExplicitApply(source);
  assert.equal(
    controller.transform(
      context(source.messages, { modelKey: "other/model/1" }),
    ),
    null,
  );
});

test("oversized one-turn is reported as a protected dead-end instead of violating the tail", () => {
  const source = context([
    user("one huge turn"),
    call("huge", "bash", { command: "cat huge" }, 2),
    result("huge", "bash", "Z".repeat(80_000), 3),
  ]);
  const plan = planContextDecay(source, {
    protectedRecentTokens: 1_000,
    oldLargeResultTokens: 100,
    minimumReplacementSavingsTokens: 1,
    maximumWireTokens: 5_000,
  });
  assert.equal(plan.oversizedProtectedTurn, true);
  assert.equal(plan.epoch.replacementOrder.length, 0);
  assert.equal(
    plan.candidates.find((item) => item.messageIndex === 2)?.blockedReason,
    "protected",
  );
});

test("shadow reports are bounded metadata-only artifacts", () => {
  const source = context([
    user("go"),
    call("a", "bash", { command: "echo a" }, 2),
    result("a", "bash", "secret-body".repeat(1_000), 3),
    assistant("done", 4),
  ]);
  const report = createShadowReport(planContextDecay(source, permissive), 1);
  assert.ok(report.candidates.length <= 1);
  assert.equal(JSON.stringify(report).includes("secret-body"), false);
  assert.equal(report.residentTokens >= report.effectiveWireTokens, true);
});

test("duplicate durable entry identities do not double-count replacement savings", () => {
  const source = context([
    { message: user("go"), entryId: "u", entryRecallable: true },
    {
      message: call("a", "bash", {}, 2),
      entryId: "call",
      entryRecallable: true,
    },
    {
      message: result("a", "bash", "same ".repeat(1000), 3),
      entryId: "shared",
      entryRecallable: true,
    },
    { message: assistant("seen", 4), entryId: "reply", entryRecallable: true },
    {
      message: result("a", "bash", "same ".repeat(1000), 5),
      entryId: "shared",
      entryRecallable: true,
    },
  ]);
  const identities = mapMessageIdentities(source);
  assert.equal(new Set(identities).size, identities.length);
  const plan = planContextDecay(source, permissive);
  assert.equal(
    new Set(plan.epoch.replacementOrder).size,
    plan.epoch.replacementOrder.length,
  );
  assert.equal(
    plan.accounting.proposedTokensSaved,
    Object.values(plan.epoch.replacements).reduce(
      (sum, item) => sum + item.tokensSaved,
      0,
    ),
  );
});

test("validated decay control seam accepts one synchronous authoritative response", () => {
  const events = createEventBus();
  events.on(CONTEXT_DECAY_CONTROL_CHANNEL, (value) => {
    if (!isContextDecayControlEvent(value)) return;
    value.respond({
      schemaVersion: 1,
      sessionId: value.sessionId,
      action: value.action,
      status: "cleared",
      reason: "enabled",
    });
  });
  assert.equal(
    requestContextDecayControl(events, { sessionId: "s", action: "clear" })
      ?.status,
    "cleared",
  );
  assert.equal(
    requestContextDecayControl(createEventBus(), {
      sessionId: "s",
      action: "apply",
    }),
    null,
  );
});

const automaticIdentity: AutomaticDecayIdentity = Object.freeze({
  sessionId: "session-a",
  branchLeafId: "leaf-a",
  modelKey: "openai/test/100000",
  contextGeneration: "uncompacted",
});

function automaticSource(): DecayContext {
  return context([
    user("go"),
    call("auto", "bash", { command: "echo auto" }, 2),
    result("auto", "bash", "A".repeat(16_000), 3),
    assistant("done", 4),
  ]);
}

function automaticConfig(overrides: Record<string, unknown> = {}) {
  return parseContextDecayConfig({
    ...permissive,
    automaticMutationEnabled: true,
    automaticMinimumProjectedSavingsTokens: 1,
    automaticMinimumSettledRuns: 0,
    automaticMinimumEpochDurationMs: 0,
    automaticSignalMaximumAgeMs: 1_000,
    ...overrides,
  });
}

function governor(
  pressure: AutomaticGovernorSignal["pressure"],
  overrides: Partial<AutomaticGovernorSignal> = {},
): AutomaticGovernorSignal {
  return { ...automaticIdentity, capturedAtMs: 1_000, pressure, ...overrides };
}

function cacheSignal(
  overrides: Partial<AutomaticCacheAdvisorySignal> = {},
): AutomaticCacheAdvisorySignal {
  return {
    ...automaticIdentity,
    capturedAtMs: 1_000,
    sequence: 1,
    cacheCold: false,
    prefixChurn: false,
    decayEpochChurn: false,
    ...overrides,
  };
}

test("automatic mutation is disabled by default and is a policy no-op", () => {
  const source = automaticSource();
  const plan = planContextDecay(source, permissive);
  const state = createAutomaticDecayPolicyState(automaticIdentity, 900);
  const decision = evaluateAutomaticDecayPolicy({
    config: DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
    identity: automaticIdentity,
    state,
    plan,
    governor: governor("emergency"),
    nowMs: 1_000,
  });
  assert.equal(decision.arm, false);
  assert.deepEqual(decision.blockers, ["disabled"]);
  assert.equal(decision.state, state);
});

test("entering Orange, Red, or Emergency can trigger an automatic epoch", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  for (const pressure of ["orange", "red", "emergency"] as const) {
    const decision = evaluateAutomaticDecayPolicy({
      config: automaticConfig(),
      identity: automaticIdentity,
      state: createAutomaticDecayPolicyState(automaticIdentity, 900),
      plan,
      governor: governor(pressure),
      nowMs: 1_000,
    });
    assert.equal(decision.arm, true, pressure);
    assert.ok(decision.triggers.includes("pressure-entry"), pressure);
  }
});

test("automatic policy enforces the total projected savings floor", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  const decision = evaluateAutomaticDecayPolicy({
    config: automaticConfig({
      automaticMinimumProjectedSavingsTokens:
        plan.accounting.proposedTokensSaved + 1,
    }),
    identity: automaticIdentity,
    state: createAutomaticDecayPolicyState(automaticIdentity, 900),
    plan,
    governor: governor("orange"),
    nowMs: 1_000,
  });
  assert.equal(decision.arm, false);
  assert.ok(decision.blockers.includes("below-projected-savings-floor"));
});

test("exceeding the configured resident wire target is an automatic trigger", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  const decision = evaluateAutomaticDecayPolicy({
    config: automaticConfig({
      maximumWireTokens: plan.accounting.residentTokens - 1,
    }),
    identity: automaticIdentity,
    state: createAutomaticDecayPolicyState(automaticIdentity, 900),
    plan,
    nowMs: 1_000,
  });
  assert.equal(decision.arm, true);
  assert.ok(decision.triggers.includes("wire-target-exceeded"));
});

test("fresh cache-cold and churn audit advisories can trigger an automatic epoch", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  for (const advisory of [
    cacheSignal({ cacheCold: true }),
    cacheSignal({ prefixChurn: true }),
    cacheSignal({ decayEpochChurn: true }),
  ]) {
    const decision = evaluateAutomaticDecayPolicy({
      config: automaticConfig(),
      identity: automaticIdentity,
      state: createAutomaticDecayPolicyState(automaticIdentity, 900),
      plan,
      cacheAdvisory: advisory,
      nowMs: 1_000,
    });
    assert.equal(decision.arm, true);
    assert.equal(decision.cacheAdvisoryAccepted, true);
    assert.ok(
      decision.triggers.includes(
        advisory.cacheCold ? "cache-cold" : "cache-churn",
      ),
    );
  }
});

test("automatic epoch arming requires both settled-run and wall-clock spacing", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  const config = automaticConfig({
    automaticMinimumSettledRuns: 2,
    automaticMinimumEpochDurationMs: 500,
  });
  let state = createAutomaticDecayPolicyState(automaticIdentity, 1_000);
  let decision = evaluateAutomaticDecayPolicy({
    config,
    identity: automaticIdentity,
    state,
    plan,
    governor: governor("red", { capturedAtMs: 1_100 }),
    nowMs: 1_100,
  });
  assert.equal(decision.arm, false);
  assert.ok(decision.blockers.includes("settled-run-spacing"));
  assert.ok(decision.blockers.includes("time-spacing"));

  state = recordAutomaticDecaySettledRun(recordAutomaticDecaySettledRun(state));
  decision = evaluateAutomaticDecayPolicy({
    config,
    identity: automaticIdentity,
    state,
    plan,
    governor: governor("red", { capturedAtMs: 1_500 }),
    nowMs: 1_500,
  });
  assert.equal(decision.arm, true);
});

test("stale and cross-session governor/cache signals are never trusted", () => {
  const plan = planContextDecay(automaticSource(), permissive);
  const state = createAutomaticDecayPolicyState(automaticIdentity, 0);
  const stale = evaluateAutomaticDecayPolicy({
    config: automaticConfig(),
    identity: automaticIdentity,
    state,
    plan,
    governor: governor("emergency", { capturedAtMs: 1 }),
    cacheAdvisory: cacheSignal({ capturedAtMs: 1, cacheCold: true }),
    nowMs: 10_000,
  });
  assert.equal(stale.arm, false);
  assert.equal(stale.governorAccepted, false);
  assert.equal(stale.cacheAdvisoryAccepted, false);
  assert.ok(stale.blockers.includes("no-trigger"));

  const wrongSession = evaluateAutomaticDecayPolicy({
    config: automaticConfig(),
    identity: automaticIdentity,
    state,
    plan,
    governor: governor("red", { sessionId: "old-session" }),
    cacheAdvisory: cacheSignal({ sessionId: "old-session", cacheCold: true }),
    nowMs: 1_000,
  });
  assert.equal(wrongSession.arm, false);
  assert.equal(wrongSession.governorAccepted, false);
  assert.equal(wrongSession.cacheAdvisoryAccepted, false);
});

test("automatic controller keeps one epoch stable instead of replanning every context request", () => {
  const source = automaticSource();
  const controller = createAutomaticDecayController(
    automaticConfig({ maximumWireTokens: 1 }),
    { identity: automaticIdentity, nowMs: 900 },
  );
  const first = controller.consider({
    context: source,
    identity: automaticIdentity,
    nowMs: 1_000,
  });
  assert.equal(first.decision.arm, true);
  assert.ok(first.transformed?.validation.valid);
  const epochId = controller.activePlan()?.epoch.id;

  const extended = context([
    ...source.messages,
    { message: user("next", 5), entryId: "next", entryRecallable: true },
    {
      message: assistant("new reply", 6),
      entryId: "reply",
      entryRecallable: true,
    },
  ]);
  const second = controller.consider({
    context: extended,
    identity: automaticIdentity,
    nowMs: 2_000,
  });
  assert.equal(second.decision.arm, false);
  assert.ok(second.decision.blockers.includes("no-material-change"));
  assert.equal(controller.activePlan()?.epoch.id, epochId);
  assert.equal(second.transformed?.epoch.id, epochId);
  assert.equal(second.transformed?.messages[4]?.role, "user");
});

test("automatic policy/controller reset on session, model, tree, and compaction identity changes", () => {
  const source = automaticSource();
  for (const changed of [
    { ...automaticIdentity, sessionId: "session-b" },
    { ...automaticIdentity, modelKey: "openai/other/100000" },
    { ...automaticIdentity, branchLeafId: "other-leaf" },
    { ...automaticIdentity, contextGeneration: "compaction:c1" },
  ]) {
    const controller = createAutomaticDecayController(
      automaticConfig({ maximumWireTokens: 1 }),
      { identity: automaticIdentity, nowMs: 900 },
    );
    assert.equal(
      controller.consider({
        context: source,
        identity: automaticIdentity,
        nowMs: 1_000,
      }).decision.arm,
      true,
    );
    const reset = controller.consider({
      context: source,
      identity: changed,
      nowMs: 1_100,
    });
    assert.equal(reset.decision.arm, false);
    assert.ok(reset.decision.blockers.includes("identity-reset"));
    assert.equal(controller.activePlan(), null);
    assert.equal(controller.policyState()?.sessionId, changed.sessionId);
    assert.equal(controller.policyState()?.modelKey, changed.modelKey);
    assert.equal(controller.policyState()?.branchLeafId, changed.branchLeafId);
    assert.equal(
      controller.policyState()?.contextGeneration,
      changed.contextGeneration,
    );
  }
});

test("automatic private config fields are bounded and default disabled", () => {
  assert.equal(
    DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.automaticMutationEnabled,
    false,
  );
  const parsed = parseContextDecayConfig({
    automaticMutationEnabled: true,
    automaticMinimumProjectedSavingsTokens: 123,
    automaticMinimumSettledRuns: 0,
    automaticMinimumEpochDurationMs: 0,
    automaticSignalMaximumAgeMs: 456,
  });
  assert.equal(parsed.automaticMutationEnabled, true);
  assert.equal(parsed.automaticMinimumProjectedSavingsTokens, 123);
  assert.equal(parsed.automaticMinimumSettledRuns, 0);
  assert.equal(parsed.automaticMinimumEpochDurationMs, 0);
  assert.equal(parsed.automaticSignalMaximumAgeMs, 456);
});

test("cache audit metadata is validated and reduced to a session-bound advisory", () => {
  const audit = {
    evaluatedRuns: 3,
    cacheObservableRuns: 3,
    aggregateCacheRatio: 0.2,
    flags: {
      deepPrefixChurn: true,
      decayEpochChurn: false,
      lowCacheHitRate: true,
    },
    epochTransitions: 1,
    additiveActivationCount: 0,
    recommendation: "stabilize-prefix",
    recommendationText: "metadata only",
  };
  const signal = cacheAdvisorySignalFromAudit(
    audit,
    automaticIdentity,
    7,
    1_000,
  );
  assert.deepEqual(signal, {
    ...automaticIdentity,
    capturedAtMs: 1_000,
    sequence: 7,
    cacheCold: true,
    prefixChurn: true,
    decayEpochChurn: false,
  });
  assert.equal(
    cacheAdvisorySignalFromAudit(
      { ...audit, aggregateCacheRatio: 2 },
      automaticIdentity,
      8,
      1_000,
    ),
    null,
  );
});
