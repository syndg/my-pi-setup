import type {
  BudgetPressure,
  OutputBudgetDecision,
  OutputClass,
  OutputRequest,
} from "./types.ts";

const KIB = 1024;

export type PressureBudgets = Readonly<Record<BudgetPressure, number>>;
export type OutputBudgets = Readonly<Record<OutputClass, PressureBudgets>>;

export interface OutputBrokerConfig {
  readonly hardCeilingBytes: number;
  readonly budgets: OutputBudgets;
}

export interface OutputBrokerConfigInput {
  readonly hardCeilingBytes?: number;
  readonly budgets?: Partial<
    Record<OutputClass, Partial<Record<BudgetPressure, number>>>
  >;
}

function frozenBudgets(
  values: Record<OutputClass, PressureBudgets>,
): OutputBudgets {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        Object.freeze({ ...value }),
      ]),
    ) as Record<OutputClass, PressureBudgets>,
  );
}

/** Phase 2 table, interpreted as binary KiB. Emergency reuses Red. */
export const DEFAULT_OUTPUT_BROKER_CONFIG: OutputBrokerConfig = Object.freeze({
  hardCeilingBytes: 64 * KIB,
  budgets: frozenBudgets({
    read: {
      green: 20 * KIB,
      yellow: 14 * KIB,
      orange: 8 * KIB,
      red: 4 * KIB,
    },
    search: {
      green: 16 * KIB,
      yellow: 10 * KIB,
      orange: 6 * KIB,
      red: 3 * KIB,
    },
    "mcp-result": {
      green: 16 * KIB,
      yellow: 10 * KIB,
      orange: 6 * KIB,
      red: 3 * KIB,
    },
    "subagent-final": {
      green: 8 * KIB,
      yellow: 6 * KIB,
      orange: 4 * KIB,
      red: 2 * KIB,
    },
    "child-live-message": {
      green: 4 * KIB,
      yellow: 3 * KIB,
      orange: 2 * KIB,
      red: 1 * KIB,
    },
    "background-completion": {
      green: 2 * KIB,
      yellow: 1 * KIB,
      orange: 1 * KIB,
      red: 0,
    },
  }),
});

function safeInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.floor(value))
    : fallback;
}

export function parseOutputBrokerConfig(
  input: OutputBrokerConfigInput = {},
): OutputBrokerConfig {
  const hardCeilingBytes = Math.max(
    1,
    safeInteger(
      input.hardCeilingBytes,
      DEFAULT_OUTPUT_BROKER_CONFIG.hardCeilingBytes,
    ),
  );
  const classes = Object.keys(
    DEFAULT_OUTPUT_BROKER_CONFIG.budgets,
  ) as OutputClass[];
  const pressures: readonly BudgetPressure[] = [
    "green",
    "yellow",
    "orange",
    "red",
  ];
  const budgets = {} as Record<OutputClass, PressureBudgets>;

  for (const outputClass of classes) {
    const defaults = DEFAULT_OUTPUT_BROKER_CONFIG.budgets[outputClass];
    const configured = input.budgets?.[outputClass];
    const row = {} as Record<BudgetPressure, number>;
    for (const pressure of pressures) {
      row[pressure] = safeInteger(
        configured?.[pressure],
        Math.min(defaults[pressure], hardCeilingBytes),
        hardCeilingBytes,
      );
    }
    budgets[outputClass] = Object.freeze(row);
  }

  return Object.freeze({
    hardCeilingBytes,
    budgets: frozenBudgets(budgets),
  });
}

export function inferOutputClass(toolName: string): OutputClass {
  const normalized = toolName.toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "read" || normalized.includes("hashline-read")) {
    return "read";
  }
  if (
    normalized === "rg" ||
    normalized === "fd" ||
    normalized.includes("search")
  ) {
    return "search";
  }
  if (normalized.includes("child") && normalized.includes("message")) {
    return "child-live-message";
  }
  if (normalized.includes("subagent") || normalized.includes("workflow")) {
    return "subagent-final";
  }
  if (normalized.includes("background") || normalized.startsWith("bg-")) {
    return "background-completion";
  }
  return "mcp-result";
}

export function resolveOutputBudget(
  request: Pick<
    OutputRequest,
    "toolName" | "outputClass" | "pressure" | "explicitLimitBytes"
  >,
  config: OutputBrokerConfig = DEFAULT_OUTPUT_BROKER_CONFIG,
): OutputBudgetDecision {
  const outputClass = request.outputClass ?? inferOutputClass(request.toolName);
  const pressure: BudgetPressure =
    request.pressure === null || request.pressure === "emergency"
      ? request.pressure === "emergency"
        ? "red"
        : "green"
      : request.pressure;
  const defaultLimitBytes = config.budgets[outputClass][pressure];
  const requested = request.explicitLimitBytes;
  const validExplicit =
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested >= 0;
  const requestedLimitBytes = validExplicit ? Math.floor(requested) : null;
  const appliedLimitBytes = validExplicit
    ? Math.min(config.hardCeilingBytes, Math.floor(requested))
    : defaultLimitBytes;

  return Object.freeze({
    outputClass,
    pressure,
    defaultLimitBytes,
    requestedLimitBytes,
    appliedLimitBytes,
    boundedByHardCeiling:
      validExplicit && Math.floor(requested) > config.hardCeilingBytes,
    usedExplicitLimit: validExplicit,
  });
}
