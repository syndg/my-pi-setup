import { Bash } from "just-bash";

import { codeModeExecutionLimits, CODE_MODE_LIMITS } from "./limits.ts";
import { logDiagnostic } from "./mcp/errors.ts";
import { buildProgram, createResultSentinel, PROGRAM_PATH } from "./program.ts";
import { boundStderr, parseProgramResult, truncateUtf8 } from "./result.ts";
import type {
  CodeModeMcpResult,
  CodeModeTraceEntry,
  RuntimeOptions,
  RuntimeResult,
} from "./types.ts";
import type {
  CallStatus,
  SearchInput,
  SearchResult,
  ToolDescription,
} from "./mcp/types.ts";

const DIRECT_PATH_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$-]*\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const RESERVED_NAMESPACES = new Set([
  "call",
  "describe",
  "execute",
  "search",
  "tools",
]);
const MAX_PATH_LENGTH = 256;
const MAX_STATUS_UPDATES = CODE_MODE_LIMITS.maxCalls * 2 + 10;
let sandboxRuntimeActive = false;

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function abortError() {
  return new DOMException("Code Mode execution cancelled", "AbortError");
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal) {
  assertActive(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseToolArguments(argsJson: string) {
  if (argsJson === "") return undefined;

  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    throw new Error("Malformed tool arguments JSON");
  }
}

function requireCanonicalPath(value: unknown, operation: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    !DIRECT_PATH_PATTERN.test(value)
  ) {
    throw new Error(`${operation} requires a canonical server.tool path`);
  }

  const namespace = value.slice(0, value.indexOf("."));
  if (RESERVED_NAMESPACES.has(namespace)) {
    throw new Error(`Reserved tool namespace: ${namespace}`);
  }

  return value;
}

function parseSearchInput(value: unknown): SearchInput {
  if (!isRecord(value) || typeof value.query !== "string") {
    throw new Error("tools.search requires an object with a query string");
  }
  if (byteLength(value.query) > 8 * 1024) {
    throw new Error("tools.search query exceeds 8192 bytes");
  }

  if (
    value.limit !== undefined &&
    (typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 20)
  ) {
    throw new Error("tools.search limit must be an integer from 1 to 20");
  }

  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new Error("tools.search cursor must be a string");
  }
  if (
    typeof value.cursor === "string" &&
    byteLength(value.cursor) > 16 * 1024
  ) {
    throw new Error("tools.search cursor exceeds 16384 bytes");
  }

  return {
    query: value.query,
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  };
}

function parseDescribePath(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("tools.describe requires an object with a path");
  }
  return requireCanonicalPath(value.path, "tools.describe");
}

function parseDynamicCall(value: unknown) {
  if (!isRecord(value) || !Object.hasOwn(value, "args")) {
    throw new Error("tools.call requires an object with path and args");
  }

  return {
    path: requireCanonicalPath(value.path, "tools.call"),
    args: value.args,
  };
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
    return false;
  }

  return value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.path === "string" &&
      typeof item.input === "string" &&
      (item.description === undefined ||
        typeof item.description === "string") &&
      (item.freshness === "cached" || item.freshness === "live"),
  );
}

function isToolDescription(value: unknown): value is ToolDescription {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.input === "string" &&
    Object.hasOwn(value, "inputSchema") &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    (value.freshness === "cached" || value.freshness === "live")
  );
}

function isCodeModeMcpResult(value: unknown): value is CodeModeMcpResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!Array.isArray(value.content)) return false;
  if (
    value.error !== undefined &&
    (!isRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string")
  ) {
    return false;
  }

  return value.content.every((item) => {
    if (!isRecord(item) || typeof item.type !== "string") return false;
    if (item.type === "text") return typeof item.text === "string";
    if (item.type === "image") {
      return (
        typeof item.mediaType === "string" &&
        (item.data === undefined || typeof item.data === "string")
      );
    }
    if (item.type === "resource") {
      return (
        typeof item.uri === "string" &&
        (item.text === undefined || typeof item.text === "string")
      );
    }
    return false;
  });
}

function serialize(value: unknown, label: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON-serializable`);
  }

  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  return serialized;
}

function traceStatusFor(result: CodeModeMcpResult) {
  if (result.ok) return "ok" as const;
  if (result.error?.code.toLowerCase().includes("denied")) {
    return "denied" as const;
  }
  return "error" as const;
}

function safeNonNegativeInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER)
    : fallback;
}

function sanitizeTrace(
  value: unknown,
  fallback: CodeModeTraceEntry,
): CodeModeTraceEntry {
  if (!isRecord(value)) return fallback;
  const status =
    value.status === "ok" ||
    value.status === "error" ||
    value.status === "denied" ||
    value.status === "cancelled"
      ? value.status
      : fallback.status;

  return {
    server: truncateUtf8(
      typeof value.server === "string" ? value.server : fallback.server,
      128,
    ),
    tool: truncateUtf8(
      typeof value.tool === "string" ? value.tool : fallback.tool,
      128,
    ),
    startedAt: safeNonNegativeInteger(value.startedAt, fallback.startedAt),
    durationMs: safeNonNegativeInteger(value.durationMs, fallback.durationMs),
    status,
    inputBytes: safeNonNegativeInteger(value.inputBytes, fallback.inputBytes),
    outputBytes: safeNonNegativeInteger(
      value.outputBytes,
      fallback.outputBytes,
    ),
  };
}

function createEffectiveSignal(
  parent: AbortSignal,
  executionTimeMs: number = CODE_MODE_LIMITS.executionTimeMs,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);

  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Code Mode deadline exceeded", "TimeoutError"),
      ),
    executionTimeMs,
  );

  return {
    signal: controller.signal,
    dispose(abortPendingOperations = false) {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abortFromParent);
      if (abortPendingOperations && !controller.signal.aborted) {
        controller.abort(
          new DOMException("Code Mode execution finished", "AbortError"),
        );
      }
    },
  };
}

export async function executeCodeMode(
  source: string,
  options: RuntimeOptions,
): Promise<RuntimeResult> {
  const startedAt = Date.now();
  const sentinel = createResultSentinel();
  const program = buildProgram(source, sentinel);
  const executionTimeoutMs =
    options.executionTimeoutMs ?? CODE_MODE_LIMITS.executionTimeMs;
  const effective = createEffectiveSignal(options.signal, executionTimeoutMs);
  const trace: CodeModeTraceEntry[] = [];
  let calls = 0;
  let intermediateBytes = 0;
  let statusUpdates = 0;
  let operationActive = false;
  const pendingOperations = new Set<Promise<string>>();

  const emitStatus = (message: string) => {
    if (
      effective.signal.aborted ||
      statusUpdates >= MAX_STATUS_UPDATES ||
      !options.onStatus
    ) {
      return;
    }

    statusUpdates += 1;
    try {
      options.onStatus({
        message: truncateUtf8(message, CODE_MODE_LIMITS.maxStatusBytes),
        calls,
        maxCalls: CODE_MODE_LIMITS.maxCalls,
      });
    } catch {
      // Status rendering must never affect sandbox execution.
    }
  };

  const accountOutput = (
    serialized: string,
    perOperationLimit: number,
    label: string,
  ) => {
    const bytes = byteLength(serialized);
    if (bytes > perOperationLimit) {
      throw new RangeError(`${label} exceeds ${perOperationLimit} bytes`);
    }
    if (bytes > CODE_MODE_LIMITS.maxIntermediateBytes - intermediateBytes) {
      throw new RangeError(
        `Aggregate intermediate MCP data exceeds ${CODE_MODE_LIMITS.maxIntermediateBytes} bytes`,
      );
    }
    intermediateBytes += bytes;
    return bytes;
  };

  const invokeMcp = async (path: string, args: unknown, argsJson: string) => {
    assertActive(effective.signal);
    const inputBytes = byteLength(argsJson);
    if (inputBytes > CODE_MODE_LIMITS.maxMcpArgumentBytes) {
      throw new RangeError(
        `MCP arguments exceed ${CODE_MODE_LIMITS.maxMcpArgumentBytes} bytes`,
      );
    }
    if (calls >= CODE_MODE_LIMITS.maxCalls) {
      throw new RangeError(
        `Code Mode MCP call limit exceeded (${CODE_MODE_LIMITS.maxCalls})`,
      );
    }

    calls += 1;
    emitStatus(`Calling ${path} (${calls}/${CODE_MODE_LIMITS.maxCalls})…`);

    const callStartedAt = Date.now();
    const separator = path.indexOf(".");
    const fallbackTrace: CodeModeTraceEntry = {
      server: path.slice(0, separator),
      tool: path.slice(separator + 1),
      startedAt: callStartedAt,
      durationMs: 0,
      status: "error",
      inputBytes,
      outputBytes: 0,
    };
    let hostTrace: unknown;

    const onHostStatus = (status: CallStatus) => {
      if (!isRecord(status)) return;
      if (typeof status.message === "string") emitStatus(status.message);
      if (status.trace) hostTrace = status.trace;
    };

    try {
      const result = await waitForAbortable(
        options.host.call(
          { path, args },
          {
            signal: effective.signal,
            parentToolCallId: options.parentToolCallId,
            callCount: calls,
            maxCalls: CODE_MODE_LIMITS.maxCalls,
            onStatus: onHostStatus,
            approve: options.approve,
          },
        ),
        effective.signal,
      );
      assertActive(effective.signal);

      if (!isCodeModeMcpResult(result)) {
        throw new Error("MCP host returned a malformed call result");
      }

      const serialized = serialize(result, "MCP result");
      fallbackTrace.outputBytes = accountOutput(
        serialized,
        CODE_MODE_LIMITS.maxMcpResultBytes,
        "MCP result",
      );
      fallbackTrace.status = traceStatusFor(result);
      return serialized;
    } catch (error) {
      fallbackTrace.status = effective.signal.aborted ? "cancelled" : "error";
      throw error;
    } finally {
      fallbackTrace.durationMs = Date.now() - callStartedAt;
      if (trace.length < CODE_MODE_LIMITS.maxCalls) {
        trace.push(
          hostTrace ? sanitizeTrace(hostTrace, fallbackTrace) : fallbackTrace,
        );
      }
    }
  };

  const routeTool = async (path: string, argsJson: string) => {
    assertActive(effective.signal);
    if (byteLength(argsJson) > CODE_MODE_LIMITS.maxMcpArgumentBytes) {
      throw new RangeError(
        `MCP arguments exceed ${CODE_MODE_LIMITS.maxMcpArgumentBytes} bytes`,
      );
    }
    if (operationActive) {
      throw new Error("Code Mode operations must be sequential");
    }
    operationActive = true;

    try {
      const parsed = parseToolArguments(argsJson);

      if (path === "search") {
        const input = parseSearchInput(parsed);
        emitStatus("Searching MCP catalog…");
        let result: unknown;
        try {
          result = await waitForAbortable(
            options.host.search(input, { signal: effective.signal }),
            effective.signal,
          );
        } catch (error) {
          if (effective.signal.aborted) throw error;
          const diagnosticId = logDiagnostic(
            "MCP catalog search failed",
            error,
          );
          throw new Error(
            `MCP catalog search failed. Diagnostic ID: ${diagnosticId}`,
          );
        }
        if (!isSearchResult(result)) {
          throw new Error("MCP host returned a malformed search result");
        }
        const serialized = serialize(result, "MCP search result");
        accountOutput(
          serialized,
          CODE_MODE_LIMITS.maxOperationOutputBytes,
          "MCP search result",
        );
        return serialized;
      }

      if (path === "describe") {
        const selectedPath = parseDescribePath(parsed);
        emitStatus(`Describing ${selectedPath}…`);
        let result: unknown;
        try {
          result = await waitForAbortable(
            options.host.describe(selectedPath, { signal: effective.signal }),
            effective.signal,
          );
        } catch (error) {
          if (effective.signal.aborted) throw error;
          if (
            error instanceof Error &&
            error.message.startsWith("Authentication required for MCP server ")
          ) {
            throw error;
          }
          const diagnosticId = logDiagnostic(
            "MCP tool description failed",
            error,
          );
          throw new Error(
            `MCP tool description failed. Diagnostic ID: ${diagnosticId}`,
          );
        }
        if (!isToolDescription(result)) {
          throw new Error("MCP host returned a malformed tool description");
        }
        const serialized = serialize(result, "MCP description");
        accountOutput(
          serialized,
          CODE_MODE_LIMITS.maxOperationOutputBytes,
          "MCP description",
        );
        return serialized;
      }

      if (path === "call") {
        const input = parseDynamicCall(parsed);
        return invokeMcp(
          input.path,
          input.args,
          serialize(input.args, "MCP arguments"),
        );
      }

      if (!path.includes(".")) {
        if (RESERVED_NAMESPACES.has(path)) {
          throw new Error(`Operation is not available: tools.${path}`);
        }
        throw new Error(`Unknown Code Mode operation: ${path}`);
      }

      const directPath = requireCanonicalPath(path, "Direct tool call");
      return invokeMcp(directPath, parsed, argsJson);
    } finally {
      operationActive = false;
    }
  };

  const invokeTool = async (path: string, argsJson: string) => {
    const operation = routeTool(path, argsJson);
    pendingOperations.add(operation);
    try {
      return await operation;
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Code Mode operation failed";
      return JSON.stringify({
        __codeModeBridgeError: sentinel,
        message: truncateUtf8(message, 2_048),
      });
    } finally {
      pendingOperations.delete(operation);
    }
  };

  if (sandboxRuntimeActive) {
    effective.dispose();
    throw new Error(
      "Concurrent Code Mode sandbox execution is not supported; serialize execute calls",
    );
  }
  sandboxRuntimeActive = true;
  try {
    const bash = new Bash({
      files: { [PROGRAM_PATH]: program },
      cwd: "/workspace",
      env: {},
      commands: [],
      executionLimitProfile: "hardened",
      executionLimits: codeModeExecutionLimits(executionTimeoutMs),
      python: false,
      javascript: { invokeTool },
    });
    const execution = await bash
      .exec("js-exec", {
        args: [PROGRAM_PATH],
        cwd: "/workspace",
        env: {},
        replaceEnv: true,
        signal: effective.signal,
      })
      .catch((error: unknown) => {
        effective.signal.throwIfAborted();
        const diagnosticId = logDiagnostic(
          "Code Mode sandbox runtime failed",
          error,
        );
        throw new Error(
          `Code Mode sandbox runtime failed. Diagnostic ID: ${diagnosticId}`,
        );
      });

    if (effective.signal.aborted) {
      return {
        stdout: truncateUtf8(execution.stdout, CODE_MODE_LIMITS.maxStdoutBytes),
        stderr: "Code Mode execution cancelled",
        trace,
        calls,
        durationMs: Date.now() - startedAt,
        cancelled: true,
      };
    }

    if (execution.exitCode !== 0) {
      const diagnostic = boundStderr(
        execution.stderr ||
          execution.stdout ||
          "Code Mode guest program failed",
      );
      throw new Error(diagnostic);
    }

    const parsed = parseProgramResult(execution.stdout, sentinel);
    if (!parsed.found) {
      const diagnostic = boundStderr(
        execution.stderr ||
          execution.stdout ||
          "Code Mode guest program completed without a return record",
      );
      throw new Error(diagnostic);
    }
    const result: RuntimeResult = {
      stdout: parsed.stdout,
      stderr: boundStderr(execution.stderr),
      trace,
      calls,
      durationMs: Date.now() - startedAt,
      cancelled: false,
      ...(parsed.value !== undefined ? { value: parsed.value } : {}),
    };

    emitStatus(
      `Completed ${calls} MCP call${calls === 1 ? "" : "s"} in ${result.durationMs}ms`,
    );
    return result;
  } catch (error) {
    if (effective.signal.aborted) {
      return {
        stdout: "",
        stderr: "Code Mode execution cancelled",
        trace,
        calls,
        durationMs: Date.now() - startedAt,
        cancelled: true,
      };
    }
    throw error;
  } finally {
    sandboxRuntimeActive = false;
    effective.dispose(pendingOperations.size > 0);
  }
}
