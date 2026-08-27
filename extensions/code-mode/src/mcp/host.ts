import { UnauthorizedError, type Tool } from "@modelcontextprotocol/client";
import type { CodeModeMcpResult, CodeModeTraceEntry } from "../types.ts";
import { McpCatalog } from "./catalog.ts";
import { McpConnectionManager } from "./connection-manager.ts";
import { normalizeMcpResult, serializedByteLength } from "./content.ts";
import { logDiagnostic } from "./errors.ts";
import {
  formatRedactedArguments,
  redactSecrets,
  redactSecretTokens,
  resolveConfiguredPermission,
} from "./permissions.ts";
import { truncateUtf8 } from "./search.ts";
import { redactExactSecrets } from "./secrets.ts";
import type {
  CallInput,
  CallOptions,
  CatalogTool,
  CodeModeConfig,
  HostOptions,
  McpHost,
  McpRegistry,
  SearchInput,
  ServerRecord,
} from "./types.ts";
import { McpArgumentValidator } from "./validation.ts";

type CodeModeMcpHostOptions = {
  registry: McpRegistry;
  connections: McpConnectionManager;
  catalog: McpCatalog;
  getConfig: () => Promise<CodeModeConfig>;
  onCatalogChanged?: (
    server: string,
    tools: CatalogTool[],
  ) => void | Promise<void>;
  getSecretValues?: (
    record: ServerRecord,
  ) => readonly string[] | Promise<readonly string[]>;
};

function redactMetadataStrings<T>(value: T): T {
  const serialized = JSON.stringify(value, (_key, current: unknown) =>
    typeof current === "string" ? redactSecretTokens(current) : current,
  );
  return serialized === undefined ? value : (JSON.parse(serialized) as T);
}

function toolRecord(
  server: string,
  tool: Tool,
  freshness: "cached" | "live",
  exactSecrets: readonly string[],
) {
  const safeTool = redactExactSecrets(tool, exactSecrets);
  return {
    path: `${server}.${safeTool.name}`,
    server,
    name: safeTool.name,
    ...(safeTool.description
      ? { description: redactSecretTokens(safeTool.description) }
      : {}),
    inputSchema: redactMetadataStrings(safeTool.inputSchema),
    ...(safeTool.annotations
      ? {
          annotations: redactSecrets(safeTool.annotations, {
            maxDepth: 100,
            maxProperties: 512 * 1024,
            maxStringBytes: 512 * 1024,
            limitBehavior: "throw",
          }) as Tool["annotations"],
        }
      : {}),
    freshness,
  } satisfies CatalogTool;
}

function splitPath(path: string) {
  const separator = path.indexOf(".");
  if (separator <= 0 || separator === path.length - 1) {
    throw new Error(`Invalid MCP tool path: ${path}`);
  }
  return { server: path.slice(0, separator), tool: path.slice(separator + 1) };
}

function mcpArguments(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Invalid MCP tool arguments: expected an object");
}

function expectedFailure(code: string, message: string): CodeModeMcpResult {
  return {
    ok: false,
    content: [{ type: "text", text: message }],
    error: { code, message },
  };
}

function isExpectedError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /^(Invalid MCP tool arguments|MCP tool schema|Unknown MCP tool|Invalid MCP tool path|MCP server is not configured|MCP output exceeded|Missing environment variable)/.test(
    error.message,
  );
}

function authenticationRequired(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof UnauthorizedError) return true;
    seen.add(current);
    const candidate = current as { cause?: unknown; status?: unknown };
    if (candidate.status === 401) return true;
    current = candidate.cause;
  }
  return false;
}

function diagnosticFailure(
  path: string,
  error: unknown,
  exactSecrets: readonly string[],
) {
  const diagnosticId = logDiagnostic(
    `MCP call ${path} failed`,
    error,
    exactSecrets,
  );
  return expectedFailure(
    "MCP_CALL_FAILED",
    `MCP call ${path} failed. Diagnostic ID: ${diagnosticId}`,
  );
}

export class CodeModeMcpHost implements McpHost {
  private readonly options: CodeModeMcpHostOptions;
  private readonly validator = new McpArgumentValidator();
  private discovery: Promise<void> | undefined;

  constructor(options: CodeModeMcpHostOptions) {
    this.options = options;
  }

  private async publishLive(server: string, tools: Tool[]) {
    const record = (await this.options.registry.list()).find(
      (candidate) => candidate.name === server,
    );
    const exactSecrets = record
      ? await this.options.getSecretValues?.(record)
      : undefined;
    const records = tools.map((tool) =>
      toolRecord(server, tool, "live", exactSecrets ?? []),
    );
    this.options.catalog.replaceLive(server, records);
    await this.options.onCatalogChanged?.(
      server,
      this.options.catalog.listServer(server),
    );
  }

  async updateLiveCatalog(server: string, tools: Tool[]) {
    await this.publishLive(server, tools);
  }

  private async discoverEnabled(signal: AbortSignal) {
    if (this.discovery) return this.discovery;
    const operation = (async () => {
      const records = await this.options.registry.list();
      const enabled = records.filter(
        (record) =>
          record.enabled && !this.options.catalog.hasServer(record.name),
      );
      await Promise.all(
        enabled.map(async (record) => {
          signal.throwIfAborted();
          try {
            const connected = await this.options.connections.get(
              record.name,
              signal,
            );
            await this.publishLive(record.name, connected.tools);
          } catch (error) {
            let exactSecrets: readonly string[] = [];
            try {
              exactSecrets =
                (await this.options.getSecretValues?.(record)) ?? [];
            } catch (secretError) {
              logDiagnostic(
                `Could not load MCP redaction secrets for ${record.name}`,
                secretError,
              );
            }
            logDiagnostic(
              `MCP discovery failed for ${record.name}`,
              error,
              exactSecrets,
            );
          }
        }),
      );
    })().finally(() => {
      if (this.discovery === operation) this.discovery = undefined;
    });
    this.discovery = operation;
    return operation;
  }

  async search(input: SearchInput, options: HostOptions) {
    options.signal.throwIfAborted();
    await this.discoverEnabled(options.signal);
    return this.options.catalog.search(input);
  }

  async describe(path: string, options: HostOptions) {
    options.signal.throwIfAborted();
    const cached = this.options.catalog.lookup(path);
    if (cached) return this.options.catalog.describe(path);
    const { server } = splitPath(path);
    const record = (await this.options.registry.list()).find(
      (candidate) => candidate.name === server,
    );
    let exactSecrets: readonly string[] = [];
    if (record) {
      try {
        exactSecrets = (await this.options.getSecretValues?.(record)) ?? [];
      } catch (error) {
        logDiagnostic(
          `Could not load MCP description redaction secrets for ${server}`,
          error,
        );
      }
    }
    try {
      const connected = await this.options.connections.get(
        server,
        options.signal,
      );
      await this.publishLive(server, connected.tools);
      return this.options.catalog.describe(path);
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (authenticationRequired(error)) {
        throw new Error(
          `Authentication required for MCP server ${server}. Run /mcp auth ${server}.`,
        );
      }
      const diagnosticId = logDiagnostic(
        `MCP description ${path} failed`,
        error,
        exactSecrets,
      );
      throw new Error(
        `MCP description ${path} failed. Diagnostic ID: ${diagnosticId}`,
      );
    }
  }

  async call(input: CallInput, options: CallOptions) {
    const startedAt = Date.now();
    let inputBytes = 0;
    let server = "unknown";
    let toolName = "unknown";
    let exactSecrets: readonly string[] = [];
    let record: ServerRecord | undefined;
    const finish = (
      result: CodeModeMcpResult,
      status: CodeModeTraceEntry["status"],
    ) => {
      const trace: CodeModeTraceEntry = {
        server,
        tool: toolName,
        startedAt,
        durationMs: Date.now() - startedAt,
        status,
        inputBytes,
        outputBytes: serializedByteLength(result),
      };
      options.onStatus?.({
        message: `${status === "ok" ? "Completed" : "Finished"} ${server}.${toolName}`,
        trace,
      });
      return result;
    };

    try {
      options.signal.throwIfAborted();
      ({ server, tool: toolName } = splitPath(input.path));
      record = (await this.options.registry.list()).find(
        (candidate) => candidate.name === server,
      );
      if (record) {
        exactSecrets = (await this.options.getSecretValues?.(record)) ?? [];
      }
      inputBytes = serializedByteLength(input.args);
      const args = mcpArguments(input.args);
      const connected = await this.options.connections.get(
        server,
        options.signal,
      );
      await this.publishLive(server, connected.tools);
      const tool = connected.tools.find(
        (candidate) => candidate.name === toolName,
      );
      if (!tool) {
        return finish(
          expectedFailure(
            "STALE_MCP_TOOL",
            `MCP tool is no longer advertised: ${input.path}`,
          ),
          "error",
        );
      }

      this.validator.validate(tool.inputSchema, args);
      const config = await this.options.getConfig();
      const decision = resolveConfiguredPermission(config, input.path);
      if (decision === "deny") {
        return finish(
          expectedFailure(
            "PERMISSION_DENIED",
            `MCP call denied: ${input.path}`,
          ),
          "denied",
        );
      }
      if (decision === "ask") {
        if (!options.approve) {
          return finish(
            expectedFailure(
              "APPROVAL_REQUIRED",
              `MCP call requires interactive approval: ${input.path}`,
            ),
            "denied",
          );
        }
        const approved = await options.approve({
          path: input.path,
          description: redactExactSecrets(tool.description, exactSecrets),
          arguments: args,
          exactSecrets,
          parentToolCallId: options.parentToolCallId,
          callCount: options.callCount ?? 1,
          maxCalls: options.maxCalls ?? 25,
          signal: options.signal,
        });
        options.signal.throwIfAborted();
        if (!approved) {
          return finish(
            expectedFailure(
              "PERMISSION_DENIED",
              `MCP call denied: ${input.path}`,
            ),
            "denied",
          );
        }
      }

      const currentTool = connected.tools.find(
        (candidate) => candidate.name === toolName,
      );
      if (!currentTool) {
        return finish(
          expectedFailure(
            "STALE_MCP_TOOL",
            `MCP tool is no longer advertised: ${input.path}`,
          ),
          "error",
        );
      }
      this.validator.validate(currentTool.inputSchema, args);

      options.onStatus?.({
        message: `Calling ${input.path} (${options.callCount ?? 1}/${options.maxCalls ?? 25})…`,
      });
      options.signal.throwIfAborted();
      const raw = await this.options.connections.call(
        server,
        currentTool,
        args,
        options.signal,
      );
      if (record) {
        exactSecrets = (await this.options.getSecretValues?.(record)) ?? [];
      }
      const normalized = normalizeMcpResult(
        redactExactSecrets(raw, exactSecrets),
      );
      return finish(normalized, normalized.ok ? "ok" : "error");
    } catch (error) {
      if (options.signal.aborted) {
        return finish(
          expectedFailure("CANCELLED", "MCP call cancelled"),
          "cancelled",
        );
      }
      if (record) {
        try {
          exactSecrets = (await this.options.getSecretValues?.(record)) ?? [];
        } catch (secretError) {
          logDiagnostic(
            `Could not refresh MCP redaction secrets for ${server}`,
            secretError,
            exactSecrets,
          );
        }
      }
      if (authenticationRequired(error)) {
        return finish(
          expectedFailure(
            "AUTH_REQUIRED",
            `Authentication required for MCP server ${server}. Run /mcp auth ${server}.`,
          ),
          "error",
        );
      }
      if (isExpectedError(error)) {
        const rawMessage =
          error instanceof Error ? error.message : "MCP call failed";
        const message = truncateUtf8(
          redactSecretTokens(
            redactExactSecrets(rawMessage, exactSecrets),
          ).replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
            "",
          ),
          4 * 1024,
        );
        return finish(
          expectedFailure("MCP_REQUEST_REJECTED", message),
          "error",
        );
      }
      return finish(
        diagnosticFailure(input.path, error, exactSecrets),
        "error",
      );
    }
  }

  async close() {
    await this.options.connections.closeAll();
  }
}

export function formatApprovalMessage(request: {
  path: string;
  description?: string;
  arguments: unknown;
  exactSecrets?: readonly string[];
  callCount: number;
  maxCalls: number;
  parentToolCallId?: string;
}) {
  const safeDescription = request.description
    ? truncateUtf8(
        redactSecretTokens(
          redactExactSecrets(request.description, request.exactSecrets ?? []),
        ).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""),
        4 * 1024,
      )
    : undefined;
  const description = safeDescription ? `\n${safeDescription}` : "";
  const parent = request.parentToolCallId
    ? `\nParent execute call: ${truncateUtf8(request.parentToolCallId.replace(/[^A-Za-z0-9_.:-]/g, ""), 256)}`
    : "";
  const remaining = Math.max(0, request.maxCalls - request.callCount);
  return `${request.path}${description}${parent}\nCall ${request.callCount}/${request.maxCalls}; ${remaining} call${remaining === 1 ? "" : "s"} remaining after this one\n\n${formatRedactedArguments(
    redactExactSecrets(request.arguments, request.exactSecrets ?? []),
  )}`;
}
