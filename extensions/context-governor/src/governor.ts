import {
  emptyGovernorState,
  type ContextMeasurement,
  type GovernorState,
  type ModelIdentity,
  type PressureLevel,
  type ResolvedBudget,
} from "../../shared/context-governor-state.ts";
import {
  isAppliedContextWireState,
  type ContextWireState,
} from "../../shared/context-wire-state.ts";
import {
  DEFAULT_GOVERNOR_CONFIG,
  parseGovernorConfig,
  type GovernorConfig,
} from "./config.ts";

export type GovernorEvent =
  | { readonly kind: "session-start" }
  | { readonly kind: "run-start"; readonly runId: string }
  | { readonly kind: "sample" }
  | { readonly kind: "run-settled"; readonly runId: string }
  | {
      readonly kind: "compaction";
      readonly reason: "manual" | "threshold" | "overflow";
    }
  | { readonly kind: "tree-reset" }
  | { readonly kind: "model-reset" }
  | {
      readonly kind: "emergency";
      readonly reason: "provider-overflow" | "maintenance-failed";
    };

export type ComparisonResetReason =
  | "initial"
  | "session-start"
  | "session-changed"
  | "tree-reset"
  | "model-reset"
  | "model-changed"
  | "compaction";

export interface ComparisonAudit {
  readonly eventKind: GovernorEvent["kind"];
  readonly comparisonGeneration: number;
  readonly comparisonResetReason: ComparisonResetReason;
  readonly runStartBaselineTokens: number | null;
  readonly baselineSource: "run-start" | "previous-endpoint" | null;
  readonly peakTokens: number | null;
  readonly endpointTokens: number | null;
  readonly growthSampleAccepted: boolean;
}

export interface GovernorSnapshot {
  readonly capturedAtMs: number;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly model: ModelIdentity | null;
  readonly measurement: ContextMeasurement;
  readonly budget: ResolvedBudget;
  readonly event: GovernorEvent;
  readonly toolResultBytesByTool?: Readonly<Record<string, number>>;
  readonly wireAccounting?: Readonly<ContextWireState> | null;
}

export interface ContextGovernor {
  observe(snapshot: GovernorSnapshot): Readonly<GovernorState>;
  current(): Readonly<GovernorState>;
  audit(): Readonly<ComparisonAudit>;
}

export interface BudgetResolutionInput {
  readonly contextWindow: number;
  readonly nativeProactiveEnabled: boolean | null;
  readonly thresholdPercent?: number | null;
  readonly reserveTokens?: number | null;
  /** Active runtime threshold, preferred over settings-file reconstruction when present. */
  readonly resolvedNativeLimit?: {
    readonly tokens: number;
    readonly source: "percentage" | "reserve";
  } | null;
  readonly advisorySafePercent?: number;
}

/** Mirrors native threshold precedence, then applies the independent advisory cap. */
export function resolveBudget(input: BudgetResolutionInput): ResolvedBudget {
  const contextWindow = input.contextWindow;
  const validWindow =
    Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const advisoryPercent =
    typeof input.advisorySafePercent === "number" &&
    Number.isFinite(input.advisorySafePercent) &&
    input.advisorySafePercent > 0 &&
    input.advisorySafePercent <= 99
      ? input.advisorySafePercent
      : DEFAULT_GOVERNOR_CONFIG.advisorySafePercent;
  const advisoryLimitTokens =
    validWindow === null
      ? null
      : Math.floor((validWindow * advisoryPercent) / 100);

  let nativeLimitTokens: number | null = null;
  let nativeSource: ResolvedBudget["nativeSource"];

  if (input.nativeProactiveEnabled === null) {
    nativeSource = "unavailable";
  } else if (!input.nativeProactiveEnabled) {
    nativeSource = "disabled";
  } else if (validWindow === null) {
    nativeSource = "unavailable";
  } else if (
    input.resolvedNativeLimit !== null &&
    input.resolvedNativeLimit !== undefined &&
    Number.isFinite(input.resolvedNativeLimit.tokens) &&
    input.resolvedNativeLimit.tokens >= 0
  ) {
    nativeLimitTokens = input.resolvedNativeLimit.tokens;
    nativeSource =
      input.resolvedNativeLimit.source === "percentage"
        ? "threshold-percent"
        : "reserve-tokens";
  } else if (
    typeof input.thresholdPercent === "number" &&
    Number.isFinite(input.thresholdPercent) &&
    input.thresholdPercent > 0
  ) {
    const clampedPercent = Math.min(99, Math.max(1, input.thresholdPercent));
    nativeLimitTokens = Math.floor((validWindow * clampedPercent) / 100);
    nativeSource = "threshold-percent";
  } else if (
    typeof input.reserveTokens === "number" &&
    Number.isFinite(input.reserveTokens)
  ) {
    nativeLimitTokens = validWindow - input.reserveTokens;
    nativeSource = "reserve-tokens";
  } else {
    nativeSource = "unavailable";
  }

  const nativeProactiveEnabled =
    nativeSource === "unavailable" ? null : input.nativeProactiveEnabled;

  if (advisoryLimitTokens === null && nativeLimitTokens === null) {
    return {
      nativeLimitTokens,
      nativeSource,
      nativeProactiveEnabled,
      advisoryLimitTokens,
      effectiveSafeLimitTokens: null,
      effectiveSource: "unavailable",
    };
  }

  if (!input.nativeProactiveEnabled || nativeLimitTokens === null) {
    return {
      nativeLimitTokens,
      nativeSource,
      nativeProactiveEnabled,
      advisoryLimitTokens,
      effectiveSafeLimitTokens: advisoryLimitTokens,
      effectiveSource:
        advisoryLimitTokens === null ? "unavailable" : "governor-percent",
    };
  }

  if (advisoryLimitTokens === null) {
    return {
      nativeLimitTokens,
      nativeSource,
      nativeProactiveEnabled,
      advisoryLimitTokens,
      effectiveSafeLimitTokens: nativeLimitTokens,
      effectiveSource: "native-limit",
    };
  }

  return {
    nativeLimitTokens,
    nativeSource,
    nativeProactiveEnabled,
    advisoryLimitTokens,
    effectiveSafeLimitTokens: Math.min(advisoryLimitTokens, nativeLimitTokens),
    effectiveSource: "minimum-of-governor-and-native",
  };
}

interface ActiveRun {
  readonly runId: string;
  readonly epoch: number;
  readonly baselineTokens: number | null;
  peakTokens: number | null;
  readonly baselineSource: "run-start" | "previous-endpoint" | null;
}

interface RunSettlement {
  readonly runStartBaselineTokens: number | null;
  readonly baselineSource: ActiveRun["baselineSource"];
  readonly peakTokens: number | null;
  readonly endpointTokens: number | null;
  readonly accepted: boolean;
}

interface PressureCandidate {
  readonly level: PressureLevel | null;
  readonly reasons: readonly string[];
}

function modelEquals(
  left: ModelIdentity | null,
  right: ModelIdentity | null,
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.id === right?.id &&
    left?.contextWindow === right?.contextWindow
  );
}

function pressureRank(level: PressureLevel): number {
  switch (level) {
    case "green":
      return 0;
    case "yellow":
      return 1;
    case "orange":
      return 2;
    case "red":
      return 3;
    case "emergency":
      return 4;
  }
}

function knownTokens(measurement: ContextMeasurement): number | null {
  return measurement.source !== "unknown" &&
    typeof measurement.tokens === "number" &&
    Number.isFinite(measurement.tokens) &&
    measurement.tokens >= 0
    ? measurement.tokens
    : null;
}

function trustworthyComparisonTokens(
  measurement: ContextMeasurement,
): number | null {
  const tokens = knownTokens(measurement);
  return tokens !== null && tokens > 0 ? tokens : null;
}

function copyModel(model: ModelIdentity | null): ModelIdentity | null {
  return model === null
    ? null
    : Object.freeze({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
      });
}

function normalizeMeasurement(
  snapshot: GovernorSnapshot,
  forcedUnknownReason?: "post-compaction" | "model-changed",
): ContextMeasurement {
  const model = snapshot.model;
  if (model === null) {
    return Object.freeze({
      tokens: null,
      contextWindow: 0,
      percent: null,
      source: "unknown",
      unknownReason: "no-model",
    });
  }

  if (
    forcedUnknownReason !== undefined ||
    snapshot.measurement.contextWindow !== model.contextWindow
  ) {
    return Object.freeze({
      tokens: null,
      contextWindow: model.contextWindow,
      percent: null,
      source: "unknown",
      unknownReason: forcedUnknownReason ?? "model-changed",
    });
  }

  const tokens = knownTokens(snapshot.measurement);
  if (tokens === null || model.contextWindow <= 0) {
    return Object.freeze({
      tokens: null,
      contextWindow: model.contextWindow,
      percent: null,
      source: "unknown",
      unknownReason: snapshot.measurement.unknownReason ?? "usage-unavailable",
    });
  }

  return Object.freeze({
    tokens,
    contextWindow: model.contextWindow,
    percent: (tokens / model.contextWindow) * 100,
    source: snapshot.measurement.source,
  });
}

function copyBudget(budget: ResolvedBudget): ResolvedBudget {
  return Object.freeze({
    nativeLimitTokens: budget.nativeLimitTokens,
    nativeSource: budget.nativeSource,
    nativeProactiveEnabled: budget.nativeProactiveEnabled,
    advisoryLimitTokens: budget.advisoryLimitTokens,
    effectiveSafeLimitTokens: budget.effectiveSafeLimitTokens,
    effectiveSource: budget.effectiveSource,
  });
}

function copyToolBytes(
  value: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  if (value === undefined) return Object.freeze({});
  const entries = Object.entries(value)
    .filter((entry) => Number.isFinite(entry[1]) && entry[1] >= 0)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return Object.freeze(Object.fromEntries(entries));
}

function nearestRank(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function finiteResult(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

class InProcessContextGovernor implements ContextGovernor {
  readonly #config: GovernorConfig;
  #state: Readonly<GovernorState>;
  #epoch = 0;
  #audit: Readonly<ComparisonAudit> = Object.freeze({
    eventKind: "session-start",
    comparisonGeneration: 0,
    comparisonResetReason: "initial",
    runStartBaselineTokens: null,
    baselineSource: null,
    peakTokens: null,
    endpointTokens: null,
    growthSampleAccepted: false,
  });
  #activeRun: ActiveRun | null = null;
  #history: number[] = [];
  #ewmaTokens: number | null = null;
  #comparisonBaselineTokens: number | null = null;
  #comparisonResetReason: ComparisonResetReason = "initial";
  #latestTokens: number | null = null;
  #heldPressure: PressureLevel | null = null;
  #heldReasons: readonly string[] = [];
  #lowerSettledRuns = 0;
  #emergencyReason: "provider-overflow" | "maintenance-failed" | null = null;
  #toolResultBytesByTool: Readonly<Record<string, number>> = Object.freeze({});

  constructor(config: GovernorConfig) {
    this.#config = parseGovernorConfig(config);
    this.#state = freezeState({
      ...emptyGovernorState(),
      footerEnabled: this.#config.footer.enabled,
    });
  }

  current(): Readonly<GovernorState> {
    return this.#state;
  }

  audit(): Readonly<ComparisonAudit> {
    return this.#audit;
  }

  observe(snapshot: GovernorSnapshot): Readonly<GovernorState> {
    const wasInitialized = this.#state.sessionId !== "";
    const sessionChanged =
      wasInitialized && snapshot.sessionId !== this.#state.sessionId;
    const modelChanged =
      wasInitialized && !modelEquals(snapshot.model, this.#state.model);
    const hardResetReason: ComparisonResetReason | null =
      snapshot.event.kind === "session-start"
        ? "session-start"
        : snapshot.event.kind === "tree-reset"
          ? "tree-reset"
          : snapshot.event.kind === "model-reset"
            ? "model-reset"
            : sessionChanged
              ? "session-changed"
              : modelChanged
                ? "model-changed"
                : null;

    if (hardResetReason !== null) this.#hardReset(hardResetReason);

    let forcedUnknownReason: "post-compaction" | "model-changed" | undefined;
    const staleModelTransition =
      modelChanged &&
      !sessionChanged &&
      snapshot.event.kind !== "session-start";
    if (snapshot.event.kind === "model-reset" || staleModelTransition) {
      forcedUnknownReason = "model-changed";
    } else if (
      snapshot.event.kind === "compaction" &&
      snapshot.measurement.source !== "message-estimate"
    ) {
      forcedUnknownReason = "post-compaction";
    }

    const measurement = normalizeMeasurement(snapshot, forcedUnknownReason);

    let acceptedSettlement = false;
    let runStartBaselineTokens: number | null = null;
    let baselineSource: ActiveRun["baselineSource"] = null;
    let peakTokens: number | null = null;
    let endpointTokens: number | null = null;
    let growthSampleAccepted = false;
    switch (snapshot.event.kind) {
      case "run-start":
        if (this.#activeRun === null) {
          const observedBaseline = trustworthyComparisonTokens(measurement);
          runStartBaselineTokens =
            observedBaseline ?? this.#comparisonBaselineTokens;
          baselineSource =
            observedBaseline !== null
              ? "run-start"
              : this.#comparisonBaselineTokens !== null
                ? "previous-endpoint"
                : null;
          this.#activeRun = {
            runId: snapshot.event.runId,
            epoch: this.#epoch,
            baselineTokens: runStartBaselineTokens,
            baselineSource,
            peakTokens: null,
          };
        } else {
          this.#capturePeak(measurement);
          runStartBaselineTokens = this.#activeRun.baselineTokens;
          baselineSource = this.#activeRun.baselineSource;
          peakTokens = this.#activeRun.peakTokens;
        }
        break;
      case "run-settled":
        endpointTokens = knownTokens(measurement);
        if (this.#activeRun?.runId === snapshot.event.runId) {
          this.#capturePeak(measurement);
          const settlement = this.#finalizeRun(measurement);
          runStartBaselineTokens = settlement.runStartBaselineTokens;
          baselineSource = settlement.baselineSource;
          peakTokens = settlement.peakTokens;
          endpointTokens = settlement.endpointTokens;
          growthSampleAccepted = settlement.accepted;
          acceptedSettlement = true;
        }
        this.#toolResultBytesByTool = copyToolBytes(
          snapshot.toolResultBytesByTool,
        );
        break;
      case "compaction":
        endpointTokens = knownTokens(measurement);
        this.#compactionReset(measurement);
        break;
      case "emergency":
        this.#capturePeak(measurement);
        peakTokens = this.#activeRun?.peakTokens ?? null;
        this.#emergencyReason = snapshot.event.reason;
        break;
      case "sample":
        this.#capturePeak(measurement);
        runStartBaselineTokens = this.#activeRun?.baselineTokens ?? null;
        baselineSource = this.#activeRun?.baselineSource ?? null;
        peakTokens = this.#activeRun?.peakTokens ?? null;
        break;
      case "session-start":
      case "tree-reset":
      case "model-reset":
        break;
    }

    this.#audit = Object.freeze({
      eventKind: snapshot.event.kind,
      comparisonGeneration: this.#epoch,
      comparisonResetReason: this.#comparisonResetReason,
      runStartBaselineTokens,
      baselineSource,
      peakTokens,
      endpointTokens,
      growthSampleAccepted,
    });

    const budget = copyBudget(snapshot.budget);
    const residentTokens = knownTokens(measurement);
    const wireAccounting = snapshot.wireAccounting ?? null;
    const useWire = isAppliedContextWireState(wireAccounting);
    const tokens = useWire
      ? wireAccounting.effectiveWireTokens
      : residentTokens;
    const pressureTokenSource = useWire
      ? ("effective-wire" as const)
      : ("resident" as const);
    const safeLimit =
      typeof budget.effectiveSafeLimitTokens === "number" &&
      Number.isFinite(budget.effectiveSafeLimitTokens)
        ? budget.effectiveSafeLimitTokens
        : null;
    const headroomTokens =
      tokens === null || safeLimit === null
        ? null
        : finiteResult(safeLimit - tokens);
    const safeLimitRatio =
      tokens === null || safeLimit === null || safeLimit <= 0
        ? null
        : finiteResult(tokens / safeLimit);
    const p95Tokens =
      this.#history.length >= this.#config.minimumP95Samples
        ? nearestRank(this.#history, this.#config.conservativeQuantile)
        : null;
    const conservativeTokens = this.#conservativeGrowth(p95Tokens);
    const runwayRuns =
      headroomTokens === null ||
      conservativeTokens === null ||
      conservativeTokens <= 0
        ? null
        : finiteResult(headroomTokens / conservativeTokens);
    const candidate = this.#pressureCandidate({
      measurement,
      tokens,
      safeLimit,
      headroomTokens,
      safeLimitRatio,
      runwayRuns,
    });
    const pressure = this.#applyPressure(candidate, acceptedSettlement);

    this.#state = freezeState({
      capturedAtMs: snapshot.capturedAtMs,
      sessionId: snapshot.sessionId,
      branchLeafId: snapshot.branchLeafId,
      model: copyModel(snapshot.model),
      measurement,
      budget,
      headroomTokens,
      safeLimitRatio,
      growth: {
        latestTokens: this.#latestTokens,
        ewmaTokens: this.#ewmaTokens,
        p95Tokens,
        conservativeTokens,
        sampleCount: this.#history.length,
      },
      runwayRuns,
      pressure,
      footerEnabled: this.#config.footer.enabled,
      pressureTokens: tokens,
      pressureTokenSource,
      wireAccounting,
      toolResultBytesByTool: this.#toolResultBytesByTool,
    });
    return this.#state;
  }

  #hardReset(reason: ComparisonResetReason): void {
    this.#epoch += 1;
    this.#comparisonResetReason = reason;
    this.#activeRun = null;
    this.#history = [];
    this.#ewmaTokens = null;
    this.#comparisonBaselineTokens = null;
    this.#latestTokens = null;
    this.#heldPressure = null;
    this.#heldReasons = [];
    this.#lowerSettledRuns = 0;
    this.#emergencyReason = null;
    this.#toolResultBytesByTool = Object.freeze({});
  }

  #compactionReset(measurement: ContextMeasurement): void {
    this.#epoch += 1;
    this.#comparisonResetReason = "compaction";
    this.#activeRun = null;
    this.#history = [];
    this.#ewmaTokens = null;
    this.#latestTokens = null;
    this.#comparisonBaselineTokens = trustworthyComparisonTokens(measurement);
    this.#heldPressure = null;
    this.#heldReasons = [];
    this.#lowerSettledRuns = 0;
    this.#emergencyReason = null;
  }

  #capturePeak(measurement: ContextMeasurement): void {
    const activeRun = this.#activeRun;
    const tokens = knownTokens(measurement);
    if (
      activeRun === null ||
      activeRun.epoch !== this.#epoch ||
      tokens === null
    ) {
      return;
    }
    activeRun.peakTokens =
      activeRun.peakTokens === null
        ? tokens
        : Math.max(activeRun.peakTokens, tokens);
  }

  #finalizeRun(measurement: ContextMeasurement): RunSettlement {
    const activeRun = this.#activeRun;
    this.#activeRun = null;
    const endpointTokens = knownTokens(measurement);
    const settlement = {
      runStartBaselineTokens: activeRun?.baselineTokens ?? null,
      baselineSource: activeRun?.baselineSource ?? null,
      peakTokens: activeRun?.peakTokens ?? null,
      endpointTokens,
      accepted: false,
    } satisfies RunSettlement;
    this.#comparisonBaselineTokens = trustworthyComparisonTokens(measurement);
    this.#latestTokens = null;
    if (
      activeRun === null ||
      activeRun.epoch !== this.#epoch ||
      activeRun.baselineTokens === null ||
      activeRun.peakTokens === null
    ) {
      return settlement;
    }

    const growth = activeRun.peakTokens - activeRun.baselineTokens;
    if (!Number.isFinite(growth) || growth < 0) return settlement;

    this.#latestTokens = growth;
    this.#ewmaTokens =
      this.#ewmaTokens === null
        ? growth
        : this.#config.ewmaAlpha * growth +
          (1 - this.#config.ewmaAlpha) * this.#ewmaTokens;
    this.#history.push(growth);
    if (this.#history.length > this.#config.historyLength) {
      this.#history.splice(
        0,
        this.#history.length - this.#config.historyLength,
      );
    }
    return { ...settlement, accepted: true };
  }

  #conservativeGrowth(p95Tokens: number | null): number | null {
    const values = [this.#latestTokens, this.#ewmaTokens, p95Tokens].filter(
      (value): value is number => value !== null,
    );
    return values.length === 0 ? null : Math.max(...values);
  }

  #pressureCandidate(input: {
    readonly measurement: ContextMeasurement;
    readonly tokens: number | null;
    readonly safeLimit: number | null;
    readonly headroomTokens: number | null;
    readonly safeLimitRatio: number | null;
    readonly runwayRuns: number | null;
  }): PressureCandidate {
    if (this.#emergencyReason !== null) {
      return {
        level: "emergency",
        reasons: [
          this.#emergencyReason === "provider-overflow"
            ? "provider overflow"
            : "proactive maintenance failed",
        ],
      };
    }
    if (input.tokens === null || input.measurement.source === "unknown") {
      return { level: null, reasons: [] };
    }

    const redReasons: string[] = [];
    if (input.headroomTokens !== null && input.headroomTokens <= 0) {
      redReasons.push("safe-limit headroom exhausted");
    }
    if (
      input.headroomTokens !== null &&
      input.headroomTokens <= this.#config.emergencyMarginTokens
    ) {
      redReasons.push("headroom within emergency margin");
    }
    if (
      this.#history.length >= this.#config.minimumRunwaySamples &&
      input.runwayRuns !== null &&
      input.runwayRuns < this.#config.redRunwayBelow
    ) {
      redReasons.push("runway below red threshold");
    }
    if (
      input.safeLimitRatio !== null &&
      input.safeLimitRatio >= this.#config.redSafeLimitRatio
    ) {
      redReasons.push("safe-limit ratio at red threshold");
    }
    if (redReasons.length > 0) return { level: "red", reasons: redReasons };

    const orangeReasons: string[] = [];
    if (
      this.#history.length >= this.#config.minimumRunwaySamples &&
      input.runwayRuns !== null &&
      input.runwayRuns < this.#config.orangeRunwayBelow
    ) {
      orangeReasons.push("runway below orange threshold");
    }
    if (
      input.safeLimitRatio !== null &&
      input.safeLimitRatio >= this.#config.orangeSafeLimitRatio
    ) {
      orangeReasons.push("safe-limit ratio at orange threshold");
    }
    if (orangeReasons.length > 0) {
      return { level: "orange", reasons: orangeReasons };
    }

    const yellowReasons: string[] = [];
    const contextRatio =
      input.measurement.contextWindow > 0
        ? input.tokens / input.measurement.contextWindow
        : null;
    if (
      contextRatio !== null &&
      contextRatio >= this.#config.yellowContextRatio
    ) {
      yellowReasons.push("context-window ratio at yellow threshold");
    }
    if (input.tokens >= this.#config.yellowAbsoluteTokens) {
      yellowReasons.push("absolute token usage at yellow threshold");
    }
    if (this.#latestTokens !== null && input.safeLimit !== null) {
      const largeRunThreshold = Math.min(
        this.#config.largeRunTokens,
        input.safeLimit * this.#config.largeRunSafeFraction,
      );
      if (this.#latestTokens >= largeRunThreshold) {
        yellowReasons.push("latest run growth is large");
      }
    }
    return yellowReasons.length > 0
      ? { level: "yellow", reasons: yellowReasons }
      : { level: "green", reasons: [] };
  }

  #applyPressure(
    candidate: PressureCandidate,
    acceptedSettlement: boolean,
  ): {
    readonly level: PressureLevel | null;
    readonly reasons: readonly string[];
  } {
    if (candidate.level === null) {
      return Object.freeze({ level: null, reasons: Object.freeze([]) });
    }
    if (this.#heldPressure === null) {
      this.#heldPressure = candidate.level;
      this.#heldReasons = candidate.reasons;
      this.#lowerSettledRuns = 0;
    } else {
      const candidateRank = pressureRank(candidate.level);
      const heldRank = pressureRank(this.#heldPressure);
      if (candidateRank > heldRank) {
        this.#heldPressure = candidate.level;
        this.#heldReasons = candidate.reasons;
        this.#lowerSettledRuns = 0;
      } else if (candidateRank === heldRank) {
        this.#heldReasons = candidate.reasons;
        this.#lowerSettledRuns = 0;
      } else if (acceptedSettlement) {
        this.#lowerSettledRuns += 1;
        if (this.#lowerSettledRuns >= this.#config.recoveryRuns) {
          this.#heldPressure = candidate.level;
          this.#heldReasons = candidate.reasons;
          this.#lowerSettledRuns = 0;
        }
      }
    }

    const reasons = [...this.#heldReasons];
    if (this.#lowerSettledRuns > 0) {
      reasons.push(
        `pressure recovery pending ${this.#lowerSettledRuns}/${this.#config.recoveryRuns}`,
      );
    }
    return Object.freeze({
      level: this.#heldPressure,
      reasons: Object.freeze(reasons),
    });
  }
}

function freezeState(state: GovernorState): Readonly<GovernorState> {
  const growth = Object.freeze({ ...state.growth });
  const pressure = Object.freeze({
    level: state.pressure.level,
    reasons: Object.freeze([...state.pressure.reasons]),
  });
  return Object.freeze({
    ...state,
    model: copyModel(state.model),
    measurement: Object.freeze({ ...state.measurement }),
    budget: Object.freeze({ ...state.budget }),
    growth,
    pressure,
    wireAccounting:
      state.wireAccounting === null
        ? null
        : Object.freeze({ ...state.wireAccounting }),
    toolResultBytesByTool: copyToolBytes(state.toolResultBytesByTool),
  });
}

export function createContextGovernor(
  config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
): ContextGovernor {
  return new InProcessContextGovernor(config);
}
