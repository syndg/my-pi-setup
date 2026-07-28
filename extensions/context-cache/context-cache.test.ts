import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { evaluateCacheAudit } from "./src/evaluator.ts";
import { formatCacheStatus } from "./src/status.ts";
import { cacheRatio, createProviderUsageAccumulator } from "./src/usage.ts";
import type { CacheRunRecord } from "./src/types.ts";

function assistant(
  api: string,
  usage: Partial<AssistantMessage["usage"]> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: "provider",
    model: "model",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function run(
  sequence: number,
  options: {
    ratio?: { input: number; read: number; write?: number };
    additive?: number;
    unexplained?: number;
    nonAdditive?: number;
    epochs?: string[];
    boundary?: CacheRunRecord["boundary"];
  } = {},
): CacheRunRecord {
  const metric = options.ratio;
  return {
    schemaVersion: 1,
    timestampMs: sequence,
    sessionId: "session",
    runId: `run-${sequence}`,
    boundary: options.boundary ?? null,
    providers: metric
      ? [
          {
            provider: "anthropic",
            api: "anthropic-messages",
            model: "model",
            requests: 1,
            input: metric.input,
            output: 5,
            cacheRead: metric.read,
            cacheWrite: metric.write ?? 0,
            cacheReadAvailability: "reported",
            cacheWriteAvailability: "reported",
          },
        ]
      : [],
    cacheRatio: metric
      ? metric.read / (metric.input + metric.read + (metric.write ?? 0))
      : null,
    prefix: {
      samples: 2,
      changes:
        (options.additive ?? 0) +
        (options.unexplained ?? 0) +
        (options.nonAdditive ?? 0),
      additiveChanges: options.additive ?? 0,
      unexplainedChanges: options.unexplained ?? 0,
      nonAdditiveChanges: options.nonAdditive ?? 0,
      latestPrefixBytes: 1000,
    },
    additiveActivations: options.additive
      ? [{ sequence, source: "tool-result", addedToolNames: ["next_tool"] }]
      : [],
    decayEpochs: (options.epochs ?? []).map((cacheEpochId, index) => ({
      sequence: sequence * 10 + index,
      mode: "applied",
      stable: true,
      cacheEpochId,
    })),
  };
}

test("cache ratio uses uncached input plus cache read/write", () => {
  const usage = createProviderUsageAccumulator();
  usage.add(
    assistant("anthropic-messages", {
      input: 20,
      output: 7,
      cacheRead: 70,
      cacheWrite: 10,
    }),
  );
  const providers = usage.snapshot();
  assert.equal(providers[0]?.cacheRead, 70);
  assert.equal(cacheRatio(providers), 0.7);
});

test("unknown provider APIs retain input/output and conservatively detect cache availability", () => {
  const unavailable = createProviderUsageAccumulator();
  unavailable.add(
    assistant("private-provider-api", {
      input: 42,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  );
  assert.equal(unavailable.snapshot()[0]?.cacheRead, null);
  assert.equal(cacheRatio(unavailable.snapshot()), null);

  const reported = createProviderUsageAccumulator();
  reported.add(
    assistant("private-provider-api", {
      input: 42,
      output: 9,
      cacheRead: 8,
      cacheWrite: 2,
    }),
  );
  assert.equal(reported.snapshot()[0]?.input, 42);
  assert.equal(reported.snapshot()[0]?.output, 9);
  assert.equal(reported.snapshot()[0]?.cacheRead, 8);
  assert.equal(reported.snapshot()[0]?.cacheWrite, 2);
});

test("additive activation is correlated without being flagged as deep-prefix churn", () => {
  const evaluation = evaluateCacheAudit([
    run(1, { ratio: { input: 20, read: 80 } }),
    run(2, { ratio: { input: 20, read: 80 }, additive: 1 }),
  ]);
  assert.equal(evaluation.additiveActivationCount, 1);
  assert.equal(evaluation.flags.deepPrefixChurn, false);
  assert.equal(evaluation.aggregateCacheRatio, 0.8);
});

test("stable decay epoch is healthy while frequent epoch changes recommend longer epochs", () => {
  const stable = evaluateCacheAudit([
    run(1, { epochs: ["epoch-a"] }),
    run(2, { epochs: ["epoch-a"] }),
    run(3, { epochs: ["epoch-a"] }),
    run(4, { epochs: ["epoch-a"] }),
  ]);
  assert.equal(stable.flags.decayEpochChurn, false);

  const churn = evaluateCacheAudit([
    run(1, { epochs: ["epoch-a"] }),
    run(2, { epochs: ["epoch-b"] }),
  ]);
  assert.equal(churn.flags.decayEpochChurn, true);
  assert.equal(churn.flags.deepPrefixChurn, true);
  assert.equal(churn.recommendation, "increase-decay-epoch-lifetime");
  assert.match(churn.recommendationText, /at least 3 settled runs/);
});

test("model/compaction/tree boundaries reset decay epoch stability accounting", () => {
  const evaluation = evaluateCacheAudit([
    run(1, { epochs: ["epoch-a"] }),
    run(2, { epochs: ["epoch-b"], boundary: "compaction" }),
  ]);
  assert.equal(evaluation.flags.decayEpochChurn, false);
  assert.equal(evaluation.epochTransitions, 0);
});

test("unexplained and non-additive changes flag deep-prefix churn", () => {
  assert.equal(
    evaluateCacheAudit([run(1, { unexplained: 1 })]).flags.deepPrefixChurn,
    true,
  );
  assert.equal(
    evaluateCacheAudit([run(1, { nonAdditive: 1 })]).flags.deepPrefixChurn,
    true,
  );
});

test("status is bounded metrics-only guidance", () => {
  const records = [
    run(1, { ratio: { input: 25, read: 75 }, epochs: ["epoch-a"] }),
  ];
  const status = formatCacheStatus(
    records,
    evaluateCacheAudit(records),
    "/private/telemetry.jsonl",
  );
  assert.match(status, /aggregate hit ratio: 75.0%/);
  assert.match(status, /Latest decay cache epoch: epoch-a/);
  assert.match(
    status,
    /never changes tools, system prompts, messages, decay, or context/,
  );
  assert.equal(status.includes("message body"), false);
});
