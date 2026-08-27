import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpConnectionManager } from "./src/mcp/connection-manager.ts";
import type { ServerRecord } from "./src/mcp/types.ts";

const serverPrelude = `
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
appendFileSync(process.env.PID_FILE, String(process.pid) + "\\n");
process.stdin.on("end", () => process.exit(0));
`;

function scriptRecord(
  script: string,
  env: Record<string, string>,
): ServerRecord {
  return {
    name: "test",
    scope: "global",
    enabled: true,
    config: {
      transport: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "--eval", script],
      env,
    },
  };
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor<T>(read: () => T | Promise<T>, description: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readPids(path: string) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForStopped(pid: number) {
  await waitFor(() => !processIsAlive(pid), `process ${pid} to stop`);
}

async function lifecycleHarness(
  t: TestContext,
  script: string,
  extraEnv: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-code-mode-lifecycle-"));
  const pidFile = join(root, "pids");
  const record = scriptRecord(script, { PID_FILE: pidFile, ...extraEnv });
  const manager = new McpConnectionManager({
    getServers: async () => [record],
  });
  const controllers: AbortController[] = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await manager.closeAll();
    for (const pid of await readPids(pidFile)) {
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    manager,
    pidFile,
    controller() {
      const controller = new AbortController();
      controllers.push(controller);
      return controller;
    },
  };
}

test("failed tools/list closes its stdio child", async (t) => {
  const script = `${serverPrelude}
const server = new Server(
  { name: "list-failure", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => {
  throw new Error("deliberate list failure");
});
await server.connect(new StdioServerTransport());
setInterval(() => undefined, 1_000);
`;
  const { manager, pidFile, controller } = await lifecycleHarness(t, script);

  await assert.rejects(
    manager.get("test", controller().signal),
    /deliberate list failure/,
  );
  const pid = (await readPids(pidFile))[0];
  assert.ok(pid);
  await waitForStopped(pid);
  assert.equal(manager.status("test"), "disconnected");
});

test("closeAll aborts and awaits a pending connect without publishing it", async (t) => {
  const script = `${serverPrelude}
process.stdin.resume();
setInterval(() => undefined, 1_000);
`;
  const { manager, pidFile, controller } = await lifecycleHarness(t, script);
  const connectController = controller();
  const connecting = assert.rejects(
    manager.get("test", connectController.signal),
    /Failed to connect MCP server test/,
  );
  const pid = await waitFor(
    async () => (await readPids(pidFile))[0],
    "pending stdio child",
  );

  await manager.closeAll();
  await connecting;
  await waitForStopped(pid);
  assert.equal(manager.status("test"), "disconnected");
});

test("cancelling one connection waiter does not abort another", async (t) => {
  const script = `${serverPrelude}
const server = new Server(
  { name: "shared-waiters", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { tools: [] };
});
await server.connect(new StdioServerTransport());
setInterval(() => undefined, 1_000);
`;
  const { manager, pidFile, controller } = await lifecycleHarness(t, script);
  const cancelledController = controller();
  const survivingController = controller();
  const cancelled = manager.get("test", cancelledController.signal);
  const surviving = manager.get("test", survivingController.signal);
  await waitFor(async () => (await readPids(pidFile))[0], "shared stdio child");
  cancelledController.abort(new DOMException("cancel one", "AbortError"));
  await assert.rejects(cancelled, /cancel one/);
  const connected = await surviving;
  assert.deepEqual(connected.tools, []);
  assert.equal(manager.status("test"), "connected");
});

test("a racing get cannot resurrect after close and closeAll", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-mode-lifecycle-race-"));
  const pidFile = join(root, "pids");
  const script = `${serverPrelude}
const server = new Server(
  { name: "race", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => ({ tools: [] }));
await server.connect(new StdioServerTransport());
setInterval(() => undefined, 1_000);
`;
  const record = scriptRecord(script, { PID_FILE: pidFile });
  let provideServers!: (records: ServerRecord[]) => void;
  const servers = new Promise<ServerRecord[]>((resolve) => {
    provideServers = resolve;
  });
  const manager = new McpConnectionManager({ getServers: () => servers });
  t.after(async () => {
    await manager.closeAll();
    for (const pid of await readPids(pidFile)) {
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });

  const getting = assert.rejects(
    manager.get("test", new AbortController().signal),
    /lifecycle changed|shutting down/,
  );
  await delay(0);
  await Promise.all([manager.close("test"), manager.closeAll()]);
  provideServers([record]);
  await getting;
  assert.deepEqual(await readPids(pidFile), []);
  assert.equal(manager.status("test"), "disconnected");
});

test("a rejected call evicts the stale child and the next call reconnects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-mode-call-recovery-"));
  const marker = join(root, "failed-once");
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `${serverPrelude}
import { existsSync, writeFileSync } from "node:fs";
const server = new Server(
  { name: "call-recovery", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "unstable", inputSchema: { type: "object" } }],
}));
server.setRequestHandler("tools/call", async () => {
  if (!existsSync(process.env.FAILURE_MARKER)) {
    writeFileSync(process.env.FAILURE_MARKER, "failed");
    setTimeout(() => process.exit(17), 10);
    return new Promise(() => undefined);
  }
  return { content: [{ type: "text", text: "recovered" }] };
});
await server.connect(new StdioServerTransport());
setInterval(() => undefined, 1_000);
`;
  const { manager, pidFile, controller } = await lifecycleHarness(t, script, {
    FAILURE_MARKER: marker,
  });
  const connected = await manager.get("test", controller().signal);
  const tool = connected.tools[0];
  assert.ok(tool);

  await assert.rejects(manager.call("test", tool, {}, controller().signal));
  const firstPid = (await readPids(pidFile))[0];
  assert.ok(firstPid);
  await waitForStopped(firstPid);
  assert.equal(manager.status("test"), "disconnected");

  const result = await manager.call("test", tool, {}, controller().signal);
  assert.deepEqual(result.content, [{ type: "text", text: "recovered" }]);
  const pids = await waitFor(async () => {
    const current = await readPids(pidFile);
    return current.length === 2 ? current : undefined;
  }, "replacement stdio child");
  assert.notEqual(pids[0], pids[1]);
  assert.equal(manager.status("test"), "connected");
});
