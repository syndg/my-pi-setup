import { readFileSync } from "node:fs";
import type {
  BudgetPressure,
  OutputBrokerConfigInput,
  OutputClass,
  PressureLevel,
} from "../../context-archive/src/index.ts";

export type ContextOutputMode = "off" | "shadow" | "enforce";

export interface ErrorResultBudgetConfig {
  readonly hardCeilingBytes: number;
  readonly limitsBytes: Readonly<Record<BudgetPressure, number>>;
}

export interface ContextOutputConfig {
  readonly mode: ContextOutputMode;
  readonly toolClasses: Readonly<Record<string, OutputClass>>;
  readonly prefixClasses: Readonly<Record<string, OutputClass>>;
  readonly explicitLimitBytes: Readonly<Record<string, number>>;
  readonly broker?: OutputBrokerConfigInput;
  readonly errors: ErrorResultBudgetConfig;
  readonly recall: {
    readonly defaultBytes: number;
    readonly maximumBytes: number;
    readonly maximumLines: number;
    readonly maximumQueryResults: number;
  };
  readonly metrics: {
    readonly emitEvents: boolean;
    readonly appendEntries: boolean;
    readonly maximumEntriesPerSession: number;
  };
  readonly completions: {
    readonly enabled: boolean;
    readonly maximumExternalReferences: number;
  };
}

const OUTPUT_CLASSES = new Set<OutputClass>([
  "read",
  "search",
  "mcp-result",
  "subagent-final",
  "child-live-message",
  "background-completion",
]);

const DEFAULT_TOOL_CLASSES: Readonly<Record<string, OutputClass>> =
  Object.freeze({
    read: "read",
    fd: "search",
    rg: "search",
    grep: "search",
    find: "search",
    mcp: "mcp-result",
    subagent_wait: "subagent-final",
    subagent_inbox: "child-live-message",
    workflow: "subagent-final",
    bg_status: "background-completion",
    bg_kill: "background-completion",
  });

const ERROR_LIMIT_MINIMUM_BYTES = 256;
const DEFAULT_ERROR_RESULT_CONFIG: ErrorResultBudgetConfig = Object.freeze({
  hardCeilingBytes: 64 * 1024,
  // Error diagnostics get more room than ordinary sources at Green, then
  // contract under pressure without becoming status-only.
  limitsBytes: Object.freeze({
    green: 32 * 1024,
    yellow: 24 * 1024,
    orange: 16 * 1024,
    red: 8 * 1024,
  }),
});

export const DEFAULT_CONTEXT_OUTPUT_CONFIG: ContextOutputConfig = Object.freeze(
  {
    // Observation only: pressure-adaptive shortening remains disabled until the
    // governor observation gate is reviewed.
    mode: "shadow",
    toolClasses: DEFAULT_TOOL_CLASSES,
    prefixClasses: Object.freeze({ mcp_: "mcp-result" }),
    explicitLimitBytes: Object.freeze({}),
    errors: DEFAULT_ERROR_RESULT_CONFIG,
    recall: Object.freeze({
      defaultBytes: 16 * 1024,
      maximumBytes: 64 * 1024,
      maximumLines: 500,
      maximumQueryResults: 20,
    }),
    metrics: Object.freeze({
      emitEvents: true,
      appendEntries: false,
      maximumEntriesPerSession: 64,
    }),
    completions: Object.freeze({
      enabled: true,
      maximumExternalReferences: 8,
    }),
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum = 16 * 1024 * 1024,
) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 16 * 1024 * 1024)
    : undefined;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function outputClassMap(
  value: unknown,
  fallback: Readonly<Record<string, OutputClass>>,
): Readonly<Record<string, OutputClass>> {
  if (!isRecord(value)) return fallback;
  const result: Record<string, OutputClass> = { ...fallback };
  for (const [rawName, rawClass] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (name && OUTPUT_CLASSES.has(rawClass as OutputClass)) {
      result[name] = rawClass as OutputClass;
    }
  }
  return Object.freeze(result);
}

function explicitLimits(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return Object.freeze({});
  const result: Record<string, number> = {};
  for (const [rawName, rawLimit] of Object.entries(value)) {
    const limit = nonNegativeInteger(rawLimit);
    const name = rawName.trim().toLowerCase();
    if (name && limit !== undefined) result[name] = limit;
  }
  return Object.freeze(result);
}

function errorResultConfig(value: unknown): ErrorResultBudgetConfig {
  const source = isRecord(value) ? value : {};
  const limits = isRecord(source.limitsBytes) ? source.limitsBytes : {};
  const hardCeilingBytes = Math.max(
    ERROR_LIMIT_MINIMUM_BYTES,
    positiveInteger(
      source.hardCeilingBytes,
      DEFAULT_ERROR_RESULT_CONFIG.hardCeilingBytes,
    ),
  );
  const normalized = {} as Record<BudgetPressure, number>;
  for (const pressure of ["green", "yellow", "orange", "red"] as const) {
    normalized[pressure] = Math.max(
      ERROR_LIMIT_MINIMUM_BYTES,
      Math.min(
        hardCeilingBytes,
        positiveInteger(
          limits[pressure],
          Math.min(
            DEFAULT_ERROR_RESULT_CONFIG.limitsBytes[pressure],
            hardCeilingBytes,
          ),
        ),
      ),
    );
  }
  return Object.freeze({
    hardCeilingBytes,
    limitsBytes: Object.freeze(normalized),
  });
}

export function errorResultLimit(
  config: ErrorResultBudgetConfig,
  pressure: PressureLevel | null,
): number {
  const normalized: BudgetPressure =
    pressure === "emergency" ? "red" : (pressure ?? "green");
  return Math.min(config.hardCeilingBytes, config.limitsBytes[normalized]);
}

export function parseContextOutputConfig(value: unknown): ContextOutputConfig {
  const root = isRecord(value) ? value : {};
  const recall = isRecord(root.recall) ? root.recall : {};
  const metrics = isRecord(root.metrics) ? root.metrics : {};
  const completions = isRecord(root.completions) ? root.completions : {};
  const maximumBytes = positiveInteger(
    recall.maximumBytes,
    DEFAULT_CONTEXT_OUTPUT_CONFIG.recall.maximumBytes,
  );
  const broker = isRecord(root.broker)
    ? (root.broker as OutputBrokerConfigInput)
    : undefined;

  return Object.freeze({
    mode:
      root.mode === "off" || root.mode === "shadow" || root.mode === "enforce"
        ? root.mode
        : DEFAULT_CONTEXT_OUTPUT_CONFIG.mode,
    toolClasses: outputClassMap(root.toolClasses, DEFAULT_TOOL_CLASSES),
    prefixClasses: outputClassMap(
      root.prefixClasses,
      DEFAULT_CONTEXT_OUTPUT_CONFIG.prefixClasses,
    ),
    explicitLimitBytes: explicitLimits(root.explicitLimitBytes),
    ...(broker === undefined ? {} : { broker }),
    errors: errorResultConfig(root.errors),
    recall: Object.freeze({
      defaultBytes: Math.min(
        maximumBytes,
        positiveInteger(
          recall.defaultBytes,
          DEFAULT_CONTEXT_OUTPUT_CONFIG.recall.defaultBytes,
        ),
      ),
      maximumBytes,
      maximumLines: positiveInteger(
        recall.maximumLines,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.recall.maximumLines,
        100_000,
      ),
      maximumQueryResults: positiveInteger(
        recall.maximumQueryResults,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.recall.maximumQueryResults,
        1_000,
      ),
    }),
    metrics: Object.freeze({
      emitEvents: booleanOr(
        metrics.emitEvents,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.metrics.emitEvents,
      ),
      appendEntries: booleanOr(
        metrics.appendEntries,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.metrics.appendEntries,
      ),
      maximumEntriesPerSession: positiveInteger(
        metrics.maximumEntriesPerSession,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.metrics.maximumEntriesPerSession,
        10_000,
      ),
    }),
    completions: Object.freeze({
      enabled: booleanOr(
        completions.enabled,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.completions.enabled,
      ),
      maximumExternalReferences: positiveInteger(
        completions.maximumExternalReferences,
        DEFAULT_CONTEXT_OUTPUT_CONFIG.completions.maximumExternalReferences,
        32,
      ),
    }),
  });
}

/** Private, fail-open configuration loader. */
export function loadContextOutputConfig(path: string): ContextOutputConfig {
  try {
    return parseContextOutputConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return parseContextOutputConfig(undefined);
  }
}

export function configuredOutputClass(
  toolName: string,
  config: ContextOutputConfig,
): OutputClass | null {
  const normalized = toolName.trim().toLowerCase();
  const exact = config.toolClasses[normalized];
  if (exact !== undefined) return exact;
  for (const [prefix, outputClass] of Object.entries(config.prefixClasses)) {
    if (normalized.startsWith(prefix)) return outputClass;
  }
  return null;
}
