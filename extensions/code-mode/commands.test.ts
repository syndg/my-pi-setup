import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseCommandArguments,
  parseNonInteractiveAdd,
} from "./src/mcp/setup.ts";
import { McpCatalog } from "./src/mcp/catalog.ts";
import { registerMcpCommand } from "./src/mcp/commands.ts";
import type { RemoveServerOptions, ServerRecord } from "./src/mcp/types.ts";
import { getCodeModeDiagnosticPath } from "./src/mcp/errors.ts";

test("command tokenizer preserves quoted structured arguments without a shell", () => {
  assert.deepEqual(
    parseCommandArguments("add global local stdio npx -y 'package name'"),
    ["add", "global", "local", "stdio", "npx", "-y", "package name"],
  );
});

test("non-interactive add stores a command and argument array", () => {
  assert.deepEqual(
    parseNonInteractiveAdd(["global", "local", "stdio", "npx", "-y", "server"]),
    {
      scope: "global",
      name: "local",
      config: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
      },
    },
  );
});

test("non-interactive add stores Streamable HTTP without implicit OAuth", () => {
  assert.deepEqual(
    parseNonInteractiveAdd([
      "project",
      "remote",
      "http",
      "https://example.com/mcp",
    ]),
    {
      scope: "project",
      name: "remote",
      config: {
        transport: "http",
        url: "https://example.com/mcp",
        oauth: false,
      },
    },
  );
});

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type CommandDependencies = Parameters<typeof registerMcpCommand>[1];
type CommandRuntime = Awaited<ReturnType<CommandDependencies["runtime"]>>;

const server: ServerRecord = {
  name: "demo",
  scope: "global",
  enabled: true,
  config: {
    transport: "http",
    url: "https://example.com/mcp",
    oauth: true,
  },
};

class FakePi {
  command: CommandHandler | undefined;

  registerCommand(name: string, options: unknown) {
    if (
      name === "mcp" &&
      typeof options === "object" &&
      options !== null &&
      "handler" in options &&
      typeof options.handler === "function"
    ) {
      this.command = options.handler as CommandHandler;
    }
  }
}

function createRuntime(
  options: {
    catalog?: McpCatalog;
    remove?: (name: string, options?: RemoveServerOptions) => Promise<void>;
    authenticate?: (name: string, signal: AbortSignal) => Promise<void>;
    secretValues?: (name: string) => Promise<readonly string[]>;
    reload?: () => Promise<void>;
    connections?: Record<string, unknown>;
  } = {},
) {
  return {
    registry: {
      list: async () => [server],
      add: async () => server,
      remove: options.remove ?? (async () => undefined),
      enable: async () => undefined,
      disable: async () => undefined,
      reload: async () => undefined,
    },
    connections: {
      status: () => "disconnected",
      close: async () => undefined,
      get: async () => ({ tools: [] }),
      reconnect: async () => ({ tools: [] }),
      refresh: async () => [],
      ...options.connections,
    },
    catalog: options.catalog ?? new McpCatalog(),
    authenticate: options.authenticate ?? (async () => undefined),
    logout: async () => undefined,
    secretValues: options.secretValues,
    reload: options.reload ?? (async () => undefined),
  } as unknown as CommandRuntime;
}

function installCommand(runtime: CommandRuntime) {
  const pi = new FakePi();
  registerMcpCommand(pi as unknown as ExtensionAPI, {
    runtime: async () => runtime,
  });
  assert.ok(pi.command);
  return pi.command;
}

function createUiContext(
  confirmResponses: boolean[],
  selectResponses: Array<string | undefined> = [],
) {
  const confirmations: Array<{ title: string; message: string }> = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  const notifications: Array<{
    message: string;
    level: "info" | "warning" | "error";
  }> = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirmResponses.shift() ?? false;
      },
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return selectResponses.shift();
      },
      notify: (message: string, level: "info" | "warning" | "error" = "info") =>
        notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, confirmations, selections, notifications };
}

test("interactive remove confirms the server and defaults credential deletion to no", async () => {
  let removed: { name: string; options?: RemoveServerOptions } | undefined;
  const command = installCommand(
    createRuntime({
      remove: async (name, options) => {
        removed = { name, options };
      },
    }),
  );
  const ui = createUiContext([true, false]);

  await command("remove demo", ui.ctx);

  assert.equal(ui.confirmations.length, 2);
  assert.equal(ui.confirmations[0]?.title, "Remove MCP server?");
  assert.equal(ui.confirmations[1]?.title, "Remove saved credentials too?");
  assert.deepEqual(removed, {
    name: "demo",
    options: { scope: "global", removeCredentials: false },
  });
  assert.match(
    ui.notifications.at(-1)?.message ?? "",
    /saved credentials were kept/,
  );
});

test("interactive remove deletes credentials only after separate confirmation", async () => {
  let removeCredentials: boolean | undefined;
  const command = installCommand(
    createRuntime({
      remove: async (_name, options) => {
        removeCredentials = options?.removeCredentials;
      },
    }),
  );
  const ui = createUiContext([true, true]);

  await command("remove demo", ui.ctx);

  assert.equal(ui.confirmations.length, 2);
  assert.equal(removeCredentials, true);
  assert.match(
    ui.notifications.at(-1)?.message ?? "",
    /and its saved credentials/,
  );
});

test("cancelling the first remove confirmation preserves the server", async () => {
  let removals = 0;
  const command = installCommand(
    createRuntime({
      remove: async () => {
        removals += 1;
      },
    }),
  );
  const ui = createUiContext([false, true]);

  await command("remove demo", ui.ctx);

  assert.equal(ui.confirmations.length, 1);
  assert.equal(removals, 0);
  assert.equal(ui.notifications.length, 0);
});

test("headless remove fails closed without mutating the registry", async () => {
  let removals = 0;
  const command = installCommand(
    createRuntime({
      remove: async () => {
        removals += 1;
      },
    }),
  );
  const ctx = {
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;

  await assert.rejects(
    command("remove demo", ctx),
    /requires interactive confirmation/,
  );
  assert.equal(removals, 0);
});

test("tools shows bounded sanitized descriptions, schemas, and annotations", async () => {
  const catalog = new McpCatalog();
  catalog.replaceLive("demo", [
    {
      path: "demo.search",
      server: "demo",
      name: "search",
      description:
        "Search repositories Bearer secret-token-value\u001b[31m" +
        " detail".repeat(1_000),
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, token: "credential-value" },
      freshness: "live",
    },
  ]);
  let gets = 0;
  const command = installCommand(
    createRuntime({
      catalog,
      connections: {
        get: async () => {
          gets += 1;
          return { tools: [{ name: "search" }] };
        },
      },
    }),
  );
  const ui = createUiContext([]);

  await command("tools demo", ui.ctx);

  const output = ui.notifications.at(-1)?.message ?? "";
  assert.equal(gets, 1);
  assert.match(output, /^1 tools/);
  assert.match(output, /demo\.search/);
  assert.match(output, /Description: Search repositories Bearer \[REDACTED\]/);
  assert.match(output, /Input: \{ query: string \}/);
  assert.match(output, /Annotations:/);
  assert.match(output, /"readOnlyHint": true/);
  assert.match(output, /"token": "\[REDACTED\]"/);
  assert.doesNotMatch(
    output,
    /secret-token-value|credential-value|\u001b|\[31m/,
  );
  assert.ok(Buffer.byteLength(output, "utf8") <= 48 * 1024);
});

test("auth reconnects the server so runtime tool state is refreshed", async () => {
  const operations: string[] = [];
  const command = installCommand(
    createRuntime({
      authenticate: async (name) => {
        operations.push(`auth:${name}`);
      },
      connections: {
        reconnect: async (name: string) => {
          operations.push(`reconnect:${name}`);
          return { tools: [{ name: "one" }, { name: "two" }] };
        },
      },
    }),
  );
  const ui = createUiContext([]);

  await command("auth demo", ui.ctx);

  assert.deepEqual(operations, ["auth:demo", "reconnect:demo"]);
  assert.match(
    ui.notifications.at(-1)?.message ?? "",
    /Authenticated demo; reconnected, 2 tools/,
  );
});

test("management diagnostics redact stored OAuth secrets and terminal controls", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-command-log-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const secret = "opaque-oauth-diagnostic-value";
  const command = installCommand(
    createRuntime({
      authenticate: async () => {
        throw new Error(`transport reflected ${secret}\u001b[31m`);
      },
      secretValues: async () => [secret],
    }),
  );
  const ui = createUiContext([]);
  const terminalWrites: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => terminalWrites.push(values);
  try {
    await command("auth demo", ui.ctx);
  } finally {
    console.error = original;
  }
  const displayed = ui.notifications.at(-1)?.message ?? "";
  const diagnostic = await readFile(getCodeModeDiagnosticPath(), "utf8");
  assert.match(displayed, /Diagnostic ID/);
  assert.doesNotMatch(displayed, /opaque-oauth|\u001b|\[31m/);
  assert.deepEqual(terminalWrites, []);
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(diagnostic, /opaque-oauth|\u001b|\[31m/);
});

test("interactive reload does not open a second server picker", async () => {
  let reloads = 0;
  const command = installCommand(
    createRuntime({
      reload: async () => {
        reloads += 1;
      },
    }),
  );
  const ui = createUiContext([], ["reload"]);

  await command("", ui.ctx);

  assert.deepEqual(
    ui.selections.map((selection) => selection.title),
    ["Code Mode MCP"],
  );
  assert.equal(reloads, 1);
  assert.match(
    ui.notifications.at(-1)?.message ?? "",
    /Reloaded 1 MCP servers/,
  );
});
