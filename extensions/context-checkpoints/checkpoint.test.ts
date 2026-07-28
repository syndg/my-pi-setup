import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHECKPOINT_LIMITS,
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointValidationError,
  mergeCheckpoint,
  normalizeCheckpoint,
  parseCheckpoint,
  serializeCheckpoint,
  type ContextCheckpoint,
  type RunRecapInput,
  validateCheckpoint,
} from "./src/index.ts";

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function validFixture() {
  const validation = parseCheckpoint(
    fixture("continuation-checkpoint.v1.json"),
  );
  assert.equal(validation.ok, true);
  if (!validation.ok) throw new Error("Fixture must be valid");
  return validation.checkpoint;
}

function recapFixture() {
  const value: unknown = JSON.parse(fixture("run-recaps.json"));
  assert.ok(Array.isArray(value));
  for (const recap of value) {
    assert.equal(typeof recap, "object");
    assert.ok(recap !== null);
    assert.equal(typeof recap.recap, "string");
    assert.equal(typeof recap.next, "string");
  }
  return value as unknown as readonly RunRecapInput[];
}

test("parses the continuation fixture with every required section", () => {
  const checkpoint = validFixture();
  assert.equal(checkpoint.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.equal(
    checkpoint.goal,
    "Implement a resumable context checkpoint core.",
  );
  assert.equal(checkpoint.contextPolicyState.pressure, "orange");
  assert.equal(checkpoint.criticalReferences.length, 2);
  assert.equal(checkpoint.originalSession?.sessionId, "session-original");
});

test("reports every omitted top-level section with actionable paths", () => {
  const validation = validateCheckpoint({});
  assert.equal(validation.ok, false);
  if (validation.ok) throw new Error("Expected omissions");

  const paths = new Set(validation.issues.map((issue) => issue.path));
  for (const required of [
    "schemaVersion",
    "goal",
    "constraintsAndPreferences",
    "completedWork",
    "workingSet",
    "decisions",
    "changedFiles",
    "testsAndOutcomes",
    "unresolvedQuestions",
    "blockers",
    "nextActions",
    "criticalReferences",
    "contextPolicyState",
  ]) {
    assert.ok(paths.has(`$.${required}`), `missing issue for ${required}`);
  }
  assert.ok(
    validation.issues.every(
      (issue) => issue.code === "required" && issue.message.startsWith("Add"),
    ),
  );
});

test("rejects malformed and model-decorated JSON rather than guessing", () => {
  const malformed = parseCheckpoint(fixture("malformed-model-output.txt"));
  assert.equal(malformed.ok, false);
  if (malformed.ok) throw new Error("Expected malformed JSON");
  assert.equal(malformed.issues[0]?.code, "malformed-json");
  assert.match(malformed.issues[0]?.message ?? "", /Repair/);
});

test("rejects unsupported versions and unknown fields at every level", () => {
  const checkpoint = validFixture();
  const validation = validateCheckpoint({
    ...checkpoint,
    schemaVersion: "context-checkpoint/v2",
    surprise: true,
    contextPolicyState: {
      ...checkpoint.contextPolicyState,
      hiddenPolicy: "not allowed",
    },
  });

  assert.equal(validation.ok, false);
  if (validation.ok) throw new Error("Expected strict validation failure");
  assert.deepEqual(
    validation.issues.map(({ path, code }) => ({ path, code })),
    [
      { path: "$.surprise", code: "unknown-field" },
      { path: "$.schemaVersion", code: "unsupported-version" },
      {
        path: "$.contextPolicyState.hiddenPolicy",
        code: "unknown-field",
      },
    ],
  );
});

test("normalizes terminal controls, line endings, and duplicate entries without mutation", () => {
  const checkpoint = validFixture();
  const dirty: ContextCheckpoint = {
    ...checkpoint,
    goal: "  Implement\r\ncheckpoint core.  ",
    blockers: ["\u001b[31mBlocked\u001b[0m  ", "Blocked", "  "],
    contextPolicyState: {
      ...checkpoint.contextPolicyState,
      notes: ["  Advisory only. ", "Advisory only."],
    },
  };

  const normalized = normalizeCheckpoint(dirty);
  assert.equal(normalized.goal, "Implement\ncheckpoint core.");
  assert.deepEqual(normalized.blockers, ["Blocked"]);
  assert.deepEqual(normalized.contextPolicyState.notes, ["Advisory only."]);
  assert.equal(dirty.goal, "  Implement\r\ncheckpoint core.  ");
  assert.equal(dirty.blockers.length, 3);
});

test("serializes deterministically regardless of object insertion order", () => {
  const checkpoint = validFixture();
  const reversed = Object.fromEntries(Object.entries(checkpoint).reverse());

  const first = serializeCheckpoint(checkpoint);
  const second = serializeCheckpoint(reversed);
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.equal(
    serializeCheckpoint(parseCheckpoint(first).ok ? checkpoint : {}),
    first,
  );
});

test("merges durable history, recap work, and authoritative current snapshots", () => {
  const previous = validFixture();
  const result = mergeCheckpoint({
    previous,
    recaps: recapFixture(),
    updates: {
      goal: "Ship the approved checkpoint core.",
      constraintsAndPreferences: ["No lifecycle integration in Phase 5A."],
      workingSet: ["src/core.ts", "checkpoint.test.ts"],
      changedFiles: [
        {
          path: "src/types.ts",
          status: "modified",
          summary: "Finalized v1 types.",
        },
        { path: "src/core.ts", status: "created" },
      ],
      unresolvedQuestions: [],
      blockers: ["Awaiting schema approval."],
      criticalReferences: [
        {
          kind: "artifact",
          id: "artifact-01",
          uri: "context://artifact-01-v2",
          label: "Updated log",
        },
      ],
      contextPolicyState: {
        ...previous.contextPolicyState,
        pressure: "red",
        residentTokens: 180000,
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected merged checkpoint");
  const checkpoint = result.checkpoint;
  assert.equal(checkpoint.completedWork.length, 3);
  assert.match(
    checkpoint.completedWork[1] ?? "",
    /strict checkpoint validation/,
  );
  assert.deepEqual(checkpoint.workingSet, [
    "src/core.ts",
    "checkpoint.test.ts",
  ]);
  assert.deepEqual(checkpoint.unresolvedQuestions, []);
  assert.deepEqual(checkpoint.nextActions, [
    "Wire the checkpoint into handoff after schema approval.",
  ]);
  assert.equal(checkpoint.changedFiles[0]?.status, "modified");
  assert.equal(checkpoint.changedFiles.length, 2);
  assert.equal(
    checkpoint.criticalReferences[1]?.uri,
    "context://artifact-01-v2",
  );
  assert.equal(checkpoint.contextPolicyState.pressure, "red");
  assert.equal(checkpoint.originalSession?.sessionId, "session-original");
});

test("current next actions override recap suggestions and can explicitly be empty", () => {
  const result = mergeCheckpoint({
    previous: validFixture(),
    recaps: recapFixture(),
    updates: { nextActions: [] },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected valid merge");
  assert.deepEqual(result.checkpoint.nextActions, []);
});

test("never ignores a malformed previous checkpoint", () => {
  const previous = { ...validFixture() };
  delete (previous as { goal?: string }).goal;
  const result = mergeCheckpoint({
    previous,
    updates: { goal: "Replacement" },
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected malformed prior state failure");
  assert.equal(result.issues[0]?.path, "$.previous.goal");
  assert.match(
    result.issues[0]?.message ?? "",
    /Repair the previous checkpoint/,
  );
});

test("new checkpoint merge surfaces missing goal instead of inventing state", () => {
  const result = mergeCheckpoint({
    recaps: [{ recap: "Investigated the seam.", next: "Define the goal." }],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected a missing goal");
  assert.deepEqual(
    result.issues.map(({ path, code }) => ({ path, code })),
    [{ path: "$.goal", code: "empty" }],
  );
});

test("enforces UTF-8 field, section-count, reference-count, and total bounds", () => {
  const checkpoint = validFixture();
  const longUtf8 = validateCheckpoint({
    ...checkpoint,
    blockers: ["😀".repeat(Math.floor(CHECKPOINT_LIMITS.itemBytes / 4) + 1)],
  });
  assert.equal(longUtf8.ok, false);
  if (longUtf8.ok) throw new Error("Expected UTF-8 limit failure");
  assert.equal(longUtf8.issues[0]?.code, "too-long");

  const references = Array.from(
    { length: CHECKPOINT_LIMITS.maxCriticalReferences + 1 },
    (_, index) => ({ kind: "artifact", id: `artifact-${index}` }),
  );
  const tooManyReferences = validateCheckpoint({
    ...checkpoint,
    criticalReferences: references,
  });
  assert.equal(tooManyReferences.ok, false);
  if (tooManyReferences.ok) throw new Error("Expected reference limit failure");
  assert.ok(
    tooManyReferences.issues.some(
      (issue) =>
        issue.path === "$.criticalReferences" && issue.code === "too-many",
    ),
  );

  const oversized = validateCheckpoint({
    ...checkpoint,
    completedWork: Array.from(
      { length: 40 },
      (_, index) => `${index}:${"x".repeat(3_900)}`,
    ),
  });
  assert.equal(oversized.ok, false);
  if (oversized.ok) throw new Error("Expected total-size failure");
  assert.equal(oversized.issues[0]?.code, "total-size");
});

test("accepts explicit empty sections and an omitted original-session pointer", () => {
  const checkpoint = validFixture();
  const { originalSession: _originalSession, ...withoutPointer } = checkpoint;
  const validation = validateCheckpoint({
    ...withoutPointer,
    constraintsAndPreferences: [],
    completedWork: [],
    workingSet: [],
    decisions: [],
    changedFiles: [],
    testsAndOutcomes: [],
    unresolvedQuestions: [],
    blockers: [],
    nextActions: [],
    criticalReferences: [],
  });
  assert.equal(validation.ok, true);
});

test("serializer throws a structured validation error", () => {
  assert.throws(
    () => serializeCheckpoint({ schemaVersion: CHECKPOINT_SCHEMA_VERSION }),
    (error) => {
      assert.ok(error instanceof CheckpointValidationError);
      assert.ok(error.issues.some((issue) => issue.path === "$.goal"));
      return true;
    },
  );
});
