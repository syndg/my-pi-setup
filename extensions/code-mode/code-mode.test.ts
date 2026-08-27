import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import codeModeExtension, {
  COLLAPSED_CODE_LINES,
  previewCode,
} from "./index.ts";
import { writeCodeModeConfig } from "./src/mcp/config.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/test-server.mjs", import.meta.url),
);
const runner = fileURLToPath(
  new URL("./fixtures/extension-e2e-runner.ts", import.meta.url),
);
const execFileAsync = promisify(execFile);

type RenderedComponent = { render: (width: number) => string[] };

type RegisteredTool = {
  name: string;
  description: string;
  execute: (...arguments_: unknown[]) => Promise<unknown>;
  renderResult?: (...arguments_: unknown[]) => RenderedComponent;
};

type EventHandler = (...arguments_: unknown[]) => unknown;

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Set<string>();
  const handlers = new Map<string, EventHandler[]>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  return { api: api as unknown as ExtensionAPI, tools, commands, handlers };
}

test("registers exactly one MCP-facing tool and one user command", () => {
  const pi = fakePi();
  codeModeExtension(pi.api);
  assert.deepEqual([...pi.tools.keys()], ["execute"]);
  assert.deepEqual([...pi.commands], ["mcp"]);
  const execute = pi.tools.get("execute");
  assert.ok(execute);
  assert.doesNotMatch(execute.description, /test\.echo|context7\.query-docs/);
  assert.match(execute.description, /tools\.search/);
  assert.match(execute.description, /matches\.items/);
  assert.match(execute.description, /tools\.call\(\{ path/);
});

test("execute renders thrown errors as failures", () => {
  const pi = fakePi();
  codeModeExtension(pi.api);
  const execute = pi.tools.get("execute");
  assert.ok(execute?.renderResult);

  const component = execute.renderResult(
    { content: [{ type: "text", text: "Error: transport failure" }] },
    { expanded: false, isPartial: false },
    { fg: (_color: string, text: string) => text },
    { isError: true },
  );

  assert.deepEqual(
    component.render(80).map((line) => line.trimEnd()),
    ["failed"],
  );
});

test("execute rejects configuration failures so Pi marks them as errors", async (t) => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-code-mode-invalid-config-"),
  );
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-invalid-project-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(agentDir, "code-mode.json"), '{"unknown":true}');

  const pi = fakePi();
  codeModeExtension(pi.api);
  const execute = pi.tools.get("execute");
  assert.ok(execute);
  const context = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;

  await assert.rejects(
    () =>
      execute.execute(
        "invalid-config",
        { code: "return 1" },
        new AbortController().signal,
        undefined,
        context,
      ),
    /Code Mode configuration failed\. Diagnostic ID:/,
  );
});

test("execute code previews show 15 lines before expansion", () => {
  const source = Array.from(
    { length: COLLAPSED_CODE_LINES + 5 },
    (_, index) => `const line${index + 1} = ${index + 1};`,
  ).join("\n");

  const collapsed = previewCode(source, false);
  assert.equal(collapsed.source.split("\n").length, COLLAPSED_CODE_LINES);
  assert.equal(collapsed.hiddenLines, 5);

  const expanded = previewCode(source, true);
  assert.equal(expanded.source, source);
  assert.equal(expanded.hiddenLines, 0);
});

test("extension executes a sandboxed stdio MCP call end to end", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-project-"));
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
    },
    permissions: { "test.*": "allow" },
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", runner, agentDir, cwd],
    { timeout: 30_000 },
  );
  assert.match(stdout, /server:full-stack/);
  assert.match(stdout, /\\"ok\\":\s*true/);
});

test("execute releases the js-exec worker so the host exits naturally", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-exit-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-exit-project-"));
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
    servers: {},
    permissions: {},
  });
  const encoded = Buffer.from("return 1;").toString("base64url");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", runner, agentDir, cwd, encoded],
    {
      timeout: 5_000,
      env: { ...process.env, PI_CODE_MODE_NATURAL_EXIT: "1" },
    },
  );
  assert.match(stdout, /"text":"1"/);
});

test("extension applies the configured execution timeout", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-timeout-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-timeout-project-"));
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
    servers: {},
    executionTimeoutMs: 40,
  });
  const encoded = Buffer.from("while (true) {}").toString("base64url");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", runner, agentDir, cwd, encoded],
    { timeout: 5_000 },
  );

  assert.match(stdout, /Code Mode execution cancelled/);
  assert.match(stdout, /\"cancelled\":true/);
});

test("parallel execute calls are serialized before entering js-exec", async (t) => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-code-mode-parallel-agent-"),
  );
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-parallel-project-"));
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
    },
    permissions: { "test.*": "allow" },
  });
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", runner, agentDir, cwd],
    {
      timeout: 10_000,
      env: { ...process.env, PI_CODE_MODE_PARALLEL_E2E: "1" },
    },
  );
  assert.equal(stdout.match(/server:full-stack/g)?.length, 2);
  assert.equal(stdout.match(/\\"ok\\":\s*true/g)?.length, 2);
});

test("configured secrets are scrubbed from live metadata, results, and cache", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-secret-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-secret-project-"));
  const secret = "opaque-exact-value-7f42c9";
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
    servers: {
      test: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { CODE_MODE_FIXTURE_SECRET: "${CODE_MODE_FIXTURE_SECRET}" },
      },
    },
    permissions: { "test.*": "allow" },
  });
  const code = `
    const matches = await tools.search({ query: "echo marker" });
    const description = await tools.describe({ path: "test.echo" });
    const result = await tools.test.echo({ message: "redaction" });
    return { matches, description, result };
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      runner,
      agentDir,
      cwd,
      Buffer.from(code).toString("base64url"),
    ],
    {
      timeout: 30_000,
      env: { ...process.env, CODE_MODE_FIXTURE_SECRET: secret },
    },
  );
  const cache = await readFile(
    join(agentDir, "code-mode-catalog.json"),
    "utf8",
  );
  assert.equal(stdout.includes(secret), false);
  assert.equal(cache.includes(secret), false);
  assert.match(stdout, /\[REDACTED\]/);
});
