import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createContextMemory,
  MemoryPolicyError,
  projectMemoryScope,
} from "./src/core.ts";
import { createFileMemoryPersistence } from "./src/persistence.ts";
import {
  createOneTurnRecallGate,
  EXPIRED_RECALL_PLACEHOLDER,
  formatMemorySearchResult,
} from "./src/recall.ts";
import { redactCommonSecrets } from "./src/secrets.ts";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCHEMA_VERSION,
  type MemoryDocument,
  type MemoryPersistence,
  type MemoryPersistenceUpdate,
  type MemoryRecord,
} from "./src/types.ts";

class MemoryPersistenceAdapter implements MemoryPersistence {
  value: string | null;
  failCommit = false;
  constructor(value: string | null = null) {
    this.value = value;
  }
  async load() {
    return this.value;
  }
  async update<T>(
    operation: (
      serializedDocument: string | null,
    ) => MemoryPersistenceUpdate<T> | Promise<MemoryPersistenceUpdate<T>>,
  ) {
    const update = await operation(this.value);
    if (update.serializedDocument !== undefined) {
      if (this.failCommit) throw new Error("injected atomic commit failure");
      this.value = update.serializedDocument;
    }
    return update.result;
  }
}

function idGenerator(ids: string[]) {
  return () => ids.shift() ?? "mem_fallback";
}

function globalPreference(fact: string, reference = "explicit user request") {
  return {
    category: "user-preference" as const,
    scope: { kind: "global" as const },
    fact,
    source: { kind: "user-statement" as const, reference },
    confidence: 0.9,
  };
}

function textOf(message: AgentMessage): string {
  if (message.role !== "toolResult") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("persists the versioned stable-fact schema atomically with mode 0600", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-memory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "private", "memory.v1.json");
  const memory = createContextMemory({
    persistence: createFileMemoryPersistence(file),
    clock: () => 1_000,
    idGenerator: () => "mem_schema1",
  });
  const remembered = await memory.remember(
    globalPreference("Prefer concise validation reports."),
  );
  const document = JSON.parse(await readFile(file, "utf8")) as MemoryDocument;
  const record = document.records[0] as MemoryRecord;

  assert.equal(document.schemaVersion, MEMORY_SCHEMA_VERSION);
  assert.deepEqual(MEMORY_CATEGORIES, [
    "user-preference",
    "project-convention",
    "architectural-decision",
    "environment-fact",
  ]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, remembered.record.id);
  assert.deepEqual(record.scope, { kind: "global" });
  assert.equal(record.sources[0]?.kind, "user-statement");
  assert.equal(record.sources[0]?.reference, "explicit user request");
  assert.equal(record.createdAtMs, 1_000);
  assert.equal(record.updatedAtMs, 1_000);
  assert.equal(record.lastConfirmedAtMs, 1_000);
  assert.equal(record.expiresAtMs, 1_000 + 365 * 86_400_000);
  assert.equal(record.confidence, 0.9);
  assert.equal(record.status, "active");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  assert.equal((await readFile(file, "utf8")).includes(".tmp"), false);
});

test("concurrent independent file-backed instances merge mutations without clobbering facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-memory-concurrent-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "private", "memory.v1.json");
  const first = createContextMemory({
    persistence: createFileMemoryPersistence(file),
    idGenerator: () => "mem_process1",
  });
  const second = createContextMemory({
    persistence: createFileMemoryPersistence(file),
    idGenerator: () => "mem_process2",
  });

  await Promise.all([
    first.remember(globalPreference("Prefer independent process one.")),
    second.remember(globalPreference("Prefer independent process two.")),
  ]);

  const reader = createContextMemory({
    persistence: createFileMemoryPersistence(file),
  });
  const result = await reader.search({ scope: "global", limit: 20 });
  assert.deepEqual(result.matches.map((match) => match.record.id).sort(), [
    "mem_process1",
    "mem_process2",
  ]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
});

test("recovers an abandoned stale lock before applying a mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-memory-stale-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "private", "memory.v1.json");
  const lockPath = `${file}.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "abandoned", createdAtMs: 1 })}\n`,
    { mode: 0o600 },
  );
  await utimes(lockPath, new Date(0), new Date(0));

  const memory = createContextMemory({
    persistence: createFileMemoryPersistence(file, {
      lockWaitMs: 250,
      staleLockMs: 5,
      retryDelayMs: 1,
    }),
    idGenerator: () => "mem_recovered",
  });
  await memory.remember(globalPreference("Recover abandoned memory locks."));

  const result = await memory.search({ scope: "global" });
  assert.deepEqual(
    result.matches.map((match) => match.record.id),
    ["mem_recovered"],
  );
  await assert.rejects(
    stat(lockPath),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
});

test("active locks bound mutation waits while snapshot reads remain available", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "context-memory-bounded-lock-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "private", "memory.v1.json");
  const initial = createContextMemory({
    persistence: createFileMemoryPersistence(file),
    idGenerator: () => "mem_existing",
  });
  await initial.remember(
    globalPreference("Keep reads available during lock contention."),
  );

  const lockPath = `${file}.lock`;
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "active", createdAtMs: Date.now() })}\n`,
    { mode: 0o600 },
  );
  assert.equal((await stat(lockPath)).mode & 0o777, 0o700);
  assert.equal((await stat(join(lockPath, "owner.json"))).mode & 0o777, 0o600);

  const contended = createContextMemory({
    persistence: createFileMemoryPersistence(file, {
      lockWaitMs: 25,
      staleLockMs: 5,
      retryDelayMs: 2,
    }),
    idGenerator: () => "mem_blocked",
  });
  const readable = await contended.search({ scope: "global" });
  assert.deepEqual(
    readable.matches.map((match) => match.record.id),
    ["mem_existing"],
  );
  await assert.rejects(
    contended.remember(globalPreference("This write must time out safely.")),
    /Timed out after 25ms waiting for memory lock/,
  );
  assert.deepEqual(
    (await contended.search({ scope: "global" })).matches.map(
      (match) => match.record.id,
    ),
    ["mem_existing"],
  );
});

test("enforces field, record, storage, result, and recall byte bounds", async () => {
  const persistence = new MemoryPersistenceAdapter();
  const memory = createContextMemory({
    persistence,
    idGenerator: idGenerator(["mem_bound01", "mem_bound02"]),
    limits: {
      maximumRecords: 1,
      maximumStorageBytes: 2_048,
      maximumFactBytes: 64,
      maximumReferenceBytes: 64,
      defaultRecallBytes: 512,
      maximumRecallBytes: 512,
    },
  });
  await assert.rejects(
    memory.remember(globalPreference("x".repeat(65))),
    (error: unknown) =>
      error instanceof MemoryPolicyError && error.code === "field-bound",
  );
  await memory.remember(globalPreference("Use TypeScript."));
  await assert.rejects(
    memory.remember({
      ...globalPreference("Prefer Node.js."),
      category: "environment-fact",
    }),
    (error: unknown) =>
      error instanceof MemoryPolicyError && error.code === "storage-bound",
  );
  const result = await memory.search({
    scope: "global",
    query: "typescript",
    limit: 99,
    maxBytes: 200,
  });
  const formatted = formatMemorySearchResult(result, 200);
  assert.ok(result.matches.length <= 1);
  assert.ok(result.returnedBytes <= 200);
  assert.ok(Buffer.byteLength(formatted, "utf8") <= 200);
});

test("isolates global and current-project scopes", async () => {
  const persistence = new MemoryPersistenceAdapter();
  const memory = createContextMemory({
    persistence,
    idGenerator: idGenerator(["mem_global1", "mem_projecta", "mem_projectb"]),
  });
  await memory.remember(globalPreference("Use concise answers."));
  await memory.remember({
    category: "project-convention",
    scope: projectMemoryScope("/projects/a"),
    fact: "Use pnpm for package scripts.",
    source: {
      kind: "project-document",
      reference: "/projects/a/AGENTS.md#package-manager",
    },
  });
  await memory.remember({
    category: "architectural-decision",
    scope: projectMemoryScope("/projects/b"),
    fact: "Use append-only event storage.",
    source: {
      kind: "architecture-record",
      reference: "/projects/b/docs/adr-001.md",
    },
  });

  const projectA = await memory.search({
    scope: "all",
    project: "/projects/a",
  });
  assert.deepEqual(projectA.matches.map((match) => match.record.id).sort(), [
    "mem_global1",
    "mem_projecta",
  ]);
  const global = await memory.search({ scope: "global" });
  assert.deepEqual(
    global.matches.map((match) => match.record.id),
    ["mem_global1"],
  );
  const projectBOnly = await memory.search({
    scope: "project",
    project: "/projects/b",
  });
  assert.deepEqual(
    projectBOnly.matches.map((match) => match.record.id),
    ["mem_projectb"],
  );
  assert.equal(
    (await memory.forget({ id: "mem_projectb", project: "/projects/a" }))
      .forgotten,
    false,
  );
  assert.equal(
    (await memory.forget({ id: "mem_projectb", project: "/projects/b" }))
      .forgotten,
    true,
  );
  await assert.rejects(
    memory.remember({
      ...globalPreference("Always use pnpm."),
      category: "project-convention",
    }),
    (error: unknown) =>
      error instanceof MemoryPolicyError && error.code === "scope",
  );
});

test("deduplicates exact normalized facts without fuzzy contradiction merging", async () => {
  let now = 100;
  const persistence = new MemoryPersistenceAdapter();
  const memory = createContextMemory({
    persistence,
    clock: () => now,
    idGenerator: idGenerator(["mem_dedup01", "mem_other01"]),
  });
  const first = await memory.remember(
    globalPreference("Prefer concise reports.", "request-one"),
  );
  now = 200;
  const duplicate = await memory.remember({
    ...globalPreference("prefer concise reports", "request-two"),
    confidence: 0.95,
  });
  const contradiction = await memory.remember(
    globalPreference("Prefer detailed reports.", "request-three"),
  );
  const all = await memory.search({ scope: "global" });

  assert.equal(first.created, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(duplicate.record.sources.length, 2);
  assert.equal(duplicate.record.confidence, 0.95);
  assert.equal(duplicate.record.createdAtMs, 100);
  assert.equal(duplicate.record.lastConfirmedAtMs, 200);
  assert.equal(contradiction.created, true);
  assert.equal(all.matched, 2);
  const consolidated = await memory.consolidate({ scope: "global" });
  assert.equal(consolidated.duplicatesMerged, 0);
  assert.equal(consolidated.after, 2);
});

test("explicit consolidation removes expired records while search remains read-only", async () => {
  let now = 0;
  const persistence = new MemoryPersistenceAdapter();
  const memory = createContextMemory({
    persistence,
    clock: () => now,
    idGenerator: () => "mem_expire1",
  });
  await memory.remember({
    ...globalPreference("Prefer short-lived fixture memory."),
    retentionDays: 1,
  });
  const beforeSearch = persistence.value;
  now = 86_400_001;
  const hidden = await memory.search({ scope: "global" });
  assert.equal(hidden.matched, 0);
  assert.equal(
    persistence.value,
    beforeSearch,
    "search must not run retention writes",
  );
  const result = await memory.consolidate({ scope: "global" });
  assert.deepEqual(result, {
    before: 1,
    after: 0,
    duplicatesMerged: 0,
    expiredRemoved: 1,
  });
  assert.equal(
    (JSON.parse(persistence.value as string) as MemoryDocument).records.length,
    0,
  );
});

test("failed atomic commit leaves the previously committed document unchanged", async () => {
  const persistence = new MemoryPersistenceAdapter();
  const memory = createContextMemory({
    persistence,
    idGenerator: idGenerator(["mem_atomic1", "mem_atomic2"]),
  });
  await memory.remember(globalPreference("Prefer atomic persistence."));
  const committed = persistence.value;
  persistence.failCommit = true;
  await assert.rejects(
    memory.remember({
      ...globalPreference("Prefer durable rename."),
      category: "environment-fact",
    }),
    /atomic commit failure/,
  );
  assert.equal(persistence.value, committed);
});

test("rejects common secrets by default and supports an explicit redaction seam", async () => {
  const rejectedStore = new MemoryPersistenceAdapter();
  const rejected = createContextMemory({
    persistence: rejectedStore,
    idGenerator: () => "mem_secret1",
  });
  await assert.rejects(
    rejected.remember(globalPreference("The API key is sk-abcdefghijklmnop.")),
    (error: unknown) =>
      error instanceof MemoryPolicyError && error.code === "secret",
  );
  assert.equal(rejectedStore.value, null);

  const redactedStore = new MemoryPersistenceAdapter();
  const redacted = createContextMemory({
    persistence: redactedStore,
    secretPolicy: redactCommonSecrets,
    idGenerator: () => "mem_secret2",
  });
  const result = await redacted.remember(
    globalPreference(
      "The API key is sk-abcdefghijklmnop.",
      "token=supersecret",
    ),
  );
  assert.ok(result.redactionCount >= 2);
  assert.match(result.record.fact, /\[REDACTED\]/);
  assert.equal(
    (redactedStore.value as string).includes("abcdefghijklmnop"),
    false,
  );
  assert.equal((redactedStore.value as string).includes("supersecret"), false);
});

test("rejects transcript, checkpoint, live-task, and tool-output-shaped writes", async () => {
  const memory = createContextMemory({
    persistence: new MemoryPersistenceAdapter(),
    idGenerator: () => "mem_stable1",
  });
  for (const fact of [
    "User: fix the bug\nAssistant: working on it",
    "Checkpoint: tests passed and next action is commit",
    "Current task: edit src/index.ts",
    "For this task use a temporary branch",
    "Tool output: 200 files matched",
  ]) {
    await assert.rejects(
      memory.remember(globalPreference(fact)),
      (error: unknown) =>
        error instanceof MemoryPolicyError && error.code === "not-stable-fact",
    );
  }
});

test("bounded recall survives one provider context call only and never injects other transcript data", () => {
  const gate = createOneTurnRecallGate(180);
  gate.arm("new-recall");
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: "live task transcript stays exactly here",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "old-recall",
      toolName: "memory_search",
      content: [{ type: "text", text: "old permanent fact must not remain" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "new-recall",
      toolName: "memory_search",
      content: [{ type: "text", text: "new recalled fact ".repeat(30) }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "ordinary",
      toolName: "read",
      content: [{ type: "text", text: "ordinary tool output unchanged" }],
      isError: false,
      timestamp: 4,
    },
  ];
  const first = gate.transform(messages);
  assert.equal(first[0], messages[0]);
  assert.equal(first[3], messages[3]);
  assert.equal(textOf(first[1] as AgentMessage), EXPIRED_RECALL_PLACEHOLDER);
  assert.match(textOf(first[2] as AgentMessage), /new recalled fact/);
  assert.ok(Buffer.byteLength(textOf(first[2] as AgentMessage), "utf8") <= 180);
  assert.equal(gate.armedCount(), 0);

  const second = gate.transform(messages);
  assert.equal(textOf(second[2] as AgentMessage), EXPIRED_RECALL_PLACEHOLDER);
  assert.equal(JSON.stringify(second).includes("old permanent fact"), false);
  assert.equal(
    JSON.stringify(second).includes("live task transcript stays exactly here"),
    true,
  );
  assert.equal(
    JSON.stringify(second).includes("ordinary tool output unchanged"),
    true,
  );
});
