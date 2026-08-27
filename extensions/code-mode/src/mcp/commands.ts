import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { McpCatalog } from "./catalog.ts";
import { logDiagnostic } from "./errors.ts";
import type { McpConnectionManager } from "./connection-manager.ts";
import {
  parseCommandArguments,
  parseNonInteractiveAdd,
  promptForServer,
} from "./setup.ts";
import { formatRedactedArguments, redactSecretTokens } from "./permissions.ts";
import { truncateUtf8 } from "./search.ts";
import { configuredSecretValues, redactExactSecrets } from "./secrets.ts";
import type { McpRegistry, ServerRecord } from "./types.ts";

type McpCommandRuntime = {
  registry: McpRegistry;
  connections: McpConnectionManager;
  catalog: McpCatalog;
  authenticate: (server: string, signal: AbortSignal) => Promise<void>;
  logout: (server: string) => Promise<void>;
  secretValues?: (server: string) => Promise<readonly string[]>;
  reload: () => Promise<void>;
};

type McpCommandDependencies = {
  runtime: (ctx: ExtensionCommandContext) => Promise<McpCommandRuntime>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function show(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
) {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function formatServer(record: ServerRecord) {
  const rawTarget =
    record.config.transport === "http"
      ? record.config.url
      : `${record.config.command} ${(record.config.args ?? []).join(" ")}`.trim();
  const target = sanitizeDisplayText(
    redactExactSecrets(rawTarget, configuredSecretValues(record.config)),
    4 * 1024,
  );
  const status =
    record.status ?? (record.enabled ? "disconnected" : "disabled");
  return `${record.enabled ? "●" : "○"} ${record.name} [${record.scope}/${record.config.transport}/${status}] ${target}`;
}

function commandSignal(milliseconds = 30_000) {
  return AbortSignal.timeout(milliseconds);
}

const MAX_TOOL_DESCRIPTION_BYTES = 1_024;
const MAX_TOOL_SCHEMA_BYTES = 4 * 1024;
const MAX_TOOL_ANNOTATIONS_BYTES = 1_024;
const MAX_TOOLS_OUTPUT_BYTES = 48 * 1024;

function sanitizeDisplayText(value: string, maxBytes: number) {
  const withoutTerminalEscapes = value.replace(
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    "",
  );
  return truncateUtf8(
    redactSecretTokens(withoutTerminalEscapes).replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
      "",
    ),
    maxBytes,
  );
}

function formatToolSummary(
  catalog: McpCatalog,
  path: string,
  includeAnnotations: boolean,
) {
  const description = catalog.describe(path);
  const lines = [path];
  if (description.description) {
    lines.push(
      `  Description: ${sanitizeDisplayText(description.description, MAX_TOOL_DESCRIPTION_BYTES)}`,
    );
  }
  lines.push(
    `  Input: ${sanitizeDisplayText(description.input, MAX_TOOL_SCHEMA_BYTES)}`,
  );
  if (includeAnnotations && description.annotations) {
    const annotations = formatRedactedArguments(
      description.annotations,
      MAX_TOOL_ANNOTATIONS_BYTES,
    );
    lines.push(
      `  Annotations: ${sanitizeDisplayText(annotations, MAX_TOOL_ANNOTATIONS_BYTES)}`,
    );
  }
  return lines.join("\n");
}

function boundToolsOutput(value: string) {
  if (Buffer.byteLength(value, "utf8") <= MAX_TOOLS_OUTPUT_BYTES) return value;
  const suffix = "\n[Additional tool summaries omitted: output limit reached]";
  const prefixLimit =
    MAX_TOOLS_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8");
  return `${truncateUtf8(value, prefixLimit)}${suffix}`;
}

async function chooseServer(
  ctx: ExtensionCommandContext,
  records: ServerRecord[],
  title: string,
) {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.select(
    title,
    records.map((record) => record.name),
  );
}

function isExpectedCommandError(message: string) {
  return /^(Usage:|Unknown MCP server:|Unknown \/mcp command:|\/mcp |Project MCP configuration|OAuth authentication|Removing an MCP server|MCP server |config\.)/.test(
    message,
  );
}

export function registerMcpCommand(
  pi: ExtensionAPI,
  dependencies: McpCommandDependencies,
) {
  let cachedNames: string[] = [];

  pi.registerCommand("mcp", {
    description: "Manage Code Mode MCP servers",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trimStart().split(/\s+/);
      if (tokens.length <= 1) {
        const actions = [
          "list",
          "add",
          "remove",
          "enable",
          "disable",
          "reconnect",
          "auth",
          "logout",
          "test",
          "tools",
          "reload",
        ];
        const query = tokens[0] ?? "";
        const matches = actions.filter((action) => action.startsWith(query));
        return matches.length
          ? matches.map((action) => ({ value: action, label: action }))
          : null;
      }
      const action = tokens[0];
      if (
        ![
          "remove",
          "enable",
          "disable",
          "reconnect",
          "auth",
          "logout",
          "test",
          "tools",
        ].includes(action ?? "")
      ) {
        return null;
      }
      const query = tokens.at(-1) ?? "";
      const matches = cachedNames.filter((name) => name.startsWith(query));
      return matches.length
        ? matches.map((name) => ({ value: `${action} ${name}`, label: name }))
        : null;
    },
    handler: async (rawArguments, ctx) => {
      let records: ServerRecord[] = [];
      let action: string | undefined;
      let runtime: McpCommandRuntime | undefined;
      try {
        const activeRuntime = await dependencies.runtime(ctx);
        runtime = activeRuntime;
        records = await activeRuntime.registry.list();
        records = records.map((record) => ({
          ...record,
          status: activeRuntime.connections.status(record.name),
        }));
        cachedNames = records.map((record) => record.name).sort();
        const [rawAction, ...tokens] = parseCommandArguments(rawArguments);
        action = rawAction;

        if (!action) {
          if (!ctx.hasUI) throw new Error("Usage: /mcp <command>");
          action = await ctx.ui.select("Code Mode MCP", [
            "list",
            "add",
            "remove",
            "enable",
            "disable",
            "reconnect",
            "auth",
            "logout",
            "test",
            "tools",
            "reload",
          ]);
          if (!action) return;
        }

        if (action === "list") {
          show(
            ctx,
            records.length
              ? records.map(formatServer).join("\n")
              : "No Code Mode MCP servers configured",
          );
          return;
        }

        if (action === "add") {
          const input = tokens.length
            ? parseNonInteractiveAdd(tokens)
            : await promptForServer(ctx);
          if (!input) return;
          if (input.scope === "project" && !ctx.isProjectTrusted()) {
            throw new Error(
              "Project MCP configuration requires a trusted project",
            );
          }
          const added = await runtime.registry.add(input);
          cachedNames = [...new Set([...cachedNames, added.name])].sort();
          show(ctx, `Added MCP server ${added.name}`);
          if (ctx.hasUI) {
            const testNow = await ctx.ui.confirm(
              "Test MCP server?",
              `Connect to ${added.name} and list its tools now?`,
            );
            if (testNow) {
              const connected = await runtime.connections.get(
                added.name,
                commandSignal(),
              );
              show(ctx, `${added.name}: ${connected.tools.length} tools`);
            }
          }
          return;
        }

        const requested = tokens[0];
        const name =
          action === "reload"
            ? undefined
            : (requested ??
              (await chooseServer(ctx, records, `Select server to ${action}`)));
        if (action !== "reload" && !name && action !== "reconnect") {
          throw new Error(`/mcp ${action} requires a server name`);
        }

        if (action === "remove") {
          const record = records.find((candidate) => candidate.name === name);
          if (!record) throw new Error(`Unknown MCP server: ${name}`);
          if (!ctx.hasUI) {
            throw new Error(
              "Removing an MCP server requires interactive confirmation; run /mcp remove NAME in interactive mode",
            );
          }
          const confirmed = await ctx.ui.confirm(
            "Remove MCP server?",
            `${formatServer(record)}\n\nExternal packages and caches will not be uninstalled.`,
          );
          if (!confirmed) return;
          const removeCredentials = await ctx.ui.confirm(
            "Remove saved credentials too?",
            `Also delete saved OAuth credentials for ${record.name}? Choose No to keep them for future use.`,
          );
          await runtime.registry.remove(record.name, {
            scope: record.scope,
            removeCredentials,
          });
          await runtime.connections.close(record.name);
          runtime.catalog.removeServer(record.name);
          cachedNames = cachedNames.filter(
            (candidate) => candidate !== record.name,
          );
          show(
            ctx,
            `Removed MCP server ${record.name}${removeCredentials ? " and its saved credentials" : "; saved credentials were kept"}`,
          );
          return;
        }

        if (action === "enable" || action === "disable") {
          if (!name) throw new Error(`Unknown MCP server: ${name}`);
          if (action === "enable") await runtime.registry.enable(name);
          else await runtime.registry.disable(name);
          if (action === "disable") await runtime.connections.close(name);
          show(ctx, `${action === "enable" ? "Enabled" : "Disabled"} ${name}`);
          return;
        }

        if (action === "reconnect") {
          if (name) {
            const connected = await runtime.connections.reconnect(
              name,
              commandSignal(),
            );
            show(ctx, `${name}: connected, ${connected.tools.length} tools`);
          } else {
            const enabled = records.filter((record) => record.enabled);
            for (const record of enabled) {
              await runtime.connections.reconnect(record.name, commandSignal());
            }
            show(ctx, `Reconnected ${enabled.length} MCP servers`);
          }
          return;
        }

        if (action === "test") {
          if (!name) throw new Error("/mcp test requires a server name");
          const tools = await runtime.connections.refresh(
            name,
            commandSignal(),
          );
          show(ctx, `${name}: connection healthy, ${tools.length} tools`);
          return;
        }

        if (action === "tools") {
          if (!name) throw new Error("/mcp tools requires a server name");
          await runtime.connections.get(name, commandSignal());
          const tools = runtime.catalog.listServer(name);
          const summaries = tools.map((tool) =>
            formatToolSummary(
              activeRuntime.catalog,
              tool.path,
              tool.annotations !== undefined,
            ),
          );
          show(
            ctx,
            boundToolsOutput(
              `${tools.length} tools${summaries.length ? `\n\n${summaries.join("\n\n")}` : ""}`,
            ),
          );
          return;
        }

        if (action === "auth") {
          if (!name) throw new Error("/mcp auth requires a server name");
          if (!ctx.hasUI)
            throw new Error("OAuth authentication requires interactive UI");
          await runtime.authenticate(name, commandSignal(5 * 60_000));
          const connected = await runtime.connections.reconnect(
            name,
            commandSignal(),
          );
          show(
            ctx,
            `Authenticated ${name}; reconnected, ${connected.tools.length} tools`,
          );
          return;
        }

        if (action === "logout") {
          if (!name) throw new Error("/mcp logout requires a server name");
          await runtime.connections.close(name);
          await runtime.logout(name);
          show(ctx, `Logged out ${name}`);
          return;
        }

        if (action === "reload") {
          await runtime.reload();
          records = await runtime.registry.list();
          cachedNames = records.map((record) => record.name).sort();
          show(ctx, `Reloaded ${records.length} MCP servers`);
          return;
        }

        throw new Error(`Unknown /mcp command: ${action}`);
      } catch (error) {
        const exactSecrets = records.flatMap((record) =>
          configuredSecretValues(record.config),
        );
        if (runtime?.secretValues) {
          for (const record of records) {
            try {
              exactSecrets.push(...(await runtime.secretValues(record.name)));
            } catch (secretError) {
              logDiagnostic(
                `Could not load MCP management redaction secrets for ${record.name}`,
                secretError,
                exactSecrets,
              );
            }
          }
        }
        const rawMessage = errorMessage(error);
        const safeMessage = sanitizeDisplayText(
          redactExactSecrets(rawMessage, exactSecrets),
          4 * 1024,
        );
        const message = isExpectedCommandError(safeMessage)
          ? safeMessage
          : `MCP management command failed. Diagnostic ID: ${logDiagnostic(
              "MCP management command failed",
              error,
              exactSecrets,
            )}`;
        show(ctx, message, "error");
        if (!ctx.hasUI) throw new Error(message);
      }
    },
  });
}
