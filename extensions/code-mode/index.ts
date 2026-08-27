import { join } from "node:path";
import {
  getAgentDir,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CODE_MODE_LIMITS } from "./src/limits.ts";
import { resetJsExecWorker } from "./src/js-exec-worker.ts";
import { executeCodeMode } from "./src/runtime.ts";
import type { RuntimeResult } from "./src/types.ts";
import {
  identityForRecord,
  OAuthCredentialStore,
} from "./src/mcp/auth-store.ts";
import { CatalogCache } from "./src/mcp/catalog-cache.ts";
import { McpCatalog } from "./src/mcp/catalog.ts";
import { registerMcpCommand } from "./src/mcp/commands.ts";
import { loadCodeModeConfig } from "./src/mcp/config.ts";
import { logDiagnostic } from "./src/mcp/errors.ts";
import { McpConnectionManager } from "./src/mcp/connection-manager.ts";
import { CodeModeMcpHost, formatApprovalMessage } from "./src/mcp/host.ts";
import {
  authenticateServer,
  closeOAuthFlows,
  logoutServer,
} from "./src/mcp/oauth-flow.ts";
import { createOAuthProvider } from "./src/mcp/oauth-provider.ts";
import { createMcpRegistry } from "./src/mcp/registry.ts";
import {
  configuredSecretValues,
  oauthSecretValues,
} from "./src/mcp/secrets.ts";
import type { ApprovalRequest, ServerRecord } from "./src/mcp/types.ts";

export const COLLAPSED_CODE_LINES = 15;

export function previewCode(source: string, expanded: boolean) {
  const lines = source.split("\n");
  if (expanded || lines.length <= COLLAPSED_CODE_LINES) {
    return { source, hiddenLines: 0 };
  }
  return {
    source: lines.slice(0, COLLAPSED_CODE_LINES).join("\n"),
    hiddenLines: lines.length - COLLAPSED_CODE_LINES,
  };
}

const EXECUTE_DESCRIPTION = `Run an erasable TypeScript or JavaScript program in an ephemeral just-bash QuickJS sandbox to discover and invoke MCP tools. The complete MCP catalog is host-only and is never registered as Pi tools.

Guest interface:
- await tools.search({ query, limit?, cursor? }) returns { items: [{ path, input, description?, freshness }], nextCursor? }
- await tools.describe({ path })
- await tools.call({ path, args })
- await tools.<server>.<tool>(args), using bracket notation for names with hyphens
- return value

Use this exact discovery pattern:
const matches = await tools.search({ query: "what the tool should do" });
const selected = matches.items[0];
if (!selected) return matches;
const description = await tools.describe({ path: selected.path });
return await tools.call({ path: selected.path, args: { /* match description.inputSchema */ } });

Search before calling an unfamiliar tool. Read search results from matches.items; tools.call accepts one object, never positional arguments. Use the exact returned path and input shape. Return only information needed by the user. Intermediate MCP results stay in the sandbox unless returned. Calls are sequential and each call is validated, permission-checked, bounded, and cancellable. TypeScript is stripped, not typechecked; enums, namespaces, parameter properties, and other non-erasable constructs are unsupported.`;

type SessionRuntime = {
  cwd: string;
  trusted: boolean;
  registry: ReturnType<typeof createMcpRegistry>;
  catalog: McpCatalog;
  cache: CatalogCache;
  connections: McpConnectionManager;
  host: CodeModeMcpHost;
  authStore: OAuthCredentialStore;
  reload: () => Promise<void>;
  close: () => Promise<void>;
  authenticate: (server: string, signal: AbortSignal) => Promise<void>;
  logout: (server: string) => Promise<void>;
  secretValues: (server: string) => Promise<readonly string[]>;
};

type ExecuteWaiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

function contextKey(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">) {
  return `${ctx.cwd}\0${ctx.isProjectTrusted() ? "trusted" : "untrusted"}`;
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

function formatRuntimeOutput(result: RuntimeResult) {
  const sections = [formatValue(result.value)];
  if (result.stdout.trim())
    sections.push(`[stdout]\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim())
    sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  return sections.join("\n\n");
}

async function recordFor(
  registry: ReturnType<typeof createMcpRegistry>,
  server: string,
) {
  const record = (await registry.list()).find(
    (candidate) => candidate.name === server,
  );
  if (!record) throw new Error(`Unknown MCP server: ${server}`);
  return record;
}

async function createSessionRuntime(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
) {
  const cwd = ctx.cwd;
  const trusted = ctx.isProjectTrusted();
  const configOptions = { cwd, projectTrusted: trusted };
  const cache = new CatalogCache(join(getAgentDir(), "code-mode-catalog.json"));
  const catalog = new McpCatalog();
  const authStore = new OAuthCredentialStore();
  let connections!: McpConnectionManager;
  let host!: CodeModeMcpHost;

  const registry = createMcpRegistry({
    ...configOptions,
    teardownServer: (record) => connections?.close(record.name),
    clearServerCache: (record) => {
      catalog.removeServer(record.name);
      return cache.remove(record.name);
    },
    clearServerCredentials: (record) =>
      logoutServer(record, { store: authStore }),
  });

  const updateCache = async (
    server: string,
    tools: Parameters<McpCatalog["replaceLive"]>[1],
  ) => {
    const record = (await registry.list()).find(
      (candidate) => candidate.name === server,
    );
    if (!record) return;
    try {
      await cache.update(record, [...tools]);
    } catch (error) {
      logDiagnostic(`Could not update MCP catalog cache for ${server}`, error);
    }
  };

  connections = new McpConnectionManager({
    getServers: () => registry.list(),
    createOAuthProvider: (record, signal) =>
      Promise.resolve(
        createOAuthProvider(record, signal, { store: authStore }),
      ),
    onToolsChanged: (server, tools) => host.updateLiveCatalog(server, tools),
  });
  const getSecretValues = (record: ServerRecord) => {
    const configured = configuredSecretValues(record.config);
    if (record.config.transport !== "http" || record.config.oauth !== true) {
      return configured;
    }
    return [
      ...configured,
      ...oauthSecretValues(authStore.read(identityForRecord(record))),
    ];
  };

  host = new CodeModeMcpHost({
    registry,
    connections,
    catalog,
    getConfig: async () => (await loadCodeModeConfig(configOptions)).config,
    onCatalogChanged: updateCache,
    getSecretValues,
  });

  const hydrateCache = async () => {
    const records = await registry.list();
    for (const entry of await cache.load(records)) {
      try {
        catalog.replaceCached(entry.server, entry.tools);
      } catch (error) {
        logDiagnostic(
          `Discarding invalid MCP catalog cache for ${entry.server}`,
          error,
        );
        await cache.remove(entry.server).catch((removeError: unknown) => {
          logDiagnostic(
            `Could not remove invalid MCP catalog cache for ${entry.server}`,
            removeError,
          );
        });
      }
    }
  };
  await hydrateCache();

  const invalidateCachedCatalog = async (server: string) => {
    catalog.removeServer(server);
    await cache.remove(server).catch((error: unknown) => {
      logDiagnostic(
        `Could not invalidate MCP catalog cache for ${server}`,
        error,
      );
    });
  };

  const runtime: SessionRuntime = {
    cwd,
    trusted,
    registry,
    catalog,
    cache,
    connections,
    host,
    authStore,
    reload: async () => {
      await registry.reload();
      catalog.clear();
      await hydrateCache();
    },
    close: async () => {
      await host.close();
      await closeOAuthFlows();
    },
    authenticate: async (server, signal) => {
      const record = await recordFor(registry, server);
      await authenticateServer(record, signal, { store: authStore });
      await invalidateCachedCatalog(server);
    },
    logout: async (server) => {
      const record = await recordFor(registry, server);
      logoutServer(record, { store: authStore });
      await invalidateCachedCatalog(server);
    },
    secretValues: async (server) =>
      getSecretValues(await recordFor(registry, server)),
  };
  return runtime;
}

export function createCodeModeExtension() {
  return (pi: ExtensionAPI) => {
    let currentKey: string | undefined;
    let current: Promise<SessionRuntime> | undefined;
    let executeActive = false;
    const executeWaiters: ExecuteWaiter[] = [];

    const createExecuteRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        while (executeWaiters.length > 0) {
          const waiter = executeWaiters.shift()!;
          clearTimeout(waiter.timeout);
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          if (waiter.signal.aborted) continue;
          waiter.resolve(createExecuteRelease());
          return;
        }
        executeActive = false;
      };
    };

    const acquireExecute = (
      executionSignal: AbortSignal,
      executionTimeoutMs: number,
    ) => {
      executionSignal.throwIfAborted();
      if (!executeActive) {
        executeActive = true;
        return Promise.resolve(createExecuteRelease());
      }
      return new Promise<() => void>((resolve, reject) => {
        const remove = (waiter: ExecuteWaiter) => {
          const index = executeWaiters.indexOf(waiter);
          if (index >= 0) executeWaiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          executionSignal.removeEventListener("abort", waiter.onAbort);
        };
        const waiter: ExecuteWaiter = {
          signal: executionSignal,
          resolve,
          reject,
          onAbort: () => {
            remove(waiter);
            reject(
              new DOMException("Code Mode execution cancelled", "AbortError"),
            );
          },
          timeout: setTimeout(() => {
            remove(waiter);
            reject(
              new DOMException(
                "Code Mode execution queue timed out",
                "TimeoutError",
              ),
            );
          }, executionTimeoutMs),
        };
        executeWaiters.push(waiter);
        executionSignal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      });
    };

    const runtimeFor = async (
      ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
    ) => {
      const key = contextKey(ctx);
      if (current && currentKey === key) return current;
      const previous = current;
      currentKey = key;
      const operation = (async () => {
        if (previous) await (await previous).close();
        return createSessionRuntime(ctx);
      })();
      current = operation;
      void operation.catch(() => {
        if (current === operation) {
          current = undefined;
          currentKey = undefined;
        }
      });
      return operation;
    };

    pi.registerTool({
      name: "execute",
      label: "MCP Code Mode",
      description: EXECUTE_DESCRIPTION,
      promptSnippet:
        "Run sandboxed code that discovers and invokes MCP tools without eagerly loading their schemas",
      promptGuidelines: [
        "Use execute for MCP integrations. In guest code, read tools.search results from result.items and call tools.call with one { path, args } object.",
      ],
      parameters: Type.Object(
        {
          code: Type.String({
            description:
              "Erasable TypeScript or JavaScript. Exact discovery contract: const found = await tools.search({ query }); const selected = found.items[0]; return await tools.call({ path: selected.path, args });",
            maxLength: 1024 * 1024,
          }),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId, parameters, signal, onUpdate, ctx) {
        let executionTimeoutMs: number;
        try {
          const loaded = await loadCodeModeConfig({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
          });
          executionTimeoutMs =
            loaded.config.executionTimeoutMs ??
            CODE_MODE_LIMITS.executionTimeMs;
        } catch (error) {
          const diagnosticId = logDiagnostic(
            "Code Mode configuration failed",
            error,
          );
          throw new Error(
            `Code Mode configuration failed. Diagnostic ID: ${diagnosticId}`,
          );
        }
        const deadlineController = new AbortController();
        const deadline = setTimeout(
          () =>
            deadlineController.abort(
              new DOMException("Code Mode deadline exceeded", "TimeoutError"),
            ),
          executionTimeoutMs,
        );
        const parentSignal = signal ?? new AbortController().signal;
        const effectiveSignal = AbortSignal.any([
          parentSignal,
          deadlineController.signal,
        ]);
        let release: () => void;
        try {
          release = await acquireExecute(effectiveSignal, executionTimeoutMs);
        } catch {
          clearTimeout(deadline);
          return {
            content: [
              { type: "text" as const, text: "Code Mode execution cancelled" },
            ],
            details: { trace: [], calls: 0, durationMs: 0, cancelled: true },
          };
        }
        try {
          let runtime: SessionRuntime;
          try {
            runtime = await runtimeFor(ctx);
          } catch (error) {
            const diagnosticId = logDiagnostic(
              "Code Mode initialization failed",
              error,
            );
            throw new Error(
              `Code Mode initialization failed. Diagnostic ID: ${diagnosticId}`,
            );
          }
          const approve = async (request: ApprovalRequest) => {
            if (!ctx.hasUI) return false;
            effectiveSignal.throwIfAborted();
            return ctx.ui.confirm(
              "Approve MCP call?",
              formatApprovalMessage(request),
              { signal: request.signal },
            );
          };
          const result = await executeCodeMode(parameters.code, {
            host: runtime.host,
            signal: effectiveSignal,
            parentToolCallId: toolCallId,
            executionTimeoutMs,
            approve,
            onStatus: (status) => {
              onUpdate?.({
                content: [{ type: "text", text: status.message }],
                details: {
                  trace: [],
                  calls: status.calls,
                  maxCalls: status.maxCalls,
                },
              });
            },
          });
          return {
            content: [
              {
                type: "text" as const,
                text: result.cancelled
                  ? "Code Mode execution cancelled"
                  : formatRuntimeOutput(result),
              },
            ],
            details: {
              trace: result.trace,
              calls: result.calls,
              durationMs: result.durationMs,
              cancelled: result.cancelled,
            },
          };
        } finally {
          release();
          clearTimeout(deadline);
        }
      },
      renderCall(arguments_, theme, context) {
        const preview = previewCode(arguments_.code, context.expanded);
        const title = theme.fg("toolTitle", theme.bold("MCP Code Mode"));
        const source = highlightCode(preview.source, "typescript").join("\n");
        const expansionHint = preview.hiddenLines
          ? theme.fg(
              "dim",
              `\n… ${preview.hiddenLines} more line${preview.hiddenLines === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`,
            )
          : context.expanded
            ? theme.fg(
                "dim",
                `\n(${keyHint("app.tools.expand", "to collapse")})`,
              )
            : "";
        return new Text(`${title}\n${source}${expansionHint}`, 0, 0);
      },
      renderResult(result, { isPartial, expanded }, theme, context) {
        const text = result.content.find(
          (content) => content.type === "text",
        )?.text;
        if (isPartial) {
          return new Text(theme.fg("warning", text ?? "Running…"), 0, 0);
        }
        if (context.isError) {
          const body = expanded && text ? `\n${theme.fg("error", text)}` : "";
          return new Text(theme.fg("error", "failed") + body, 0, 0);
        }
        const details = result.details as
          | { calls?: number; durationMs?: number; cancelled?: boolean }
          | undefined;
        const summary = details?.cancelled
          ? "cancelled"
          : `${details?.calls ?? 0} call${details?.calls === 1 ? "" : "s"} in ${details?.durationMs ?? 0}ms`;
        const body = expanded ? `\n${text ?? ""}` : "";
        return new Text(
          theme.fg(details?.cancelled ? "warning" : "success", summary) + body,
          0,
          0,
        );
      },
    });

    registerMcpCommand(pi, {
      runtime: async (ctx) => {
        const runtime = await runtimeFor(ctx);
        return {
          registry: runtime.registry,
          connections: runtime.connections,
          catalog: runtime.catalog,
          authenticate: runtime.authenticate,
          logout: runtime.logout,
          secretValues: runtime.secretValues,
          reload: runtime.reload,
        };
      },
    });

    pi.on("session_shutdown", async () => {
      const active = current;
      current = undefined;
      currentKey = undefined;
      if (active) {
        try {
          await (await active).close();
        } catch (error) {
          logDiagnostic("Code Mode shutdown failed", error);
        }
      }
      try {
        await resetJsExecWorker();
      } catch (error) {
        logDiagnostic("Code Mode sandbox cleanup failed", error);
      }
    });
  };
}

export default createCodeModeExtension();
