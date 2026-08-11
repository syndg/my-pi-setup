import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createContextOutputExtension } from "./index.ts";
import { parseContextOutputConfig } from "./src/config.ts";
import { offerCompletion } from "./src/completion.ts";

class FakePi {
  readonly events = createEventBus();
  readonly handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  readonly tools = new Map<string, any>();
  readonly entries: Array<{ type: string; data: unknown }> = [];
  readonly messages: Array<{ message: any; options: any }> = [];
  on(name: string, handler: (event: any, ctx: any) => any) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  registerTool(tool: any) {
    this.tools.set(tool.name, tool);
  }
  appendEntry(type: string, data: unknown) {
    this.entries.push({ type, data });
  }
  sendMessage(message: any, options: any) {
    this.messages.push({ message, options });
  }
  async emit(name: string, event: any, ctx: any = {}) {
    let result: any;
    for (const handler of this.handlers.get(name) ?? [])
      result = await handler(event, ctx);
    return result;
  }
}

const config = parseContextOutputConfig({
  mode: "enforce",
  explicitLimitBytes: { read: 512 },
  metrics: { appendEntries: true, maximumEntriesPerSession: 1 },
});
const context = (id: string, entries: any[] = []) => ({
  sessionManager: { getSessionId: () => id, getBranch: () => entries },
});

test("successful completion brokerage queues a waking follow-up without claiming confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-output-completion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pi = new FakePi();
  createContextOutputExtension({ config, rootDirectory: root })(
    pi as unknown as ExtensionAPI,
  );
  await pi.emit("session_start", {}, context("completion-session"));

  const delivery = offerCompletion(pi.events, {
    kind: "subagent",
    id: "sa-1:run-1",
    title: "review",
    status: "success",
    output: "done",
    toolName: "subagent_completion",
    outputClass: "subagent-final",
    customType: "subagent-result",
  });

  assert.ok(delivery);
  assert.deepEqual(await delivery, {
    claimed: true,
    accepted: true,
    delivered: true,
    deliveryConfirmed: false,
    wokeParent: true,
  });
  assert.deepEqual(pi.messages[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});

test("shutdown rejects an in-flight completion before it reaches a replacement session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-output-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pi = new FakePi();
  createContextOutputExtension({ config, rootDirectory: root })(
    pi as unknown as ExtensionAPI,
  );
  await pi.emit("session_start", {}, context("old-session"));

  const delivery = offerCompletion(pi.events, {
    kind: "subagent",
    id: "sa-1:run-1",
    title: "review",
    status: "success",
    output: "large enough to archive ".repeat(2_000),
    toolName: "subagent_completion",
    outputClass: "subagent-final",
    customType: "subagent-result",
  });
  assert.ok(delivery);
  await pi.emit("session_shutdown", {});

  const outcome = await delivery;
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.delivered, false);
  assert.match(outcome.error ?? "", /session changed/);
  assert.deepEqual(pi.messages, []);
});

test("JSONL metrics are bounded/count-only and same-session artifacts survive resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-output-life-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new FakePi();
  createContextOutputExtension({ config, rootDirectory: root })(
    first as unknown as ExtensionAPI,
  );
  await first.emit("session_start", {}, context("resume-me"));
  const raw = "secret-body-".repeat(1000);
  const patched = await first.emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "call-1",
    input: {},
    content: [{ type: "text", text: raw }],
    details: { preserved: true },
    isError: false,
  });
  const marker = patched.content[0].text as string;
  const uri = marker.match(/context:\/\/[a-f0-9]{24}\/[a-z0-9_-]+/i)?.[0];
  assert.ok(uri);
  assert.equal(first.entries.length, 1);
  assert.equal(JSON.stringify(first.entries).includes("secret-body"), false);
  assert.equal((first.entries[0]!.data as any).outcome, "shortened");

  const second = new FakePi();
  createContextOutputExtension({ config, rootDirectory: root })(
    second as unknown as ExtensionAPI,
  );
  await second.emit("session_start", {}, context("resume-me"));
  const recall = await second.tools
    .get("context_recall")
    .execute(
      "recall-1",
      { artifact: uri, max_bytes: 128 },
      undefined,
      undefined,
      context("resume-me"),
    );
  assert.match(recall.content[0].text, /secret-body/);
});

test("context_recall safely bounds durable session entries by ID or session-entry URI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-output-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: `durable-secret-${"x".repeat(2000)}`,
      timestamp: 0,
    },
  };
  const pi = new FakePi();
  createContextOutputExtension({ config, rootDirectory: root })(
    pi as unknown as ExtensionAPI,
  );
  await pi.emit("session_start", {}, context("session-a", [entry]));
  const tool = pi.tools.get("context_recall");
  const byId = await tool.execute("r1", { artifact: "entry-1", max_bytes: 64 });
  assert.match(byId.content[0].text, /session-entry:\/\/session-a\/entry-1/);
  assert.ok((byId.details.returnedBytes as number) <= 64);
  const byUri = await tool.execute("r2", {
    artifact: "session-entry://session-a/entry-1",
    start_line: 1,
    line_count: 2,
    max_bytes: 80,
  });
  assert.ok((byUri.details.returnedBytes as number) <= 80);
  await assert.rejects(
    () => tool.execute("r3", { artifact: "session-entry://other/entry-1" }),
    /another session/,
  );
  await assert.rejects(() =>
    tool.execute("r4", { artifact: "/tmp/not-allowed" }),
  );
});
