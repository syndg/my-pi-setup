import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkpointCore } from "../context-checkpoints/src/index.ts";
import {
  CheckpointManager,
  buildBootstrap,
  validateContinuationCheckpoint,
} from "./src/manager.ts";
import type {
  AtomicCheckpointStore,
  CheckpointRecord,
  HandoffRuntime,
  SessionEvidence,
  SetupSessionManager,
} from "./src/types.ts";

const entries = [
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: "Build controlled handoff.",
      timestamp: 0,
    },
  },
  {
    type: "custom",
    id: "r1",
    parentId: "u1",
    timestamp: new Date(1).toISOString(),
    customType: "summary-recap",
    data: {
      recap: "Checkpoint core was reviewed.",
      next: "Implement the handoff adapter.",
    },
  },
] as unknown as SessionEntry[];

function evidence(): SessionEvidence {
  return {
    sessionId: "parent-id",
    sessionFile: "/sessions/parent.jsonl",
    leafId: "r1",
    cwd: "/work",
    entries,
    capturedAtMs: 100,
  };
}

class MemoryStore implements AtomicCheckpointStore {
  writes: string[] = [];
  fail = false;
  async writeCheckpoint(input: Omit<CheckpointRecord, "artifactPath">) {
    if (this.fail) throw new Error("disk full");
    const record = {
      ...input,
      artifactPath: `/artifacts/${input.checkpointId}.json`,
    };
    this.writes.push("checkpoint");
    return { record, serialized: checkpointCore.serialize(record.checkpoint) };
  }
  async writeManifest(input: {
    checkpoint: CheckpointRecord;
    originalSessionFile: string;
    exactNextAction: string;
    bootstrap: string;
  }) {
    this.writes.push("manifest");
    return `/handoffs/${input.checkpoint.checkpointId}.json`;
  }
}

function fake(
  store: MemoryStore,
  options: {
    confirm?: boolean;
    cancelled?: boolean;
    active?: boolean;
    drift?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let capture = 0;
  const childEntries: unknown[] = [];
  const runtime: HandoffRuntime = {
    hasUI: true,
    async waitForIdle() {
      calls.push("idle");
    },
    captureEvidence() {
      capture += 1;
      return options.drift && capture > 1
        ? { ...evidence(), leafId: "changed" }
        : evidence();
    },
    appendOriginalCheckpoint() {
      calls.push("append-original");
    },
    activeTasks() {
      return options.active
        ? [
            {
              id: "bg-1",
              kind: "background",
              label: "build",
              status: "running",
              observedAtMs: 1,
            },
          ]
        : [];
    },
    async confirm() {
      calls.push("confirm");
      return options.confirm ?? true;
    },
    async newSession(input) {
      calls.push(`new:${input.parentSession}`);
      if (!options.cancelled) {
        const sm = {
          appendCustomEntry(type: string, data?: unknown) {
            calls.push(`setup:${type}`);
            childEntries.push(data);
            return "s1";
          },
          appendCustomMessageEntry(type: string, content: unknown) {
            calls.push(`setup:${type}`);
            childEntries.push(content);
            return "m1";
          },
          getHeader() {
            return {};
          },
          getEntries() {
            return [];
          },
          getSessionFile() {
            return "/sessions/child.jsonl";
          },
        } as unknown as SetupSessionManager;
        await input.setup(sm);
      }
      return { cancelled: options.cancelled ?? false };
    },
    notify() {},
  };
  return { runtime, calls, childEntries };
}

test("checkpoint validator reports omissions", () => {
  assert.throws(
    () => validateContinuationCheckpoint({}),
    /schemaVersion|validation failed/i,
  );
});

test("handoff prewrites, links parent, runs setup, and seeds bounded fresh context without a turn", async () => {
  const store = new MemoryStore();
  const f = fake(store);
  const result = await new CheckpointManager(store, async () => {}).handoff(
    f.runtime,
    "Open src/index.ts and implement command wiring.",
  );
  assert.equal(result.status, "handed-off");
  assert.deepEqual(store.writes, ["checkpoint", "manifest"]);
  assert.ok(
    f.calls.indexOf("append-original") <
      f.calls.findIndex((call) => call.startsWith("new:")),
  );
  assert.ok(f.calls.includes("new:/sessions/parent.jsonl"));
  assert.equal(f.childEntries.length, 2);
  assert.match(String(f.childEntries[1]), /Exact next action/);
});

test("user cancellation occurs before persistence or session replacement", async () => {
  const store = new MemoryStore();
  const f = fake(store, { confirm: false });
  assert.equal(
    (
      await new CheckpointManager(store, async () => {}).handoff(
        f.runtime,
        "Continue.",
      )
    ).status,
    "cancelled-before-prewrite",
  );
  assert.deepEqual(store.writes, []);
  assert.equal(
    f.calls.some((call) => call.startsWith("new:")),
    false,
  );
});

test("preflight failure, stale context, and active tasks never call newSession", async () => {
  for (const variant of ["failure", "stale", "active"] as const) {
    const store = new MemoryStore();
    if (variant === "failure") store.fail = true;
    const f = fake(store, {
      drift: variant === "stale",
      active: variant === "active",
    });
    await assert.rejects(() =>
      new CheckpointManager(store, async () => {}).handoff(
        f.runtime,
        "Continue.",
      ),
    );
    assert.equal(
      f.calls.some((call) => call.startsWith("new:")),
      false,
    );
  }
});

test("session gate cancellation preserves prepared recovery artifacts", async () => {
  const store = new MemoryStore();
  const f = fake(store, { cancelled: true });
  const result = await new CheckpointManager(store, async () => {}).handoff(
    f.runtime,
    "Continue.",
  );
  assert.equal(result.status, "cancelled-by-session-gate");
  assert.deepEqual(store.writes, ["checkpoint", "manifest"]);
});

test("continuation fixture produces a bounded bootstrap with artifact refs and exact action", async () => {
  const raw = await readFile(
    new URL(
      "../context-checkpoints/fixtures/continuation-checkpoint.v1.json",
      import.meta.url,
    ),
    "utf8",
  );
  const parsed = checkpointCore.parse(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const record: CheckpointRecord = {
    version: 1,
    checkpointId: "fixture",
    createdAtMs: 1,
    sourceSessionId: "session-original",
    sourceLeafId: "entry-01",
    artifactPath: "/checkpoint.json",
    checkpoint: parsed.checkpoint,
  };
  const bootstrap = buildBootstrap(
    record,
    "Connect the schema to the handoff adapter.",
  );
  assert.ok(Buffer.byteLength(bootstrap) <= 12 * 1024);
  assert.match(bootstrap, /context:\/\/artifact-01/);
  assert.match(bootstrap, /Connect the schema/);
});
