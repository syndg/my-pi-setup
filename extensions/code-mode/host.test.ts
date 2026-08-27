import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { McpCatalog } from "./src/mcp/catalog.ts";
import { writeCodeModeConfig, loadCodeModeConfig } from "./src/mcp/config.ts";
import { McpConnectionManager } from "./src/mcp/connection-manager.ts";
import { CodeModeMcpHost, formatApprovalMessage } from "./src/mcp/host.ts";
import { createMcpRegistry } from "./src/mcp/registry.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/test-server.mjs", import.meta.url),
);

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-code-mode-host-"));
  const paths = {
    global: join(root, "global.json"),
    project: join(root, "project.json"),
  };
  await writeCodeModeConfig(paths.global, {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
    },
    permissions: { "test.*": "allow" },
    defaultPermission: "ask",
  });
  const options = { paths, projectTrusted: true };
  let connections!: McpConnectionManager;
  const registry = createMcpRegistry({
    ...options,
    teardownServer: (record) => connections?.close(record.name),
  });
  const catalog = new McpCatalog();
  let host!: CodeModeMcpHost;
  connections = new McpConnectionManager({
    getServers: () => registry.list(),
    onToolsChanged: (server, tools) => host?.updateLiveCatalog(server, tools),
  });
  host = new CodeModeMcpHost({
    registry,
    connections,
    catalog,
    getConfig: async () => (await loadCodeModeConfig(options)).config,
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  return { host, catalog, connections, paths, options, registry };
}

test("host discovers, describes, validates and invokes live stdio tools", async (t) => {
  const { host } = await harness(t);
  const signal = new AbortController().signal;
  const search = await host.search({ query: "echo message" }, { signal });
  assert.equal(search.items[0]?.path, "test.echo");
  const description = await host.describe("test.echo", { signal });
  assert.match(description.input, /message/);
  assert.equal(description.freshness, "live");

  const result = await host.call(
    { path: "test.echo", args: { message: "hello" } },
    { signal, parentToolCallId: "parent", callCount: 1, maxCalls: 25 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.structuredContent, { echoed: "hello" });

  const invalid = await host.call(
    { path: "test.echo", args: {} },
    { signal, parentToolCallId: "parent" },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "MCP_REQUEST_REJECTED");
});

test("host enforces deny and ask without invoking the MCP tool", async (t) => {
  const { host, paths, registry } = await harness(t);
  const signal = new AbortController().signal;
  await writeCodeModeConfig(paths.global, {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
    },
    permissions: { "test.echo": "deny", "test.sum": "ask" },
  });
  await registry.reload();

  const denied = await host.call(
    { path: "test.echo", args: { message: "blocked" } },
    { signal, parentToolCallId: "parent" },
  );
  assert.equal(denied.error?.code, "PERMISSION_DENIED");

  const headless = await host.call(
    { path: "test.sum", args: { values: [1, 2] } },
    { signal, parentToolCallId: "parent" },
  );
  assert.equal(headless.error?.code, "APPROVAL_REQUIRED");

  let approvals = 0;
  const approved = await host.call(
    { path: "test.sum", args: { values: [1, 2] } },
    {
      signal,
      parentToolCallId: "parent",
      approve: async () => {
        approvals += 1;
        return true;
      },
    },
  );
  assert.equal(approvals, 1);
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.structuredContent, { total: 3 });
});

test("cached search reconnects only enabled servers missing from the cache", async (t) => {
  const { host, catalog, connections, paths, registry } = await harness(t);
  await writeCodeModeConfig(paths.global, {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
      second: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
    },
    permissions: { "test.*": "allow", "second.*": "allow" },
  });
  await registry.reload();
  catalog.replaceCached("test", [
    {
      path: "test.cached",
      server: "test",
      name: "cached",
      description: "Cached tool metadata",
      inputSchema: { type: "object" },
      freshness: "cached",
    },
  ]);
  const result = await host.search(
    { query: "cached metadata" },
    { signal: new AbortController().signal },
  );
  assert.equal(result.items[0]?.path, "test.cached");
  assert.equal(result.items[0]?.freshness, "cached");
  assert.equal(connections.status("test"), "disconnected");
  assert.equal(connections.status("second"), "connected");
  assert.ok(catalog.lookup("second.echo"));
});

test("approval previews include parent and remaining budget without exact secrets", () => {
  const secret = "opaque-approval-value";
  const message = formatApprovalMessage({
    path: "test.echo",
    description: `Description ${secret}`,
    arguments: { value: secret },
    exactSecrets: [secret],
    parentToolCallId: "execute-call-1",
    callCount: 3,
    maxCalls: 25,
  });
  assert.doesNotMatch(message, /opaque-approval-value/);
  assert.match(message, /Parent execute call: execute-call-1/);
  assert.match(message, /22 calls remaining/);
});
