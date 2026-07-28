import assert from "node:assert/strict";
import test from "node:test";
import {
  contextWireFingerprint,
  createContextWireState,
  isAppliedContextWireState,
  isContextWireState,
  matchContextWireState,
  newerContextWireState,
} from "./context-wire-state.ts";

function state(
  overrides: Partial<Parameters<typeof createContextWireState>[0]> = {},
) {
  return createContextWireState({
    sequence: 1,
    mode: "applied",
    stable: true,
    sessionId: "session-a",
    branchLeafId: "leaf-a",
    modelKey: "provider/model/100000",
    contextGeneration: "uncompacted",
    inputFingerprint: "ctx-input",
    outputFingerprint: "ctx-output",
    residentTokens: 1_000,
    effectiveWireTokens: 750,
    tokensSaved: 250,
    epochId: "decay-epoch",
    cacheEpochId: "decay-epoch",
    provenance: "explicit-apply-transform",
    candidateCount: 3,
    actionCount: 1,
    sequenceValid: true,
    inputMessageCount: 4,
    outputMessageCount: 4,
    ...overrides,
  });
}

test("creates a validated immutable metadata-only wire state", () => {
  const value = state();
  assert.equal(isContextWireState(value), true);
  assert.equal(isAppliedContextWireState(value), true);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value).includes("message body"), false);
});

test("rejects inconsistent accounting and non-applied stable claims", () => {
  assert.throws(() => state({ tokensSaved: 249 }));
  assert.throws(() => state({ effectiveWireTokens: 1_001, tokensSaved: 0 }));
  assert.throws(() => state({ actionCount: 4 }));
  assert.throws(() => state({ mode: "shadow", provenance: "shadow-plan" }));
});

test("matches only the complete session/model/generation/leaf/context identity", () => {
  const value = state();
  const identity = {
    sessionId: "session-a",
    branchLeafId: "leaf-a",
    modelKey: "provider/model/100000",
    contextGeneration: "uncompacted",
    contextFingerprint: "ctx-output",
  };
  assert.equal(matchContextWireState(value, identity), "output");
  assert.equal(
    matchContextWireState(value, {
      ...identity,
      contextFingerprint: "ctx-input",
    }),
    "input",
  );
  for (const mismatch of [
    { sessionId: "session-b" },
    { branchLeafId: "leaf-b" },
    { modelKey: "provider/other/100000" },
    { contextGeneration: "compaction:c1" },
    { contextFingerprint: "ctx-stale" },
  ]) {
    assert.equal(
      matchContextWireState(value, { ...identity, ...mismatch }),
      null,
    );
  }
});

test("rejects stale same-epoch event ordering but permits a new compatibility scope", () => {
  const current = state({ sequence: 4 });
  assert.strictEqual(
    newerContextWireState(current, state({ sequence: 3 })),
    current,
  );
  assert.equal(
    newerContextWireState(current, state({ sequence: 5 }))?.sequence,
    5,
  );
  assert.equal(
    newerContextWireState(
      current,
      state({ sequence: 1, sessionId: "session-b" }),
    )?.sessionId,
    "session-b",
  );
});

test("context fingerprints are deterministic and sensitive to append/order", () => {
  const first = [{ role: "user", content: "hello" }];
  assert.equal(contextWireFingerprint(first), contextWireFingerprint(first));
  assert.notEqual(
    contextWireFingerprint(first),
    contextWireFingerprint([...first, { role: "user", content: "next" }]),
  );
  assert.notEqual(
    contextWireFingerprint(first),
    contextWireFingerprint([{ role: "assistant" }, ...first]),
  );
});
