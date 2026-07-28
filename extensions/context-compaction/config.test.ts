import assert from "node:assert/strict";
import test from "node:test";
import {
  customEnabledForReason,
  DEFAULT_CONTEXT_COMPACTION_CONFIG,
  parseContextCompactionConfig,
} from "./src/config.ts";

test("production defaults preserve native manual/threshold/overflow compaction", () => {
  const config = parseContextCompactionConfig(undefined);
  assert.equal(customEnabledForReason("manual", config), false);
  assert.equal(customEnabledForReason("threshold", config), false);
  assert.equal(customEnabledForReason("overflow", config), false);
  assert.deepEqual(config, DEFAULT_CONTEXT_COMPACTION_CONFIG);
});

test("threshold requires both implementation and observation opt-ins", () => {
  assert.equal(
    customEnabledForReason(
      "threshold",
      parseContextCompactionConfig({
        threshold: { custom: true, observationOptIn: false },
      }),
    ),
    false,
  );
  assert.equal(
    customEnabledForReason(
      "threshold",
      parseContextCompactionConfig({
        threshold: { custom: true, observationOptIn: true },
      }),
    ),
    true,
  );
});

test("custom compaction remains available only by explicit per-reason opt-in", () => {
  assert.equal(
    customEnabledForReason(
      "manual",
      parseContextCompactionConfig({
        manual: { custom: true },
      }),
    ),
    true,
  );
  assert.equal(
    customEnabledForReason(
      "overflow",
      parseContextCompactionConfig({
        overflow: { experimentalCustom: true },
      }),
    ),
    true,
  );
});

test("invalid private fields fall back conservatively", () => {
  const config = parseContextCompactionConfig({
    manual: { custom: "yes" },
    threshold: { custom: true },
    retainedBoundary: {
      minimumTokens: 12_000,
      targetTokens: 10_000,
      maximumTokens: 8_000,
    },
    summaryModel: { provider: "", model: "", reasoning: "extreme" },
  });
  assert.equal(config.manual.custom, false);
  assert.equal(customEnabledForReason("threshold", config), false);
  assert.deepEqual(
    config.retainedBoundary,
    DEFAULT_CONTEXT_COMPACTION_CONFIG.retainedBoundary,
  );
  assert.deepEqual(
    config.summaryModel,
    DEFAULT_CONTEXT_COMPACTION_CONFIG.summaryModel,
  );
});
