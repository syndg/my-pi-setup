import assert from "node:assert/strict";
import test from "node:test";
import { childToolPolicy } from "../shared/child-session.ts";
import {
  emptyGovernorState,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
import {
  buildDelegatedChildPrompt,
  delegatedArtifactReferences,
  resolveDelegationPolicy,
} from "./src/delegation.ts";
import { BACKEND_NAMES } from "./src/domain.ts";

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

test("Pi is the only exposed harness", () => {
  assert.deepEqual(BACKEND_NAMES, ["pi"]);
});

test("child prompt injection is a bounded structured Pi task contract", () => {
  const policy = resolveDelegationPolicy({
    governorState: state("orange"),
    sessionId: "session-a",
    requestedProfile: "coding",
    nowMs: 10_001,
  });
  assert.equal(policy.injectionSurface, "child-user-prompt");
  const prompt = buildDelegatedChildPrompt({
    prompt: "Inspect src only.",
    harness: "pi",
    policy,
  });
  assert.ok(prompt.startsWith("Inspect src only."));
  assert.match(prompt, /Pi enforces the coding schema allowlist/);
  assert.match(prompt, /Summary; Files changed\/reviewed; Decisions/);
  assert.match(prompt, /8192 UTF-8 bytes/);
  assert.match(prompt, /Do not spawn or coordinate other agents\/workflows/);
  assert.match(prompt, /artifact URIs/);
});

test("recursive orchestration is disabled without claiming OS isolation", () => {
  const pi = childToolPolicy("coding", ["message_orchestrator"]);
  assert.equal(pi.tools.includes("subagent_spawn"), false);
});

test("completion references the durable child transcript instead of embedding it", () => {
  assert.deepEqual(delegatedArtifactReferences(" /tmp/child.jsonl "), [
    "/tmp/child.jsonl",
  ]);
  assert.deepEqual(delegatedArtifactReferences(undefined), []);
});
