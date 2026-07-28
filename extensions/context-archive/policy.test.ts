import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OUTPUT_BROKER_CONFIG,
  inferOutputClass,
  parseOutputBrokerConfig,
  resolveOutputBudget,
} from "./src/index.ts";

const KiB = 1024;

test("Phase 2 defaults match every pressure row", () => {
  assert.deepEqual(DEFAULT_OUTPUT_BROKER_CONFIG.budgets, {
    read: { green: 20 * KiB, yellow: 14 * KiB, orange: 8 * KiB, red: 4 * KiB },
    search: {
      green: 16 * KiB,
      yellow: 10 * KiB,
      orange: 6 * KiB,
      red: 3 * KiB,
    },
    "mcp-result": {
      green: 16 * KiB,
      yellow: 10 * KiB,
      orange: 6 * KiB,
      red: 3 * KiB,
    },
    "subagent-final": {
      green: 8 * KiB,
      yellow: 6 * KiB,
      orange: 4 * KiB,
      red: 2 * KiB,
    },
    "child-live-message": {
      green: 4 * KiB,
      yellow: 3 * KiB,
      orange: 2 * KiB,
      red: 1 * KiB,
    },
    "background-completion": {
      green: 2 * KiB,
      yellow: 1 * KiB,
      orange: 1 * KiB,
      red: 0,
    },
  });
});

test("pressure policy consumes governor levels and maps emergency to Red", () => {
  for (const [pressure, expected] of [
    [null, 20 * KiB],
    ["green", 20 * KiB],
    ["yellow", 14 * KiB],
    ["orange", 8 * KiB],
    ["red", 4 * KiB],
    ["emergency", 4 * KiB],
  ] as const) {
    assert.equal(
      resolveOutputBudget({ toolName: "read", pressure }).appliedLimitBytes,
      expected,
    );
  }
});

test("explicit limits override defaults but never the hard safety ceiling", () => {
  const raised = resolveOutputBudget({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 50 * KiB,
  });
  assert.equal(raised.appliedLimitBytes, 50 * KiB);
  assert.equal(raised.usedExplicitLimit, true);
  assert.equal(raised.boundedByHardCeiling, false);

  const bounded = resolveOutputBudget({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: 500 * KiB,
  });
  assert.equal(bounded.appliedLimitBytes, 64 * KiB);
  assert.equal(bounded.requestedLimitBytes, 500 * KiB);
  assert.equal(bounded.boundedByHardCeiling, true);

  const invalid = resolveOutputBudget({
    toolName: "read",
    pressure: "red",
    explicitLimitBytes: Number.NaN,
  });
  assert.equal(invalid.appliedLimitBytes, 4 * KiB);
  assert.equal(invalid.usedExplicitLimit, false);
});

test("configuration normalizes independently and clamps caps to its ceiling", () => {
  const config = parseOutputBrokerConfig({
    hardCeilingBytes: 5_000,
    budgets: {
      read: { green: 9_000, yellow: -1, orange: 2_222 },
      "background-completion": { red: 17 },
    },
  });
  assert.equal(config.budgets.read.green, 5_000);
  assert.equal(config.budgets.read.yellow, 5_000);
  assert.equal(config.budgets.read.orange, 2_222);
  assert.equal(config.budgets.read.red, 4 * KiB);
  assert.equal(config.budgets["background-completion"].red, 17);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.budgets.read));
});

test("known adapter names infer stable output classes", () => {
  assert.equal(inferOutputClass("read"), "read");
  assert.equal(inferOutputClass("rg"), "search");
  assert.equal(inferOutputClass("fd"), "search");
  assert.equal(inferOutputClass("subagent_final"), "subagent-final");
  assert.equal(inferOutputClass("child message"), "child-live-message");
  assert.equal(inferOutputClass("bg_status"), "background-completion");
  assert.equal(inferOutputClass("mcp"), "mcp-result");
});
