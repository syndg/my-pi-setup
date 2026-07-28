import assert from "node:assert/strict";
import test from "node:test";
import { childToolPolicy } from "../shared/child-session.ts";
import {
  emptyGovernorState,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
import { CLAUDE_DISALLOWED_TOOLS } from "./src/backends/claude.ts";
import { CODEX_APP_SERVER_ARGS } from "./src/backends/codex.ts";
import {
  buildDelegatedChildPrompt,
  delegatedArtifactReferences,
  resolveDelegationPolicy,
} from "./src/delegation.ts";

function state(level: PressureLevel | null, capturedAtMs = 10_000) {
  return {
    ...emptyGovernorState(),
    capturedAtMs,
    sessionId: "session-a",
    pressure: { level, reasons: level ? ["test"] : [] },
  };
}

test("fresh same-session pressure selects explicit profile budgets", () => {
  const yellowResearch = resolveDelegationPolicy({
    governorState: state("yellow"),
    sessionId: "session-a",
    requestedProfile: "research",
    nowMs: 10_001,
  });
  const redMinimal = resolveDelegationPolicy({
    governorState: state("red"),
    sessionId: "session-a",
    requestedProfile: "minimal",
    nowMs: 10_001,
  });
  assert.deepEqual(
    {
      pressure: yellowResearch.pressure,
      profile: yellowResearch.profile,
      budget: yellowResearch.outputBudgetBytes,
    },
    { pressure: "yellow", profile: "research", budget: 8_192 },
  );
  assert.equal(redMinimal.outputBudgetBytes, 2_048);
  assert.equal(yellowResearch.guidanceActive, true);
});

test("missing, invalid, stale, wrong-session, and unknown pressure fail conservative", () => {
  const cases = [
    { governorState: undefined, expected: "missing" },
    { governorState: {}, expected: "invalid" },
    { governorState: state("yellow", 1), expected: "stale" },
    {
      governorState: { ...state("yellow"), sessionId: "other" },
      expected: "wrong-session",
    },
    { governorState: state(null, 200_000), expected: "unknown-pressure" },
  ] as const;
  for (const item of cases) {
    const policy = resolveDelegationPolicy({
      governorState: item.governorState,
      sessionId: "session-a",
      requestedProfile: "review",
      nowMs: 200_000,
    });
    assert.equal(policy.stateDisposition, item.expected);
    assert.equal(policy.pressure, "conservative");
    assert.equal(policy.outputBudgetBytes, 4_096);
  }
});

test("child prompt injection is a bounded structured user-task contract for every harness", () => {
  const policy = resolveDelegationPolicy({
    governorState: state("orange"),
    sessionId: "session-a",
    requestedProfile: "coding",
    nowMs: 10_001,
  });
  assert.equal(policy.injectionSurface, "child-user-prompt");
  for (const harness of ["pi", "claude", "codex"] as const) {
    const prompt = buildDelegatedChildPrompt({
      prompt: "Inspect src only.",
      harness,
      policy,
    });
    assert.ok(prompt.startsWith("Inspect src only."));
    assert.match(prompt, /Summary; Files changed\/reviewed; Decisions/);
    assert.match(prompt, /8192 UTF-8 bytes/);
    assert.match(prompt, /Do not spawn or coordinate other agents\/workflows/);
    assert.match(prompt, /artifact URIs/);
  }
});

test("recursive orchestration is disabled per harness without claiming OS isolation", () => {
  const pi = childToolPolicy("coding", ["message_orchestrator"]);
  assert.equal(pi.tools.includes("subagent_spawn"), false);
  assert.deepEqual([...CLAUDE_DISALLOWED_TOOLS], ["Agent", "Task"]);
  assert.deepEqual([...CODEX_APP_SERVER_ARGS].slice(-2), [
    "--disable",
    "multi_agent",
  ]);
});

test("completion references the durable child transcript instead of embedding it", () => {
  assert.deepEqual(delegatedArtifactReferences(" /tmp/child.jsonl "), [
    "/tmp/child.jsonl",
  ]);
  assert.deepEqual(delegatedArtifactReferences(undefined), []);
});
