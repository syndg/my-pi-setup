import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import {
  createBoundedFetch,
  MAX_MCP_HTTP_RESPONSE_BYTES,
} from "./bounded-fetch.ts";
import { DEFAULT_CODE_MODE_TIMEOUT_MS } from "../limits.ts";
import { resolveTemplate } from "./config-environment.ts";
import type { ServerConfig, ServerRecord } from "./types.ts";

const MAX_CONNECTING_SERVERS = 4;

type ManagedTransport = StdioClientTransport | StreamableHTTPClientTransport;

type ConnectedServer = {
  client: Client;
  transport: ManagedTransport;
  tools: Tool[];
  fingerprint: string;
  requestTimeoutMs: number;
  lifecycleController: AbortController;
};

type PendingConnection = {
  promise: Promise<ConnectedServer>;
  controller: AbortController;
  waiters: number;
};

type ConnectionManagerOptions = {
  getServers: () => Promise<ServerRecord[]>;
  createOAuthProvider?: (
    record: ServerRecord,
    signal: AbortSignal,
  ) => Promise<OAuthClientProvider | undefined>;
  onToolsChanged?: (server: string, tools: Tool[]) => void | Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<void>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([previous.catch(() => undefined), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function resolvedEnvironment(
  config: Extract<ServerConfig, { transport: "stdio" }>,
) {
  const result: Record<string, string> = getDefaultEnvironment();
  if (!config.env) return result;
  for (const [name, value] of Object.entries(config.env)) {
    result[name] = resolveTemplate(value, `stdio environment ${name}`);
  }
  return result;
}

function resolvedHeaders(config: Extract<ServerConfig, { transport: "http" }>) {
  if (!config.headers) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers)) {
    result[name] = resolveTemplate(value, `HTTP header ${name}`);
  }
  return result;
}

function canonicalFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalFingerprintValue(entry)]),
  );
}

export function nonSecretServerFingerprint(
  record: Pick<ServerRecord, "name" | "scope" | "config">,
) {
  const identity = canonicalFingerprintValue({
    version: 3,
    name: record.name,
    scope: record.scope,
    config: record.config,
  });
  return `v3:${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
}

export class McpConnectionManager {
  private readonly live = new Map<string, ConnectedServer>();
  private readonly connecting = new Map<string, PendingConnection>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private callQueue: Promise<void> = Promise.resolve();
  private activeConnections = 0;
  private readonly connectionWaiters: Array<() => void> = [];
  private lifecycle = 0;
  private shutdown: Promise<void> | undefined;
  private readonly options: ConnectionManagerOptions;

  constructor(options: ConnectionManagerOptions) {
    this.options = options;
  }

  private async record(name: string) {
    const record = (await this.options.getServers()).find(
      (candidate) => candidate.name === name,
    );
    if (!record || !record.enabled) {
      throw new Error(`MCP server is not configured or enabled: ${name}`);
    }
    return record;
  }

  private async acquireConnectionSlot(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.activeConnections < MAX_CONNECTING_SERVERS) {
      this.activeConnections += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener("abort", onAbort);
        this.activeConnections += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.connectionWaiters.indexOf(waiter);
        if (index >= 0) this.connectionWaiters.splice(index, 1);
        reject(signal.reason ?? new Error("MCP connection cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.connectionWaiters.push(waiter);
    });
  }

  private releaseConnectionSlot() {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.connectionWaiters.shift()?.();
  }

  private async create(record: ServerRecord, signal: AbortSignal) {
    await this.acquireConnectionSlot(signal);
    let client: Client | undefined;
    let transport: ManagedTransport | undefined;
    const lifecycleController = new AbortController();
    try {
      const requestTimeoutMs =
        record.config.requestTimeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
      const fingerprint = nonSecretServerFingerprint(record);
      client = new Client(
        { name: "pi-code-mode", version: "1.0.0" },
        {
          listMaxPages: 64,
          listChanged: {
            tools: {
              autoRefresh: false,
              onChanged: async (error) => {
                if (error) return;
                const current = this.live.get(record.name);
                if (!current || current.client !== client) return;
                try {
                  const listed = await client.listTools(undefined, {
                    signal: lifecycleController.signal,
                    timeout: requestTimeoutMs,
                    maxTotalTimeout: requestTimeoutMs,
                    cacheMode: "refresh",
                  });
                  const latest = this.live.get(record.name);
                  if (!latest || latest.client !== client) return;
                  latest.tools = listed.tools;
                  await this.options.onToolsChanged?.(
                    record.name,
                    listed.tools,
                  );
                } catch {
                  // A later explicit refresh or reconnect can recover.
                }
              },
            },
          },
        },
      );

      if (record.config.transport === "stdio") {
        const stdio = new StdioClientTransport({
          command: record.config.command,
          args: record.config.args,
          env: resolvedEnvironment(record.config),
          cwd: record.config.cwd,
          stderr: "pipe",
          maxBufferSize: 5 * 1024 * 1024,
        });
        // Drain untrusted server diagnostics so a chatty child cannot block on
        // a full stderr pipe. Diagnostics are intentionally not persisted.
        stdio.stderr?.on("data", () => undefined);
        transport = stdio;
      } else {
        transport = new StreamableHTTPClientTransport(
          new URL(record.config.url),
          {
            requestInit: { headers: resolvedHeaders(record.config) },
            fetch: createBoundedFetch(MAX_MCP_HTTP_RESPONSE_BYTES),
            authProvider:
              record.config.oauth === true
                ? await this.options.createOAuthProvider?.(record, signal)
                : undefined,
            onInsufficientScope: "throw",
            reconnectionOptions: {
              initialReconnectionDelay: 500,
              maxReconnectionDelay: 5_000,
              reconnectionDelayGrowFactor: 1.5,
              maxRetries: 2,
            },
          },
        );
      }

      await client.connect(transport, {
        signal,
        timeout: requestTimeoutMs,
        maxTotalTimeout: requestTimeoutMs,
      });
      const listed = await client.listTools(undefined, {
        signal,
        timeout: requestTimeoutMs,
        maxTotalTimeout: requestTimeoutMs,
        cacheMode: "refresh",
      });
      const connected = {
        client,
        transport,
        tools: listed.tools,
        fingerprint,
        requestTimeoutMs,
        lifecycleController,
      };
      client.onclose = () => {
        lifecycleController.abort(
          new DOMException("MCP connection closed", "AbortError"),
        );
        const current = this.live.get(record.name);
        if (current?.client === client) this.live.delete(record.name);
      };
      return connected;
    } catch (error) {
      lifecycleController.abort(
        new DOMException("MCP connection failed", "AbortError"),
      );
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      throw error;
    } finally {
      this.releaseConnectionSlot();
    }
  }

  private async waitForPending(
    name: string,
    entry: PendingConnection,
    signal: AbortSignal,
  ) {
    entry.waiters += 1;
    try {
      return await waitForCaller(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (
        entry.waiters === 0 &&
        this.connecting.get(name) === entry &&
        !entry.controller.signal.aborted
      ) {
        entry.controller.abort(
          new DOMException(
            "All MCP connection waiters cancelled",
            "AbortError",
          ),
        );
      }
    }
  }

  private generation(name: string) {
    return this.generations.get(name) ?? 0;
  }

  private lifecycleError(name: string) {
    return new Error(`MCP server ${name} lifecycle changed`);
  }

  private assertCurrent(name: string, generation: number, lifecycle: number) {
    if (this.lifecycle !== lifecycle || this.generation(name) !== generation) {
      throw this.lifecycleError(name);
    }
    if (this.shutdown) {
      throw new Error("MCP connection manager is shutting down");
    }
  }

  private async dispose(connected: ConnectedServer) {
    connected.lifecycleController.abort(
      new DOMException("MCP connection disposed", "AbortError"),
    );
    await connected.client.close().catch(() => undefined);
    await connected.transport.close().catch(() => undefined);
  }

  private async evict(name: string, connected: ConnectedServer) {
    if (this.live.get(name) === connected) this.live.delete(name);
    await this.dispose(connected);
  }

  async get(name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const lifecycle = this.lifecycle;
    if (this.shutdown) {
      throw new Error("MCP connection manager is shutting down");
    }

    const closing = this.closing.get(name);
    if (closing) await closing;
    if (this.lifecycle !== lifecycle) throw this.lifecycleError(name);
    let generation = this.generation(name);

    const record = await this.record(name);
    signal.throwIfAborted();
    this.assertCurrent(name, generation, lifecycle);
    const fingerprint = nonSecretServerFingerprint(record);
    const existing = this.live.get(name);
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) {
      await this.close(name);
      generation = this.generation(name);
      this.assertCurrent(name, generation, lifecycle);
    }

    const pending = this.connecting.get(name);
    if (pending) return this.waitForPending(name, pending, signal);

    const controller = new AbortController();

    let entry!: PendingConnection;
    const operation = this.create(record, controller.signal)
      .then(async (connected) => {
        try {
          this.assertCurrent(name, generation, lifecycle);
          if (this.connecting.get(name) !== entry) {
            throw this.lifecycleError(name);
          }
          this.live.set(name, connected);
          await this.options.onToolsChanged?.(name, connected.tools);
          this.assertCurrent(name, generation, lifecycle);
          if (this.live.get(name) !== connected) {
            throw this.lifecycleError(name);
          }
          return connected;
        } catch (error) {
          await this.evict(name, connected);
          throw error;
        }
      })
      .catch((error: unknown) => {
        throw new Error(
          `Failed to connect MCP server ${name}: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      })
      .finally(() => {
        if (this.connecting.get(name) === entry) {
          this.connecting.delete(name);
        }
      });
    entry = { promise: operation, controller, waiters: 0 };
    this.connecting.set(name, entry);
    return this.waitForPending(name, entry, signal);
  }

  async refresh(name: string, signal: AbortSignal) {
    const connected = await this.get(name, signal);
    try {
      const listed = await connected.client.listTools(undefined, {
        signal,
        timeout: connected.requestTimeoutMs,
        maxTotalTimeout: connected.requestTimeoutMs,
        cacheMode: "refresh",
      });
      connected.tools = listed.tools;
      await this.options.onToolsChanged?.(name, listed.tools);
      return listed.tools;
    } catch (error) {
      await this.evict(name, connected);
      throw error;
    }
  }

  async call(
    name: string,
    tool: Tool,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) {
    const lifecycle = this.lifecycle;
    const generation = this.generation(name);
    const previous = this.callQueue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.callQueue = tail;
    let connected: ConnectedServer | undefined;
    try {
      await waitForTurn(previous, signal);
      signal.throwIfAborted();
      this.assertCurrent(name, generation, lifecycle);
      connected = await this.get(name, signal);
      const currentTool = connected.tools.find(
        (candidate) => candidate.name === tool.name,
      );
      if (!currentTool) {
        throw new Error(
          `MCP tool is no longer advertised: ${name}.${tool.name}`,
        );
      }
      if (
        JSON.stringify(currentTool.inputSchema) !==
        JSON.stringify(tool.inputSchema)
      ) {
        throw new Error(
          `MCP tool definition changed before invocation: ${name}.${tool.name}; retry the call`,
        );
      }
      return await connected.client.callTool(
        { name: tool.name, arguments: args },
        {
          signal,
          timeout: connected.requestTimeoutMs,
          maxTotalTimeout: connected.requestTimeoutMs,
          toolDefinition: currentTool,
        },
      );
    } catch (error) {
      if (connected) await this.evict(name, connected);
      throw error;
    } finally {
      release();
      if (this.callQueue === tail) this.callQueue = Promise.resolve();
    }
  }

  async reconnect(name: string, signal: AbortSignal) {
    const lifecycle = this.lifecycle;
    await this.close(name);
    if (this.lifecycle !== lifecycle) throw this.lifecycleError(name);
    return this.get(name, signal);
  }

  close(name: string) {
    const closing = this.closing.get(name);
    if (closing) return closing;

    this.generations.set(name, this.generation(name) + 1);
    const pending = this.connecting.get(name);
    pending?.controller.abort(this.lifecycleError(name));
    const connected = this.live.get(name);
    this.live.delete(name);

    const cleanup = Promise.all([
      pending?.promise.catch(() => undefined),
      connected ? this.dispose(connected) : undefined,
    ]).then(() => undefined);
    let tracked!: Promise<void>;
    tracked = cleanup.finally(() => {
      if (this.closing.get(name) === tracked) this.closing.delete(name);
    });
    this.closing.set(name, tracked);
    return tracked;
  }

  closeAll() {
    if (this.shutdown) return this.shutdown;

    this.lifecycle += 1;
    const names = new Set([
      ...this.live.keys(),
      ...this.connecting.keys(),
      ...this.closing.keys(),
    ]);
    const cleanup = Promise.all([
      ...[...names].map((name) => this.close(name)),
      this.callQueue.catch(() => undefined),
    ]).then(() => undefined);
    let tracked!: Promise<void>;
    tracked = cleanup.finally(() => {
      if (this.shutdown === tracked) this.shutdown = undefined;
    });
    this.shutdown = tracked;
    return tracked;
  }

  status(name: string) {
    if (this.live.has(name)) return "connected" as const;
    if (this.connecting.has(name)) return "connecting" as const;
    return "disconnected" as const;
  }
}
