import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyGovernorState,
  isGovernorState,
} from "./context-governor-state.ts";

test("accepts the empty governor snapshot", () => {
  assert.equal(isGovernorState(emptyGovernorState()), true);
});

test("rejects semantically invalid governor snapshots", () => {
  const state = emptyGovernorState();
  const invalidValues = [
    {
      ...state,
      pressure: { level: "purple", reasons: [] },
    },
    {
      ...state,
      toolResultBytesByTool: { read: -1 },
    },
    {
      ...state,
      toolResultBytesByTool: { read: 1.5 },
    },
    {
      ...state,
      measurement: {
        tokens: 10,
        contextWindow: 100,
        percent: 10,
        source: "unknown",
        unknownReason: "usage-unavailable",
      },
    },
    {
      ...state,
      measurement: {
        tokens: null,
        contextWindow: 100,
        percent: null,
        source: "pi-usage",
      },
    },
    {
      ...state,
      measurement: {
        tokens: null,
        contextWindow: 100,
        percent: null,
        source: "unknown",
        unknownReason: "invalid-reason",
      },
    },
    {
      ...state,
      growth: { ...state.growth, sampleCount: 1.5 },
    },
    {
      ...state,
      safeLimitRatio: -0.1,
    },
    {
      ...state,
      budget: {
        ...state.budget,
        nativeSource: "unavailable",
        nativeProactiveEnabled: true,
      },
    },
  ];

  for (const value of invalidValues) {
    assert.equal(isGovernorState(value), false);
  }
});
