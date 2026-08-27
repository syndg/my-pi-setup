import type {
  CatalogTool,
  SearchInput,
  SearchResult,
  ToolDescription,
} from "./types.ts";
import { redactSecretTokens } from "./permissions.ts";
import { renderSchemaAsTypeScript } from "./schema.ts";
import { searchCatalogTools, truncateUtf8 } from "./search.ts";

export const MAX_CATALOG_OPERATION_BYTES = 256 * 1024;
export const MAX_DESCRIBE_DESCRIPTION_BYTES = 16 * 1024;
export const MAX_CATALOG_TOOL_BYTES = 512 * 1024;
export const MAX_CATALOG_TOOLS_PER_SERVER = 10_000;
export const MAX_CATALOG_TOOLS = 50_000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/;

export class CatalogCollisionError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`MCP catalog path collision: ${path}`);
    this.name = "CatalogCollisionError";
    this.path = path;
  }
}

export class McpCatalog {
  readonly #cached = new Map<string, Map<string, CatalogTool>>();
  readonly #live = new Map<string, Map<string, CatalogTool>>();

  get size() {
    const servers = new Set([...this.#cached.keys(), ...this.#live.keys()]);
    let size = 0;
    for (const server of servers) {
      size += (this.#live.get(server) ?? this.#cached.get(server))?.size ?? 0;
    }
    return size;
  }

  hasServer(server: string) {
    return this.#live.has(server) || this.#cached.has(server);
  }

  replaceServer(
    server: string,
    tools: Iterable<CatalogTool>,
    freshness: CatalogTool["freshness"] = "live",
  ) {
    validateServerName(server);
    const replacement = new Map<string, CatalogTool>();
    for (const input of tools) {
      const tool = normalizeTool(server, input, freshness);
      if (replacement.has(tool.path))
        throw new CatalogCollisionError(tool.path);
      this.rejectCrossServerCollision(tool, server, freshness);
      replacement.set(tool.path, tool);
      if (replacement.size > MAX_CATALOG_TOOLS_PER_SERVER) {
        throw new Error(
          `MCP server ${server} exceeded ${MAX_CATALOG_TOOLS_PER_SERVER} catalog tools`,
        );
      }
    }
    const servers = new Set([
      ...this.#cached.keys(),
      ...this.#live.keys(),
      server,
    ]);
    let effectiveCount = 0;
    for (const name of servers) {
      const effective =
        name === server && (freshness === "live" || !this.#live.has(name))
          ? replacement
          : (this.#live.get(name) ?? this.#cached.get(name));
      effectiveCount += effective?.size ?? 0;
      if (effectiveCount > MAX_CATALOG_TOOLS) {
        throw new Error(`MCP catalog exceeded ${MAX_CATALOG_TOOLS} tools`);
      }
    }
    this.storeFor(freshness).set(server, replacement);
  }

  replaceCached(server: string, tools: Iterable<CatalogTool>) {
    this.replaceServer(server, tools, "cached");
  }

  replaceLive(server: string, tools: Iterable<CatalogTool>) {
    this.replaceServer(server, tools, "live");
  }

  removeServer(server: string, freshness?: CatalogTool["freshness"]) {
    if (freshness) {
      this.storeFor(freshness).delete(server);
      return;
    }
    this.#cached.delete(server);
    this.#live.delete(server);
  }

  removeCached(server: string) {
    this.removeServer(server, "cached");
  }

  removeLive(server: string) {
    this.removeServer(server, "live");
  }

  clear() {
    this.#cached.clear();
    this.#live.clear();
  }

  lookup(path: string) {
    const separator = path.indexOf(".");
    if (separator <= 0) return undefined;
    const server = path.slice(0, separator);
    const effective = this.#live.has(server)
      ? this.#live.get(server)
      : this.#cached.get(server);
    return effective?.get(path);
  }

  get(path: string) {
    return this.lookup(path);
  }

  has(path: string) {
    return this.lookup(path) !== undefined;
  }

  list() {
    return this.effectiveRecords();
  }

  listServer(server: string) {
    const records = this.#live.has(server)
      ? this.#live.get(server)
      : this.#cached.get(server);
    return records ? [...records.values()].sort(compareTools) : [];
  }

  search(input: SearchInput): SearchResult {
    const result = searchCatalogTools(this.effectiveRecords(), input);
    assertBoundedOperation(result);
    return result;
  }

  describe(path: string): ToolDescription {
    const tool = this.lookup(path);
    if (!tool) throw new Error(`Unknown MCP tool: ${path}`);
    return describeCatalogTool(tool);
  }

  #storeEntries(freshness: CatalogTool["freshness"]) {
    return this.storeFor(freshness).values();
  }

  private storeFor(freshness: CatalogTool["freshness"]) {
    return freshness === "live" ? this.#live : this.#cached;
  }

  private rejectCrossServerCollision(
    tool: CatalogTool,
    replacingServer: string,
    freshness: CatalogTool["freshness"],
  ) {
    for (const records of this.#storeEntries(freshness)) {
      const existing = records.get(tool.path);
      if (existing && existing.server !== replacingServer) {
        throw new CatalogCollisionError(tool.path);
      }
    }
  }

  private effectiveRecords() {
    const servers = new Set([...this.#cached.keys(), ...this.#live.keys()]);
    const records: CatalogTool[] = [];
    for (const server of servers) {
      const effective = this.#live.has(server)
        ? this.#live.get(server)
        : this.#cached.get(server);
      if (effective) records.push(...effective.values());
    }
    return records.sort(compareTools);
  }
}

export const Catalog = McpCatalog;

export function describeCatalogTool(tool: CatalogTool): ToolDescription {
  const description = tool.description
    ? truncateUtf8(
        redactSecretTokens(tool.description),
        MAX_DESCRIBE_DESCRIPTION_BYTES,
      )
    : undefined;
  const base: ToolDescription = {
    path: tool.path,
    ...(description ? { description } : {}),
    input: renderSchemaAsTypeScript(tool.inputSchema),
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    freshness: tool.freshness,
  };
  if (serializedByteLength(base) <= MAX_CATALOG_OPERATION_BYTES) return base;

  const { annotations: _annotations, ...withoutAnnotations } = base;
  const boundedBase = base.annotations ? withoutAnnotations : base;
  if (serializedByteLength(boundedBase) <= MAX_CATALOG_OPERATION_BYTES) {
    return boundedBase;
  }

  const withoutSchema: ToolDescription = {
    ...boundedBase,
    inputSchema: {
      omitted: true,
      reason: "Input schema exceeded the catalog description output limit",
    },
  };
  assertBoundedOperation(withoutSchema);
  return withoutSchema;
}

function normalizeTool(
  server: string,
  input: CatalogTool,
  freshness: CatalogTool["freshness"],
) {
  if (serializedByteLength(input) > MAX_CATALOG_TOOL_BYTES) {
    throw new Error(
      `MCP catalog tool exceeded ${MAX_CATALOG_TOOL_BYTES} bytes`,
    );
  }
  if (input.server !== server) {
    throw new Error(
      `MCP catalog server mismatch: expected ${server}, received ${input.server}`,
    );
  }
  if (!TOOL_NAME_PATTERN.test(input.name)) {
    throw new Error(`Invalid MCP tool name for server ${server}`);
  }
  const path = `${server}.${input.name}`;
  if (path.length > 256) {
    throw new Error(`MCP catalog path exceeds 256 characters: ${server}`);
  }
  if (input.path !== path) {
    throw new Error(`Invalid MCP catalog path: expected ${path}`);
  }
  const description = input.description
    ? redactSecretTokens(input.description)
    : undefined;
  return Object.freeze({
    ...input,
    ...(description ? { description } : {}),
    freshness,
  });
}

function validateServerName(server: string) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(server)) {
    throw new Error(`Invalid MCP server namespace: ${server}`);
  }
}

function compareTools(a: CatalogTool, b: CatalogTool) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function assertBoundedOperation(value: unknown) {
  const bytes = serializedByteLength(value);
  if (bytes > MAX_CATALOG_OPERATION_BYTES) {
    throw new Error(
      `MCP catalog operation exceeded ${MAX_CATALOG_OPERATION_BYTES} bytes`,
    );
  }
}

function serializedByteLength(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
