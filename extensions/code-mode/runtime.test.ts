import assert from "node:assert/strict";
import { after, test } from "node:test";

import { CODE_MODE_LIMITS } from "./src/limits.ts";
import { executeCodeMode } from "./src/runtime.ts";
import type { ApprovalHandler, McpHost } from "./src/mcp/types.ts";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function createFakeHost() {
  const searches: Array<{ query: string; aborted: boolean }> = [];
  const descriptions: string[] = [];
  const calls: Array<{
    path: string;
    args: unknown;
    parentToolCallId: string;
    callCount?: number;
    approve?: ApprovalHandler;
    signal: AbortSignal;
  }> = [];

  const host: McpHost = {
    async search(input, options) {
      searches.push({ query: input.query, aborted: options.signal.aborted });
      return {
        items: [
          {
            path: "test.rows",
            description:
              input.query === "chunk" ? "x".repeat(250_000) : "Return rows",
            input: "{ count: number }",
            freshness: "live",
          },
        ],
      };
    },
    async describe(path) {
      descriptions.push(path);
      return {
        path,
        description: "Return rows",
        input: "{ count: number }",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
        },
        freshness: "live",
      };
    },
    async call(input, options) {
      calls.push({
        path: input.path,
        args: input.args,
        parentToolCallId: options.parentToolCallId,
        callCount: options.callCount,
        approve: options.approve,
        signal: options.signal,
      });

      if (input.path === "test.wait") {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }

      if (input.path === "test.chunk") {
        return {
          ok: true,
          content: [{ type: "text", text: "x".repeat(4_200_000) }],
        };
      }

      if (input.path === "test.too_large") {
        return {
          ok: true,
          content: [
            {
              type: "text",
              text: "x".repeat(CODE_MODE_LIMITS.maxMcpResultBytes + 1),
            },
          ],
        };
      }

      if (input.path === "test.status") {
        for (let index = 0; index < 100; index += 1) {
          options.onStatus?.({ message: "s".repeat(2_000) });
        }
      }

      if (!input.path.startsWith("test.") && !input.path.startsWith("test-")) {
        throw new Error(`Unknown tool: ${input.path}`);
      }

      const count =
        typeof input.args === "object" &&
        input.args !== null &&
        "count" in input.args &&
        typeof input.args.count === "number"
          ? input.args.count
          : 3;

      return {
        ok: true,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          path: input.path,
          args: input.args,
          rows: Array.from({ length: count }, (_, id) => ({
            id,
            keep: id % 2 === 0,
          })),
        },
      };
    },
    async close() {},
  };

  return { host, searches, descriptions, calls };
}

function run(
  source: string,
  host: McpHost,
  overrides: Partial<Parameters<typeof executeCodeMode>[1]> = {},
) {
  const controller = new AbortController();
  return executeCodeMode(source, {
    host,
    signal: controller.signal,
    parentToolCallId: "parent-call",
    ...overrides,
  });
}

test("runs erasable TypeScript with await/return and keeps diagnostics separate", async () => {
  const fake = createFakeHost();
  const approve: ApprovalHandler = async () => true;
  const result = await run(
    `
interface Row { id: number; keep: boolean }
type Response = { structuredContent: { rows: Row[] } };
const identity = <T,>(value: T): T => value;
const response = (await tools.test.rows({ count: 5 })) as Response;
console.log("guest diagnostic");
return identity(response.structuredContent.rows.filter((row) => row.keep).map((row) => row.id));
`,
    fake.host,
    { approve },
  );

  assert.deepEqual(result.value, [0, 2, 4]);
  assert.equal(result.stdout, "guest diagnostic\n");
  assert.equal(result.stderr, "");
  assert.equal(result.calls, 1);
  assert.equal(fake.calls[0]?.approve, approve);
  assert.equal(fake.calls[0]?.parentToolCallId, "parent-call");
  assert.equal(fake.calls[0]?.callCount, 1);
  assert.equal(fake.calls[0]?.signal.aborted, false);
});

test("routes search, describe, dynamic calls, and direct calls to McpHost", async () => {
  const fake = createFakeHost();
  const statuses: string[] = [];
  const result = await run(
    `
const matches = await tools.search({ query: "rows", limit: 1 });
const description = await tools.describe({ path: matches.items[0].path });
const dynamic = await tools.call({ path: description.path, args: { count: 2 } });
const direct = await tools.test.rows({ count: 1 });
const hyphenated = await tools["test-server"].rows({ count: 4 });
return {
  match: matches.items[0].path,
  described: description.path,
  dynamic: dynamic.structuredContent.rows.length,
  direct: direct.structuredContent.rows.length,
  hyphenated: hyphenated.structuredContent.rows.length,
};
`,
    fake.host,
    { onStatus: (status) => statuses.push(status.message) },
  );

  assert.deepEqual(result.value, {
    match: "test.rows",
    described: "test.rows",
    dynamic: 2,
    direct: 1,
    hyphenated: 4,
  });
  assert.deepEqual(fake.searches, [{ query: "rows", aborted: false }]);
  assert.deepEqual(fake.descriptions, ["test.rows"]);
  assert.deepEqual(
    fake.calls.map((call) => call.path),
    ["test.rows", "test.rows", "test-server.rows"],
  );
  assert.equal(result.calls, 3);
  assert.equal(result.trace.length, 3);
  assert.ok(statuses.some((status) => status.includes("Searching")));
  assert.ok(
    statuses.some((status) => status.includes("Completed 3 MCP calls")),
  );
});

test("rejects malformed, reserved, recursive, and unknown operation paths", async () => {
  const fake = createFakeHost();
  const result = await run(
    `
const errors = [];
for (const operation of [
  () => tools.search({ query: "x", limit: 0 }),
  () => tools.describe({ path: "https://example.com/tool" }),
  () => tools.call({ path: "search.rows", args: {} }),
  () => tools.execute({ code: "return 1" }),
  () => tools.unknown({}),
  () => tools.missing.tool({}),
]) {
  try { await operation(); }
  catch (error) { errors.push(String(error.message)); }
}
return errors;
`,
    fake.host,
  );

  assert.deepEqual(result.value, [
    "tools.search limit must be an integer from 1 to 20",
    "tools.describe requires a canonical server.tool path",
    "Reserved tool namespace: search",
    "Operation is not available: tools.execute",
    "Unknown Code Mode operation: unknown",
    "Unknown tool: missing.tool",
  ]);
  assert.equal(fake.calls.length, 1);
});

test("rejects malformed host results before copying them into QuickJS", async () => {
  const fake = createFakeHost();
  fake.host.call = async () => JSON.parse('{"unexpected":true}');

  await assert.rejects(
    () => run("return await tools.test.rows({});", fake.host),
    /malformed call result/,
  );
});

test("enforces the sequential 25-call budget and bounds status updates", async () => {
  const fake = createFakeHost();
  const statuses: string[] = [];
  const result = await run(
    `
let error = "";
for (let index = 0; index < 26; index += 1) {
  try { await tools.test.status({ index }); }
  catch (cause) { error = cause.message; }
}
return error;
`,
    fake.host,
    { onStatus: (status) => statuses.push(status.message) },
  );

  assert.equal(result.calls, CODE_MODE_LIMITS.maxCalls);
  assert.equal(fake.calls.length, CODE_MODE_LIMITS.maxCalls);
  assert.match(String(result.value), /call limit exceeded \(25\)/);
  assert.ok(statuses.length <= CODE_MODE_LIMITS.maxCalls * 2 + 10);
  assert.ok(
    statuses.every(
      (status) => byteLength(status) <= CODE_MODE_LIMITS.maxStatusBytes,
    ),
  );
});

test("bounds stdout, stderr, source, and final return values", async () => {
  const fake = createFakeHost();
  const output = await run(
    `
console.log("o".repeat(70_000));
console.error("e".repeat(70_000));
return "done";
`,
    fake.host,
  );

  assert.equal(output.value, "done");
  assert.ok(byteLength(output.stdout) <= CODE_MODE_LIMITS.maxStdoutBytes);
  assert.ok(byteLength(output.stderr) <= CODE_MODE_LIMITS.maxStderrBytes);
  assert.match(output.stdout, /truncated/);
  assert.match(output.stderr, /truncated/);

  await assert.rejects(
    () =>
      run(
        `return "r".repeat(${CODE_MODE_LIMITS.maxReturnBytes + 1});`,
        fake.host,
      ),
    /return value exceeds/,
  );
  await assert.rejects(
    () => run("x".repeat(CODE_MODE_LIMITS.maxSourceBytes + 1), fake.host),
    /source exceeds/,
  );
});

test("enforces per-result and aggregate intermediate MCP limits", async () => {
  const fake = createFakeHost();
  await assert.rejects(
    () => run("return await tools.test.too_large({});", fake.host),
    /MCP result exceeds/,
  );
  await assert.rejects(
    () =>
      run(
        `return await tools.test.rows({ payload: "x".repeat(${CODE_MODE_LIMITS.maxMcpArgumentBytes + 1}) });`,
        fake.host,
      ),
    /MCP arguments exceed/,
  );

  await assert.rejects(
    () =>
      run(
        `
for (let index = 0; index < 68; index += 1) {
  await tools.search({ query: "chunk", limit: 1 });
}
return "unreachable";
`,
        fake.host,
      ),
    /Aggregate intermediate MCP data exceeds/,
  );
});

test("uses an ephemeral bounded filesystem without network, Python, or host environment", async () => {
  const fake = createFakeHost();
  const previousSecret = process.env.CODE_MODE_HOST_SECRET;
  process.env.CODE_MODE_HOST_SECRET = "must-not-leak";

  try {
    const security = await run(
      `
const fs = require("fs");
const childProcess = require("child_process");
const failures = {};
try { fs.readFileSync("/etc/passwd", "utf8"); } catch (error) { failures.hostFile = error.message; }
try { await fetch("https://example.com"); } catch (error) { failures.network = error.message; }
try { childProcess.execSync("python3 -c 'print(1)'"); } catch (error) { failures.python = error.message; }
try { childProcess.execSync("cat /etc/passwd"); } catch (error) { failures.command = error.message; }
fs.writeFileSync("/workspace/marker", "present");
return {
  secret: process.env.CODE_MODE_HOST_SECRET,
  pwd: process.env.PWD,
  failures,
};
`,
      fake.host,
    );

    assert.deepEqual(security.value, {
      pwd: "/workspace",
      failures: {
        hostFile: "ENOENT: no such file or directory, open '<path>'",
        network:
          "Network access not configured. Enable network in Bash options.",
        python: "Command failed: python3 -c 'print(1)'",
        command: "Command failed: cat /etc/passwd",
      },
    });

    const fresh = await run(
      'return require("fs").existsSync("/workspace/marker");',
      fake.host,
    );
    assert.equal(fresh.value, false);

    const filesystem = await run(
      `
const fs = require("fs");
const chunk = "x".repeat(1024 * 1024);
let failure = "";
try {
  for (let index = 0; index < 33; index += 1) {
    fs.writeFileSync("/workspace/file-" + index, chunk);
  }
} catch (error) { failure = error.message; }
return failure;
`,
      fake.host,
    );
    assert.match(String(filesystem.value), /filesystem byte limit exceeded/i);
  } finally {
    if (previousSecret === undefined) delete process.env.CODE_MODE_HOST_SECRET;
    else process.env.CODE_MODE_HOST_SECRET = previousSecret;
  }
});

test("composes cancellation with the host signal and stops infinite guest code", async () => {
  const fake = createFakeHost();
  const hostController = new AbortController();
  const hostRun = executeCodeMode("return await tools.test.wait({});", {
    host: fake.host,
    signal: hostController.signal,
    parentToolCallId: "cancel-host",
  });
  const callDeadline = Date.now() + 2_000;
  while (fake.calls.length === 0 && Date.now() < callDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fake.calls.length, 1);
  hostController.abort();

  const cancelledHost = await hostRun;
  assert.equal(cancelledHost.cancelled, true);
  assert.equal(cancelledHost.stderr, "Code Mode execution cancelled");
  assert.equal(fake.calls.at(-1)?.signal.aborted, true);
  assert.equal(cancelledHost.trace.at(-1)?.status, "cancelled");

  const loopController = new AbortController();
  const loopRun = executeCodeMode("while (true) {}", {
    host: fake.host,
    signal: loopController.signal,
    parentToolCallId: "cancel-loop",
  });
  setTimeout(() => loopController.abort(), 30);

  const cancelledLoop = await loopRun;
  assert.equal(cancelledLoop.cancelled, true);
  assert.ok(cancelledLoop.durationMs < 2_000);
});

test("honors a configured execution deadline", async () => {
  const fake = createFakeHost();
  const result = await run("return await tools.test.wait({});", fake.host, {
    executionTimeoutMs: 40,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.stderr, "Code Mode execution cancelled");
  assert.ok(result.durationMs < 1_000);
});

test("direct concurrent sandbox entry fails fast instead of deadlocking js-exec", async () => {
  const fake = createFakeHost();
  const controller = new AbortController();
  const first = executeCodeMode("while (true) {}", {
    host: fake.host,
    signal: controller.signal,
    parentToolCallId: "concurrency-first",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () =>
      executeCodeMode("return 2", {
        host: fake.host,
        signal: new AbortController().signal,
        parentToolCallId: "concurrency-second",
      }),
    /Concurrent Code Mode sandbox execution/,
  );
  controller.abort();
  assert.equal((await first).cancelled, true);
});

// just-bash intentionally retains its shared js-exec worker for long-lived apps.
// Abort one final infinite script so Node's test runner can exit without a
// package-private worker reset hook.
after(async () => {
  const fake = createFakeHost();
  const originalCall = fake.host.call;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = () => resolve();
  });
  fake.host.call = async (input, options) => {
    markStarted?.();
    return originalCall(input, options);
  };

  const controller = new AbortController();
  const cleanup = executeCodeMode(
    "await tools.test.rows({}); while (true) {}",
    {
      host: fake.host,
      signal: controller.signal,
      parentToolCallId: "test-cleanup",
    },
  );
  await started;
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await cleanup;
});
