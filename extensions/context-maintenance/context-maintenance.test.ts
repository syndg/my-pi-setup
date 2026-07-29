import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyGovernorState,
  type GovernorState,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
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
    first.find((choice) => choice.id === "checkpoint")?.enabled,
    false,
  );
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
  assert.equal(
    parseContextMaintenanceConfig({ choices: { checkpoint: true } }).choices
      .checkpoint,
    false,
  );
  assert.equal(parsed.decay.automaticMutationEnabled, false);
  assert.equal(parsed.decay.allowExplicitApply, false);
  assert.equal(
    DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint.enabled,
    false,
  );
});
