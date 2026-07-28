import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContextMemoryExtension } from "./index.ts";
import type {
  ConsolidateMemoryInput,
  ContextMemory,
  ForgetMemoryInput,
  RememberMemoryInput,
  SearchMemoryInput,
} from "./src/types.ts";

class FakeMemory implements ContextMemory {
  remembers: RememberMemoryInput[] = [];
  searches: SearchMemoryInput[] = [];
  forgets: ForgetMemoryInput[] = [];
  consolidations: ConsolidateMemoryInput[] = [];
  async remember(input: RememberMemoryInput) {
    this.remembers.push(input);
    return {
      record: {
        schemaVersion: 1 as const,
        id: "mem_fixture1",
        category: input.category,
        scope: input.scope,
        fact: input.fact,
        sources: [input.source],
        createdAtMs: 1,
        updatedAtMs: 1,
        lastConfirmedAtMs: 1,
        expiresAtMs: 2,
        confidence: input.confidence ?? 0.8,
        status: "active" as const,
      },
      created: true,
      deduplicated: false,
      expiredRemoved: 0,
      redactionCount: 0,
    };
  }
  async search(input: SearchMemoryInput = {}) {
    this.searches.push(input);
    const record = {
      schemaVersion: 1 as const,
      id: "mem_fixture1",
      category: "user-preference" as const,
      scope: { kind: "global" as const },
      fact: "Prefer concise answers.",
      sources: [
        { kind: "user-statement" as const, reference: "explicit request" },
      ],
      createdAtMs: 1,
      updatedAtMs: 1,
      lastConfirmedAtMs: 1,
      expiresAtMs: 2,
      confidence: 0.9,
      status: "active" as const,
    };
    return {
      matches: [{ record, score: 4 }],
      matched: 1,
      limited: false,
      returnedBytes: 100,
      maximumBytes: 4096,
    };
  }
  async forget(input: ForgetMemoryInput) {
    this.forgets.push(input);
    return { forgotten: true, id: input.id };
  }
  async consolidate(input: ConsolidateMemoryInput = {}) {
    this.consolidations.push(input);
    return { before: 1, after: 1, duplicatesMerged: 0, expiredRemoved: 0 };
  }
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  readonly tools = new Map<string, any>();
  readonly commands = new Map<string, any>();
  on(name: string, handler: (event: any, ctx: any) => any) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  registerTool(tool: any) {
    this.tools.set(tool.name, tool);
  }
  registerCommand(name: string, command: any) {
    this.commands.set(name, command);
  }
  async emit(name: string, event: any, ctx: any = {}) {
    let current = event;
    let result: any;
    for (const handler of this.handlers.get(name) ?? []) {
      result = await handler(current, ctx);
      if (name === "context" && result?.messages)
        current = { ...current, messages: result.messages };
    }
    return result;
  }
}

const ctx = {
  cwd: "/projects/current",
  ui: { notify() {} },
};

function memoryResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "memory_search",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

test("model-facing tool surface is search-only and cannot mutate memory", async () => {
  const memory = new FakeMemory();
  const pi = new FakePi();
  createContextMemoryExtension({ memory })(pi as unknown as ExtensionAPI);

  assert.deepEqual([...pi.tools.keys()], ["memory_search"]);
  assert.equal(pi.tools.has("memory_remember"), false);
  assert.equal(pi.tools.has("memory_forget"), false);
  assert.equal(pi.tools.has("memory_consolidate"), false);
  assert.deepEqual([...pi.commands.keys()].sort(), [
    "memory-consolidate",
    "memory-forget",
    "memory-remember",
    "memory-search",
  ]);
  assert.equal(
    "authorization" in pi.tools.get("memory_search").parameters.properties,
    false,
  );

  await pi.emit("session_start", {}, ctx);
  await pi.emit(
    "context",
    {
      messages: [{ role: "user", content: "a live transcript", timestamp: 1 }],
    },
    ctx,
  );
  await pi.emit("session_compact", {}, ctx);
  assert.equal(memory.remembers.length, 0);
  assert.equal(memory.forgets.length, 0);
  assert.equal(memory.consolidations.length, 0);

  await pi.commands.get("memory-remember").handler(
    JSON.stringify({
      category: "user-preference",
      scope: "global",
      fact: "Prefer concise answers.",
      source_kind: "user-statement",
      reference: "explicit request",
      confidence: 0.9,
    }),
    ctx,
  );
  await pi.commands.get("memory-forget").handler("mem_fixture1", ctx);
  await pi.commands.get("memory-consolidate").handler("", ctx);
  assert.equal(memory.remembers.length, 1);
  assert.equal(memory.forgets.length, 1);
  assert.equal(memory.consolidations.length, 1);
});

test("adapter search recall enters one context call and is then elided", async () => {
  const memory = new FakeMemory();
  const pi = new FakePi();
  createContextMemoryExtension({ memory, maximumOneTurnRecallBytes: 4096 })(
    pi as unknown as ExtensionAPI,
  );
  const search = pi.tools.get("memory_search");
  const result = await search.execute(
    "search-new",
    {
      query: "concise",
      scope: "all",
      max_bytes: 512,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /Prefer concise answers/);
  assert.deepEqual(memory.searches[0], {
    query: "concise",
    scope: "all",
    project: "/projects/current",
    category: undefined,
    limit: undefined,
    maxBytes: 512,
  });

  const original: AgentMessage[] = [
    { role: "user", content: "live task", timestamp: 1 },
    memoryResult("search-old", "old recalled memory"),
    memoryResult("search-new", result.content[0].text),
  ];
  const first = await pi.emit("context", { messages: original }, ctx);
  assert.equal(
    JSON.stringify(first.messages).includes("old recalled memory"),
    false,
  );
  assert.equal(
    JSON.stringify(first.messages).includes("Prefer concise answers"),
    true,
  );
  assert.equal((first.messages[0] as AgentMessage).role, "user");

  const second = await pi.emit("context", { messages: original }, ctx);
  assert.equal(
    JSON.stringify(second.messages).includes("Prefer concise answers"),
    false,
  );
  assert.equal(JSON.stringify(second.messages).includes("live task"), true);
});
