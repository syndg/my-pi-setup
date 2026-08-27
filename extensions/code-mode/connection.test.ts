import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  McpConnectionManager,
  nonSecretServerFingerprint,
} from "./src/mcp/connection-manager.ts";
import type { ServerRecord } from "./src/mcp/types.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/test-server.mjs", import.meta.url),
);

function testRecord(): ServerRecord {
  return {
    name: "test",
    scope: "global",
    enabled: true,
    config: {
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
    },
  };
}

test("connection manager lazily lists and invokes stdio tools", async (t) => {
  const changes: string[][] = [];
  const manager = new McpConnectionManager({
    getServers: async () => [testRecord()],
    onToolsChanged: (_server, tools) => {
      changes.push(tools.map((tool) => tool.name));
    },
  });
  t.after(() => manager.closeAll());

  assert.equal(manager.status("test"), "disconnected");
  const connected = await manager.get("test", new AbortController().signal);
  assert.equal(manager.status("test"), "connected");
  const initialToolNames = ["echo", "sum", "sleep", "fail", "add_dynamic_tool"];
  assert.deepEqual(
    connected.tools.map((tool) => tool.name),
    initialToolNames,
  );
  assert.deepEqual(changes.at(-1), initialToolNames);

  const echo = connected.tools.find((tool) => tool.name === "echo");
  assert.ok(echo);
  const result = await connected.client.callTool(
    { name: "echo", arguments: { message: "hello" } },
    { signal: new AbortController().signal, toolDefinition: echo },
  );
  assert.deepEqual(result.content, [{ type: "text", text: "server:hello" }]);

  const addDynamicTool = connected.tools.find(
    (tool) => tool.name === "add_dynamic_tool",
  );
  assert.ok(addDynamicTool);
  await manager.call("test", addDynamicTool, {}, new AbortController().signal);
  const refreshDeadline = Date.now() + 2_000;
  while (
    !connected.tools.some((tool) => tool.name === "dynamic") &&
    Date.now() < refreshDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(connected.tools.some((tool) => tool.name === "dynamic"));
  assert.ok(changes.at(-1)?.includes("dynamic"));
});

test("MCP invocations remain globally sequential across servers", async (t) => {
  const records: ServerRecord[] = ["first", "second"].map((name) => ({
    ...testRecord(),
    name,
  }));
  const manager = new McpConnectionManager({
    getServers: async () => records,
  });
  t.after(() => manager.closeAll());
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([
    manager.get("first", signal),
    manager.get("second", signal),
  ]);
  const firstSleep = first.tools.find((tool) => tool.name === "sleep");
  const secondSleep = second.tools.find((tool) => tool.name === "sleep");
  assert.ok(firstSleep);
  assert.ok(secondSleep);
  const startedAt = Date.now();
  await Promise.all([
    manager.call("first", firstSleep, { milliseconds: 120 }, signal),
    manager.call("second", secondSleep, { milliseconds: 120 }, signal),
  ]);
  assert.ok(Date.now() - startedAt >= 210);
});

test("uses a server-specific MCP request timeout", async (t) => {
  const record = testRecord();
  record.config.requestTimeoutMs = 1_000;
  const manager = new McpConnectionManager({
    getServers: async () => [record],
  });
  t.after(() => manager.closeAll());
  const signal = new AbortController().signal;
  const connected = await manager.get("test", signal);
  const sleep = connected.tools.find((tool) => tool.name === "sleep");
  assert.ok(sleep);

  await assert.rejects(
    () => manager.call("test", sleep, { milliseconds: 1_500 }, signal),
    /timed out|timeout/i,
  );
});

test("cache fingerprints are opaque and bind scope plus unresolved identity", () => {
  const record: ServerRecord = {
    name: "api",
    scope: "global",
    enabled: true,
    config: {
      transport: "http",
      url: "https://example.com/mcp?tenant=one",
      headers: { Authorization: "Bearer ${PRIVATE_TOKEN_A}" },
      oauth: false,
    },
  };
  const fingerprint = nonSecretServerFingerprint(record);
  assert.match(fingerprint, /^v3:[0-9a-f]{64}$/);
  assert.doesNotMatch(
    fingerprint,
    /api|Authorization|PRIVATE_TOKEN|Bearer|tenant|one/,
  );
  assert.notEqual(
    fingerprint,
    nonSecretServerFingerprint({
      ...record,
      config: {
        transport: "http",
        url: "https://example.com/mcp?tenant=two",
        headers: { Authorization: "Bearer ${PRIVATE_TOKEN_A}" },
        oauth: false,
      },
    }),
  );
  assert.notEqual(
    fingerprint,
    nonSecretServerFingerprint({
      ...record,
      config: {
        transport: "http",
        url: "https://example.com/mcp?tenant=one",
        headers: { Authorization: "Bearer ${PRIVATE_TOKEN_B}" },
        oauth: false,
      },
    }),
  );
  assert.notEqual(
    fingerprint,
    nonSecretServerFingerprint({ ...record, scope: "project" }),
  );
  const stdio = nonSecretServerFingerprint({
    name: "local",
    scope: "global",
    config: {
      transport: "stdio",
      command: "/secret/path/node",
      args: ["--api-key", "literal-argument-secret", "ordinary"],
    },
  });
  assert.match(stdio, /^v3:[0-9a-f]{64}$/);
  assert.doesNotMatch(stdio, /secret\/path|literal-argument-secret|ordinary/);
});
