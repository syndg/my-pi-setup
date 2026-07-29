import assert from "node:assert/strict";
import test from "node:test";
import {
  isGovernorState,
  type ContextMeasurement,
  type ModelIdentity,
  type ResolvedBudget,
} from "../shared/context-governor-state.ts";
import {
  DEFAULT_GOVERNOR_CONFIG,
  parseGovernorConfig,
  type GovernorConfig,
} from "./src/config.ts";
import {
  createContextGovernor,
  resolveBudget,
  type ContextGovernor,
  type GovernorEvent,
  type GovernorSnapshot,
} from "./src/governor.ts";

test("resolves percentage, reserve, disabled, nullable, and unavailable native budgets", () => {
  assert.deepEqual(
    resolveBudget({
      contextWindow: 100_001,
      nativeProactiveEnabled: true,
      thresholdPercent: 80,
      reserveTokens: 16_384,
      advisorySafePercent: 70,
    }),
    {
      nativeLimitTokens: 80_000,
      nativeSource: "threshold-percent",
      nativeProactiveEnabled: true,
      advisoryLimitTokens: 70_000,
      effectiveSafeLimitTokens: 80_000,
      effectiveSource: "native-limit",
    },
  );

  const clamped = resolveBudget({
    contextWindow: 100_000,
    nativeProactiveEnabled: true,
    thresholdPercent: 200,
    reserveTokens: 1,
  });
  assert.equal(clamped.nativeLimitTokens, 99_000);
  assert.equal(clamped.nativeSource, "threshold-percent");

  const reserve = resolveBudget({
    contextWindow: 100_000,
    nativeProactiveEnabled: true,
    thresholdPercent: 0,
    reserveTokens: 40_000,
  });
  assert.equal(reserve.nativeLimitTokens, 60_000);
  assert.equal(reserve.effectiveSafeLimitTokens, 60_000);
  assert.equal(reserve.nativeSource, "reserve-tokens");

  assert.deepEqual(
    resolveBudget({
      contextWindow: 100_000,
      nativeProactiveEnabled: false,
      thresholdPercent: 50,
      reserveTokens: 40_000,
    }),
    {
      nativeLimitTokens: null,
      nativeSource: "disabled",
      nativeProactiveEnabled: false,
      advisoryLimitTokens: 70_000,
      effectiveSafeLimitTokens: 70_000,
      effectiveSource: "governor-percent",
    },
  );

  assert.deepEqual(
    resolveBudget({
      contextWindow: 100_000,
      nativeProactiveEnabled: null,
      thresholdPercent: 50,
      reserveTokens: 40_000,
    }),
    {
      nativeLimitTokens: null,
      nativeSource: "unavailable",
      nativeProactiveEnabled: null,
      advisoryLimitTokens: 70_000,
      effectiveSafeLimitTokens: 70_000,
      effectiveSource: "governor-percent",
    },
  );

  assert.deepEqual(
    resolveBudget({
      contextWindow: Number.NaN,
      nativeProactiveEnabled: true,
      reserveTokens: 10,
    }),
    {
      nativeLimitTokens: null,
      nativeSource: "unavailable",
      nativeProactiveEnabled: null,
      advisoryLimitTokens: null,
      effectiveSafeLimitTokens: null,
      effectiveSource: "unavailable",
    },
  );
});

test("runtime-resolved native threshold wins over settings reconstruction", () => {
  const budget = resolveBudget({
    contextWindow: 100_000,
    nativeProactiveEnabled: true,
    thresholdPercent: 50,
    reserveTokens: 40_000,
    resolvedNativeLimit: { tokens: 81_234, source: "percentage" },
  });
  assert.equal(budget.nativeLimitTokens, 81_234);
  assert.equal(budget.nativeSource, "threshold-percent");
});

interface ObserveOptions {
  readonly sessionId?: string;
  readonly branchLeafId?: string | null;
  readonly model?: ModelIdentity | null;
  readonly measurementContextWindow?: number;
  readonly source?: ContextMeasurement["source"];
  readonly unknownReason?: ContextMeasurement["unknownReason"];
  readonly budget?: ResolvedBudget;
  readonly toolResultBytesByTool?: Readonly<Record<string, number>>;
}

interface Harness {
  readonly governor: ContextGovernor;
  readonly model: ModelIdentity;
  observe(
    event: GovernorEvent,
    tokens: number | null,
    options?: ObserveOptions,
  ): ReturnType<ContextGovernor["observe"]>;
}

function configWith(overrides: Partial<GovernorConfig>): GovernorConfig {
  return parseGovernorConfig({ ...DEFAULT_GOVERNOR_CONFIG, ...overrides });
}

function harness(
  config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
  contextWindow = 100_000,
): Harness {
  const governor = createContextGovernor(config);
  const model: ModelIdentity = {
    provider: "test-provider",
    id: "test-model",
    contextWindow,
  };
  let capturedAtMs = 0;

  return {
    governor,
    model,
    observe(event, tokens, options = {}) {
      const selectedModel = options.model === undefined ? model : options.model;
      const measurementWindow =
        options.measurementContextWindow ?? selectedModel?.contextWindow ?? 0;
      const source =
        options.source ?? (tokens === null ? "unknown" : "pi-usage");
      const measurement: ContextMeasurement = {
        tokens,
        contextWindow: measurementWindow,
        percent: tokens === null ? null : -1,
        source,
        ...(options.unknownReason === undefined
          ? {}
          : { unknownReason: options.unknownReason }),
      };
      const budget =
        options.budget ??
        resolveBudget({
          contextWindow: selectedModel?.contextWindow ?? 0,
          nativeProactiveEnabled: false,
          advisorySafePercent: config.advisorySafePercent,
        });
      const snapshot: GovernorSnapshot = {
        capturedAtMs: ++capturedAtMs,
        sessionId: options.sessionId ?? "session-1",
        branchLeafId: options.branchLeafId ?? "leaf-1",
        model: selectedModel,
        measurement,
        budget,
        event,
        ...(options.toolResultBytesByTool === undefined
          ? {}
          : { toolResultBytesByTool: options.toolResultBytesByTool }),
      };
      return governor.observe(snapshot);
    },
  };
}

function recordGrowth(
  subject: Harness,
  runId: string,
  baseline: number,
  endpoint: number,
): ReturnType<ContextGovernor["observe"]> {
  subject.observe({ kind: "run-start", runId }, baseline);
  return subject.observe({ kind: "run-settled", runId }, endpoint);
}

test("current starts unknown and returned snapshots are immutable copies", () => {
  const subject = harness();
  assert.equal(subject.governor.current().pressure.level, null);
  assert.equal(
    subject.governor.current().measurement.unknownReason,
    "no-model",
  );

  const toolBytes = { zeta: 2, alpha: 1 };
  subject.observe({ kind: "run-start", runId: "r1" }, 1_000);
  const state = subject.observe({ kind: "run-settled", runId: "r1" }, 2_000, {
    toolResultBytesByTool: toolBytes,
  });
  toolBytes.alpha = 999;

  assert.deepEqual(state.toolResultBytesByTool, { alpha: 1, zeta: 2 });
  assert.ok(isGovernorState(state));
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.growth));
  assert.ok(Object.isFrozen(state.pressure.reasons));
  assert.ok(Object.isFrozen(state.toolResultBytesByTool));
  assert.strictEqual(subject.governor.current(), state);
});

test("publishes the configured footer flag from the initial state onward", () => {
  const subject = harness(
    configWith({ footer: { enabled: false, mode: "compact" } }),
  );

  assert.equal(subject.governor.current().footerEnabled, false);
  const state = subject.observe({ kind: "session-start" }, 1_000);
  assert.equal(state.footerEnabled, false);
  assert.ok(isGovernorState(state));
});

test("normalizes pi, estimated, unavailable, no-model, and stale-window measurements", () => {
  const subject = harness();
  let state = subject.observe({ kind: "session-start" }, 25_000);
  assert.equal(state.measurement.source, "pi-usage");
  assert.equal(state.measurement.percent, 25);
  assert.equal(state.pressure.level, "green");

  state = subject.observe({ kind: "sample" }, 30_000, {
    source: "message-estimate",
  });
  assert.equal(state.measurement.source, "message-estimate");
  assert.equal(state.measurement.percent, 30);

  state = subject.observe({ kind: "sample" }, null, {
    unknownReason: "usage-unavailable",
  });
  assert.equal(state.measurement.source, "unknown");
  assert.equal(state.pressure.level, null);

  state = subject.observe({ kind: "sample" }, 10_000, {
    model: null,
    measurementContextWindow: 0,
  });
  assert.equal(state.measurement.unknownReason, "no-model");
  assert.equal(state.pressure.level, null);

  const fresh = harness();
  state = fresh.observe({ kind: "session-start" }, 10_000, {
    measurementContextWindow: 99_999,
  });
  assert.equal(state.measurement.unknownReason, "model-changed");
});

test("tracks peak-minus-baseline once across retries and rejects invalid deltas", () => {
  const subject = harness(undefined, 1_000_000);
  subject.observe({ kind: "run-start", runId: "r1" }, 100_000);
  subject.observe({ kind: "run-start", runId: "retry" }, 120_000);
  subject.observe({ kind: "sample" }, 140_000);
  let state = subject.observe({ kind: "run-settled", runId: "r1" }, 130_000);
  assert.equal(state.growth.latestTokens, 40_000);
  assert.equal(state.growth.sampleCount, 1);

  state = subject.observe({ kind: "run-settled", runId: "r1" }, 150_000);
  assert.equal(state.growth.latestTokens, 40_000);
  assert.equal(state.growth.sampleCount, 1);

  state = recordGrowth(subject, "zero", 200_000, 200_000);
  assert.equal(state.growth.latestTokens, 0);
  assert.equal(state.growth.sampleCount, 2);

  state = recordGrowth(subject, "negative", 300_000, 290_000);
  assert.equal(state.growth.latestTokens, null);
  assert.equal(state.growth.sampleCount, 2);

  subject.observe({ kind: "run-start", runId: "missing" }, 300_000);
  state = subject.observe({ kind: "run-settled", runId: "missing" }, null);
  assert.equal(state.growth.sampleCount, 2);
});

test("rejects a warm-up settlement without a trustworthy baseline and establishes the next comparison", () => {
  const subject = harness(undefined, 1_000_000);
  subject.observe({ kind: "run-start", runId: "warm-up" }, 0);
  let state = subject.observe(
    { kind: "run-settled", runId: "warm-up" },
    143_740,
  );
  assert.equal(state.growth.latestTokens, null);
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.runwayRuns, null);

  subject.observe({ kind: "run-start", runId: "clean" }, null);
  state = subject.observe({ kind: "run-settled", runId: "clean" }, 150_888);
  assert.equal(state.growth.latestTokens, 7_148);
  assert.equal(state.growth.sampleCount, 1);
});

test("computes EWMA, nearest-rank P95, conservative growth, and bounded history", () => {
  const subject = harness(undefined, 10_000_000);
  let expectedEwma: number | null = null;
  let state = subject.governor.current();
  for (let growth = 1; growth <= 20; growth += 1) {
    state = recordGrowth(subject, `r${growth}`, 1_000, 1_000 + growth);
    expectedEwma =
      expectedEwma === null ? growth : 0.35 * growth + 0.65 * expectedEwma;
  }
  assert.equal(state.growth.sampleCount, 20);
  assert.equal(state.growth.p95Tokens, 19);
  assert.equal(state.growth.ewmaTokens, expectedEwma);
  assert.equal(state.growth.conservativeTokens, 20);

  const bounded = harness(
    configWith({ historyLength: 3, minimumP95Samples: 3 }),
    10_000_000,
  );
  for (let growth = 1; growth <= 4; growth += 1) {
    state = recordGrowth(bounded, `b${growth}`, 1_000, 1_000 + growth);
  }
  assert.equal(state.growth.sampleCount, 3);
  assert.equal(state.growth.p95Tokens, 4);
});

test("withholds P95 until the configured minimum clean sample count", () => {
  const subject = harness(configWith({ minimumP95Samples: 5 }), 10_000_000);
  let state = subject.governor.current();
  for (let growth = 1; growth <= 4; growth += 1) {
    state = recordGrowth(subject, `warm-p95-${growth}`, 1_000, 1_000 + growth);
    assert.equal(state.growth.p95Tokens, null);
  }
  state = recordGrowth(subject, "active-p95", 1_000, 1_005);
  assert.equal(state.growth.p95Tokens, 5);
});

test("runway is unknown without positive growth and preserves zero or negative headroom", () => {
  const subject = harness(undefined, 1_000_000);
  let state = subject.observe({ kind: "session-start" }, 100_000);
  assert.equal(state.runwayRuns, null);

  state = recordGrowth(subject, "zero", 100_000, 100_000);
  assert.equal(state.runwayRuns, null);

  state = recordGrowth(subject, "positive", 100_000, 200_000);
  assert.equal(state.growth.conservativeTokens, 100_000);
  assert.equal(state.headroomTokens, 500_000);
  assert.equal(state.runwayRuns, 5);

  state = subject.observe({ kind: "sample" }, 700_000);
  assert.equal(state.headroomTokens, 0);
  assert.equal(state.runwayRuns, 0);

  state = subject.observe({ kind: "sample" }, 710_000);
  assert.equal(state.headroomTokens, -10_000);
  assert.equal(state.runwayRuns, -0.1);

  state = subject.observe({ kind: "sample" }, null);
  assert.equal(state.runwayRuns, null);
});

test("applies all pressure boundaries with highest severity winning", () => {
  const noMargin = configWith({ emergencyMarginTokens: 0 });
  const subject = harness(noMargin);
  assert.equal(
    subject.observe({ kind: "session-start" }, 49_999).pressure.level,
    "green",
  );
  let state = subject.observe({ kind: "sample" }, 50_000);
  assert.equal(state.pressure.level, "yellow");
  assert.ok(
    state.pressure.reasons.includes("context-window ratio at yellow threshold"),
  );

  state = subject.observe({ kind: "sample" }, 59_500);
  assert.equal(state.pressure.level, "orange");
  assert.ok(
    state.pressure.reasons.includes("safe-limit ratio at orange threshold"),
  );

  state = subject.observe({ kind: "sample" }, 66_500);
  assert.equal(state.pressure.level, "red");
  assert.ok(
    state.pressure.reasons.includes("safe-limit ratio at red threshold"),
  );

  const margin = harness();
  state = margin.observe({ kind: "session-start" }, 61_808);
  assert.equal(state.headroomTokens, 8_192);
  assert.equal(state.pressure.level, "red");
  assert.ok(
    state.pressure.reasons.includes("headroom within emergency margin"),
  );

  state = margin.observe({ kind: "sample" }, 70_000);
  assert.equal(state.pressure.level, "red");
  assert.ok(state.pressure.reasons.includes("safe-limit headroom exhausted"));
});

test("absolute token usage independently triggers Yellow at the exact boundary", () => {
  const subject = harness(
    configWith({
      advisorySafePercent: 99,
      yellowContextRatio: 1,
      orangeSafeLimitRatio: 1,
      redSafeLimitRatio: 1,
      emergencyMarginTokens: 0,
    }),
    200_000,
  );
  assert.equal(
    subject.observe({ kind: "session-start" }, 149_999).pressure.level,
    "green",
  );
  const state = subject.observe({ kind: "sample" }, 150_000);
  assert.equal(state.pressure.level, "yellow");
  assert.ok(
    state.pressure.reasons.includes("absolute token usage at yellow threshold"),
  );
});

test("large settled growth triggers Yellow at its exact adaptive boundary", () => {
  const subject = harness(undefined, 1_000_000);
  const state = recordGrowth(subject, "large", 100_000, 120_000);
  assert.equal(state.pressure.level, "yellow");
  assert.ok(state.pressure.reasons.includes("latest run growth is large"));
});

test("runway uses strict orange/red comparisons at exact boundaries", () => {
  const config = configWith({
    advisorySafePercent: 99,
    yellowContextRatio: 1,
    yellowAbsoluteTokens: Number.MAX_SAFE_INTEGER,
    largeRunTokens: Number.MAX_SAFE_INTEGER,
    largeRunSafeFraction: 1,
    orangeSafeLimitRatio: 1,
    redSafeLimitRatio: 1,
    emergencyMarginTokens: 0,
  });
  const subject = harness(config, 2_000_000);
  for (let sample = 1; sample <= 3; sample += 1) {
    recordGrowth(subject, `growth-${sample}`, 100_000, 200_000);
  }

  let state = subject.observe({ kind: "sample" }, 1_780_000);
  assert.equal(state.runwayRuns, 2);
  assert.equal(state.pressure.level, "green");

  state = subject.observe({ kind: "sample" }, 1_780_001);
  assert.ok(state.runwayRuns !== null && state.runwayRuns < 2);
  assert.equal(state.pressure.level, "orange");

  state = subject.observe({ kind: "sample" }, 1_880_000);
  assert.equal(state.runwayRuns, 1);
  assert.equal(state.pressure.level, "orange");

  state = subject.observe({ kind: "sample" }, 1_880_001);
  assert.ok(state.runwayRuns !== null && state.runwayRuns < 1);
  assert.equal(state.pressure.level, "red");
});

test("upgrades immediately and requires consecutive accepted settlements to downgrade", () => {
  const subject = harness();
  subject.observe({ kind: "session-start" }, 10_000);
  let state = subject.observe({ kind: "sample" }, 67_000);
  assert.equal(state.pressure.level, "red");

  state = subject.observe({ kind: "sample" }, 10_000);
  assert.equal(state.pressure.level, "red");
  state = subject.observe({ kind: "run-settled", runId: "not-open" }, 10_000);
  assert.equal(state.pressure.level, "red");

  state = recordGrowth(subject, "recovery-1", 10_000, 10_000);
  assert.equal(state.pressure.level, "red");
  assert.ok(state.pressure.reasons.some((reason) => reason.includes("1/2")));

  state = subject.observe({ kind: "sample" }, 67_000);
  assert.equal(state.pressure.level, "red");
  state = subject.observe({ kind: "sample" }, 10_000);

  state = recordGrowth(subject, "recovery-2", 10_000, 10_000);
  assert.equal(state.pressure.level, "red");
  assert.ok(state.pressure.reasons.some((reason) => reason.includes("1/2")));

  state = recordGrowth(subject, "recovery-3", 10_000, 10_000);
  assert.equal(state.pressure.level, "green");

  state = subject.observe({ kind: "sample" }, 60_000);
  assert.equal(state.pressure.level, "orange");
});

test("Emergency latches until compaction or a hard reset", () => {
  const subject = harness();
  let state = subject.observe(
    { kind: "emergency", reason: "provider-overflow" },
    null,
  );
  assert.equal(state.pressure.level, "emergency");
  assert.deepEqual(state.pressure.reasons, ["provider overflow"]);

  state = subject.observe({ kind: "sample" }, 1_000);
  assert.equal(state.pressure.level, "emergency");

  state = subject.observe({ kind: "compaction", reason: "overflow" }, 1_000, {
    source: "message-estimate",
  });
  assert.equal(state.pressure.level, "green");
  assert.equal(state.measurement.source, "message-estimate");
  assert.equal(state.growth.latestTokens, null);

  state = subject.observe(
    { kind: "emergency", reason: "maintenance-failed" },
    1_000,
  );
  assert.equal(state.pressure.level, "emergency");
  state = subject.observe({ kind: "tree-reset" }, 1_000);
  assert.equal(state.pressure.level, "green");
});

test("compaction clears forecasting history and invalidates an open run and stale usage", () => {
  const subject = harness(undefined, 1_000_000);
  let state = recordGrowth(subject, "old", 100_000, 120_000);
  assert.equal(state.growth.sampleCount, 1);

  subject.observe({ kind: "run-start", runId: "cross-epoch" }, 120_000);
  subject.observe({ kind: "sample" }, 180_000);
  state = subject.observe({ kind: "compaction", reason: "threshold" }, 50_000);
  assert.equal(state.measurement.source, "unknown");
  assert.equal(state.measurement.unknownReason, "post-compaction");
  assert.equal(state.pressure.level, null);
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.growth.latestTokens, null);
  assert.equal(state.growth.p95Tokens, null);
  assert.equal(state.growth.ewmaTokens, null);
  assert.equal(state.growth.conservativeTokens, null);

  const toolBytes = { read: 123 };
  state = subject.observe(
    { kind: "run-settled", runId: "cross-epoch" },
    60_000,
    {
      toolResultBytesByTool: toolBytes,
    },
  );
  toolBytes.read = 999;
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.growth.latestTokens, null);
  assert.deepEqual(state.toolResultBytesByTool, { read: 123 });

  state = recordGrowth(subject, "post", 60_000, 70_000);
  assert.equal(state.growth.sampleCount, 1);
  assert.equal(state.growth.latestTokens, 10_000);
});

test("compaction does not synthesize a zero sample without an observed peak", () => {
  const subject = harness(undefined, 1_000_000);
  subject.observe({ kind: "run-start", runId: "partial" }, 100_000);

  const state = subject.observe(
    { kind: "compaction", reason: "threshold" },
    50_000,
  );
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.growth.latestTokens, null);
  assert.equal(state.growth.ewmaTokens, null);
  assert.equal(state.growth.p95Tokens, null);
  assert.equal(state.growth.conservativeTokens, null);
});

test("compaction clears old velocity, stays non-Red at low occupancy, then enables clean runway", () => {
  const subject = harness(undefined, 1_000_000);
  for (let run = 1; run <= 5; run += 1) {
    recordGrowth(subject, `pre-${run}`, 100_000, 300_000);
  }

  let state = subject.observe(
    { kind: "compaction", reason: "threshold" },
    50_000,
    { source: "message-estimate" },
  );
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.growth.latestTokens, null);
  assert.equal(state.growth.ewmaTokens, null);
  assert.equal(state.growth.p95Tokens, null);
  assert.equal(state.growth.conservativeTokens, null);
  assert.equal(state.runwayRuns, null);
  assert.equal(state.pressure.level, "green");

  state = recordGrowth(subject, "post-1", 50_000, 150_000);
  assert.equal(state.runwayRuns, 5.5);
  assert.notEqual(state.pressure.level, "red");
  state = recordGrowth(subject, "post-2", 150_000, 250_000);
  assert.equal(state.runwayRuns, 4.5);
  assert.notEqual(state.pressure.level, "red");
  state = recordGrowth(subject, "post-3", 250_000, 650_001);
  assert.ok(state.runwayRuns !== null && state.runwayRuns < 1);
  assert.equal(state.pressure.level, "red");
  assert.ok(state.pressure.reasons.includes("runway below red threshold"));
});

test("session, model, automatic identity, and tree resets clear incomparable history", () => {
  const subject = harness(undefined, 1_000_000);
  let state = recordGrowth(subject, "r1", 10_000, 20_000);
  assert.equal(state.growth.sampleCount, 1);

  state = subject.observe({ kind: "model-reset" }, 20_000);
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.measurement.unknownReason, "model-changed");

  recordGrowth(subject, "r2", 10_000, 20_000);
  const secondModel: ModelIdentity = {
    provider: "test-provider",
    id: "second-model",
    contextWindow: 1_000_000,
  };
  state = subject.observe({ kind: "sample" }, 20_000, { model: secondModel });
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.measurement.unknownReason, "model-changed");
  state = subject.observe({ kind: "sample" }, 20_000, { model: secondModel });
  assert.equal(state.measurement.source, "pi-usage");

  recordGrowth(subject, "r3", 10_000, 20_000);
  state = subject.observe({ kind: "tree-reset" }, 20_000, {
    model: secondModel,
    branchLeafId: "other-branch",
  });
  assert.equal(state.growth.sampleCount, 0);

  recordGrowth(subject, "r4", 10_000, 20_000);
  state = subject.observe({ kind: "session-start" }, 20_000, {
    sessionId: "session-2",
    model: secondModel,
  });
  assert.equal(state.growth.sampleCount, 0);
  assert.equal(state.measurement.source, "pi-usage");

  recordGrowth(subject, "r5", 10_000, 20_000);
  state = subject.observe({ kind: "sample" }, 20_000, {
    sessionId: "session-3",
    model: secondModel,
  });
  assert.equal(state.growth.sampleCount, 0);
});
