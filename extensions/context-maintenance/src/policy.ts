import type {
  GovernorState,
  PressureLevel,
} from "../../shared/context-governor-state.ts";
import type {
  ContextMaintenanceConfig,
  MaintenanceChoiceId,
} from "./config.ts";

export const IGNORE_ENTRY_TYPE = "context-maintenance/ignore-once-v1";

export interface MaintenanceChoice {
  readonly id: MaintenanceChoiceId;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly recommended: boolean;
  readonly requiresNextAction: boolean;
}

export interface IgnoreOnceRecord {
  readonly version: 1;
  readonly active: boolean;
  readonly sessionId: string;
  readonly pressure: "orange" | "red" | "emergency";
  readonly createdAtMs: number;
}

export interface SettledPressureDecision {
  readonly heldPressure: PressureLevel | null;
  readonly transition:
    "entered-orange" | "entered-red" | "entered-emergency" | "recovered" | null;
  readonly automaticCheckpoint: "orange" | "red" | null;
  readonly offerMaintenance: boolean;
}

const RANK: Readonly<Record<PressureLevel, number>> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
  emergency: 4,
};

function high(
  level: PressureLevel | null,
): level is "orange" | "red" | "emergency" {
  return level === "orange" || level === "red" || level === "emergency";
}

/** Pure choice mapping. Ordering intentionally matches the Phase 5 contract. */
export function resolveMaintenanceChoices(
  pressure: PressureLevel | null,
  config: ContextMaintenanceConfig,
): readonly MaintenanceChoice[] {
  const urgent = pressure === "red" || pressure === "emergency";
  const elevated = pressure === "orange";
  return Object.freeze([
    Object.freeze({
      id: "decay" as const,
      label: "Continue with context decay",
      description:
        "Install a reversible in-memory decay epoch; durable transcript stays complete.",
      enabled: config.choices.decay,
      recommended: elevated,
      requiresNextAction: false,
    }),
    Object.freeze({
      id: "checkpoint" as const,
      label: "Create checkpoint only",
      description:
        "Persist a validated non-context checkpoint and remain in this session.",
      enabled: config.choices.checkpoint,
      recommended: elevated,
      requiresNextAction: true,
    }),
    Object.freeze({
      id: "handoff" as const,
      label: "Create a fresh handoff session",
      description:
        "Validate and seed a fresh child session; original remains browsable.",
      enabled: config.choices.handoff,
      recommended: urgent,
      requiresNextAction: true,
    }),
    Object.freeze({
      id: "compact" as const,
      label: "Run custom compaction",
      description:
        "Explicitly trigger checkpoint-shaped manual compaction with native fallback.",
      enabled: config.choices.compact,
      recommended: urgent,
      requiresNextAction: false,
    }),
    Object.freeze({
      id: "ignore-once" as const,
      label: "Ignore once",
      description:
        "Suppress this high-pressure episode until recovery or escalation.",
      enabled: config.choices["ignore-once"] && high(pressure),
      recommended: false,
      requiresNextAction: false,
    }),
  ]);
}

/**
 * Settled-only transition state. Upward pressure is immediate; downward noise
 * must persist for configured settled runs before the episode resets.
 */
export class MaintenancePressurePolicy {
  readonly #config: ContextMaintenanceConfig;
  #sessionId = "";
  #held: PressureLevel | null = null;
  #lowerRuns = 0;
  #lastCheckpointAttemptAt = Number.NEGATIVE_INFINITY;
  #checkpointAttempts = 0;
  #ignored: IgnoreOnceRecord | null = null;

  constructor(config: ContextMaintenanceConfig) {
    this.#config = config;
  }

  reset(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#held = null;
    this.#lowerRuns = 0;
    this.#lastCheckpointAttemptAt = Number.NEGATIVE_INFINITY;
    this.#checkpointAttempts = 0;
    this.#ignored = null;
  }

  restoreIgnore(record: IgnoreOnceRecord | null): void {
    this.#ignored =
      record?.active && record.sessionId === this.#sessionId ? record : null;
  }

  observeSettled(
    state: GovernorState | undefined,
    now: number,
  ): SettledPressureDecision {
    if (!state || !state.sessionId || state.sessionId !== this.#sessionId) {
      return {
        heldPressure: this.#held,
        transition: null,
        automaticCheckpoint: null,
        offerMaintenance: false,
      };
    }
    const candidate = state.pressure.level;
    const previous = this.#held;

    if (candidate === null) {
      return {
        heldPressure: this.#held,
        transition: null,
        automaticCheckpoint: null,
        offerMaintenance: false,
      };
    }
    if (this.#held === null || RANK[candidate] > RANK[this.#held]) {
      this.#held = candidate;
      this.#lowerRuns = 0;
    } else if (RANK[candidate] === RANK[this.#held]) {
      this.#lowerRuns = 0;
    } else {
      this.#lowerRuns += 1;
      if (this.#lowerRuns >= this.#config.recoverySettledRuns) {
        this.#held = candidate;
        this.#lowerRuns = 0;
      }
    }

    let transition: SettledPressureDecision["transition"] = null;
    if (this.#held !== previous) {
      const upward = previous === null || RANK[this.#held] > RANK[previous];
      if (upward && this.#held === "orange") transition = "entered-orange";
      else if (upward && this.#held === "red") transition = "entered-red";
      else if (upward && this.#held === "emergency")
        transition = "entered-emergency";
      else if (high(previous) && !high(this.#held)) transition = "recovered";
    }

    if (this.#ignored && this.#held !== this.#ignored.pressure) {
      // A sustained downgrade, full recovery, or escalation starts a new episode.
      this.#ignored = null;
    }

    const checkpointLevel =
      transition === "entered-orange"
        ? "orange"
        : transition === "entered-red"
          ? "red"
          : null;
    const automaticCheckpoint =
      checkpointLevel &&
      this.#config.automaticCheckpoint.enabled &&
      this.#config.automaticCheckpoint.levels.includes(checkpointLevel) &&
      this.#checkpointAttempts <
        this.#config.automaticCheckpoint.maximumPerSession &&
      now - this.#lastCheckpointAttemptAt >=
        this.#config.automaticCheckpoint.minimumIntervalMs
        ? checkpointLevel
        : null;

    // Count attempts before I/O so repeated settled events cannot retry a failed write.
    if (automaticCheckpoint) {
      this.#checkpointAttempts += 1;
      this.#lastCheckpointAttemptAt = now;
    }

    return {
      heldPressure: this.#held,
      transition,
      automaticCheckpoint,
      offerMaintenance: high(this.#held) && this.#ignored === null,
    };
  }

  ignoreOnce(state: GovernorState, now: number): IgnoreOnceRecord | null {
    const pressure = this.#held ?? state.pressure.level;
    if (!high(pressure) || state.sessionId !== this.#sessionId) return null;
    this.#ignored = Object.freeze({
      version: 1,
      active: true,
      sessionId: state.sessionId.slice(0, 128),
      pressure,
      createdAtMs: Math.max(0, Math.floor(now)),
    });
    return this.#ignored;
  }

  ignored(): IgnoreOnceRecord | null {
    return this.#ignored;
  }
}

export function parseIgnoreOnceRecord(value: unknown): IgnoreOnceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    typeof input.active !== "boolean" ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length > 128 ||
    !high(input.pressure as PressureLevel | null) ||
    typeof input.createdAtMs !== "number" ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  )
    return null;
  return input as unknown as IgnoreOnceRecord;
}
