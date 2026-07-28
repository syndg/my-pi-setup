import { readFileSync } from "node:fs";
import {
  DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
  parseContextDecayConfig,
  type ContextDecayPrivateConfig,
} from "../../context-decay/src/config.ts";
import type { PressureLevel } from "../../shared/context-governor-state.ts";

export type MaintenanceChoiceId =
  "decay" | "checkpoint" | "handoff" | "compact" | "ignore-once";

export interface ContextMaintenanceConfig {
  readonly choices: Readonly<Record<MaintenanceChoiceId, boolean>>;
  readonly automaticCheckpoint: {
    readonly enabled: boolean;
    readonly levels: readonly Extract<PressureLevel, "orange" | "red">[];
    readonly minimumIntervalMs: number;
    readonly maximumPerSession: number;
  };
  readonly recoverySettledRuns: number;
  readonly decay: ContextDecayPrivateConfig;
}

export const DEFAULT_CONTEXT_MAINTENANCE_CONFIG: ContextMaintenanceConfig =
  Object.freeze({
    choices: Object.freeze({
      decay: true,
      checkpoint: true,
      handoff: true,
      compact: true,
      "ignore-once": true,
    }),
    automaticCheckpoint: Object.freeze({
      enabled: false,
      levels: Object.freeze(["orange", "red"] as const),
      minimumIntervalMs: 15 * 60 * 1_000,
      maximumPerSession: 4,
    }),
    recoverySettledRuns: 2,
    decay: Object.freeze({
      ...DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
      allowExplicitApply: false,
      automaticMutationEnabled: false,
    }),
  });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function nonNegativeInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

export function parseContextMaintenanceConfig(
  value: unknown,
): ContextMaintenanceConfig {
  const root = record(value) ?? {};
  const choices = record(root.choices) ?? {};
  const automatic = record(root.automaticCheckpoint) ?? {};
  const levels = Array.isArray(automatic.levels)
    ? automatic.levels.filter(
        (level): level is "orange" | "red" =>
          level === "orange" || level === "red",
      )
    : [...DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint.levels];

  return Object.freeze({
    choices: Object.freeze({
      decay: typeof choices.decay === "boolean" ? choices.decay : true,
      checkpoint:
        typeof choices.checkpoint === "boolean" ? choices.checkpoint : true,
      handoff: typeof choices.handoff === "boolean" ? choices.handoff : true,
      compact: typeof choices.compact === "boolean" ? choices.compact : true,
      "ignore-once":
        typeof choices["ignore-once"] === "boolean"
          ? choices["ignore-once"]
          : true,
    }),
    automaticCheckpoint: Object.freeze({
      enabled:
        typeof automatic.enabled === "boolean" ? automatic.enabled : false,
      levels: Object.freeze([...new Set(levels)]),
      minimumIntervalMs: nonNegativeInteger(
        automatic.minimumIntervalMs,
        DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint
          .minimumIntervalMs,
        24 * 60 * 60 * 1_000,
      ),
      maximumPerSession: positiveInteger(
        automatic.maximumPerSession,
        DEFAULT_CONTEXT_MAINTENANCE_CONFIG.automaticCheckpoint
          .maximumPerSession,
        32,
      ),
    }),
    recoverySettledRuns: positiveInteger(
      root.recoverySettledRuns,
      DEFAULT_CONTEXT_MAINTENANCE_CONFIG.recoverySettledRuns,
      10,
    ),
    decay: Object.freeze({
      ...parseContextDecayConfig(root.decay),
      automaticMutationEnabled: false,
    }),
  });
}

export function loadContextMaintenanceConfig(
  path: string,
): ContextMaintenanceConfig {
  try {
    return parseContextMaintenanceConfig(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    return DEFAULT_CONTEXT_MAINTENANCE_CONFIG;
  }
}
