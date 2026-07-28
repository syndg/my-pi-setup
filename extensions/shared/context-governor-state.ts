import {
  isContextWireState,
  type ContextWireState,
} from "./context-wire-state.ts";

export const CONTEXT_GOVERNOR_CHANNEL = "dashboard:context-governor";
export const CONTEXT_GOVERNOR_REFRESH_CHANNEL = "dashboard:refresh";

export type PressureLevel = "green" | "yellow" | "orange" | "red" | "emergency";

export type MeasurementSource = "pi-usage" | "message-estimate" | "unknown";

export type MeasurementUnknownReason =
  "post-compaction" | "model-changed" | "no-model" | "usage-unavailable";

export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

export interface ContextMeasurement {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly source: MeasurementSource;
  readonly unknownReason?: MeasurementUnknownReason;
}

export type NativeLimitSource =
  "threshold-percent" | "reserve-tokens" | "disabled" | "unavailable";

export type EffectiveLimitSource =
  | "governor-percent"
  | "native-limit"
  | "minimum-of-governor-and-native"
  | "unavailable";

export interface ResolvedBudget {
  readonly nativeLimitTokens: number | null;
  readonly nativeSource: NativeLimitSource;
  readonly nativeProactiveEnabled: boolean | null;
  readonly advisoryLimitTokens: number | null;
  readonly effectiveSafeLimitTokens: number | null;
  readonly effectiveSource: EffectiveLimitSource;
}

export interface GrowthState {
  readonly latestTokens: number | null;
  readonly ewmaTokens: number | null;
  readonly p95Tokens: number | null;
  readonly conservativeTokens: number | null;
  readonly sampleCount: number;
}

export interface PressureState {
  readonly level: PressureLevel | null;
  readonly reasons: readonly string[];
}

export interface GovernorState {
  readonly capturedAtMs: number;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly model: ModelIdentity | null;
  readonly measurement: ContextMeasurement;
  readonly budget: ResolvedBudget;
  readonly headroomTokens: number | null;
  readonly safeLimitRatio: number | null;
  readonly growth: GrowthState;
  readonly runwayRuns: number | null;
  readonly pressure: PressureState;
  readonly footerEnabled: boolean;
  /** Token basis used for headroom and pressure; wire only for a current stable applied epoch. */
  readonly pressureTokens: number | null;
  readonly pressureTokenSource: "resident" | "effective-wire";
  readonly wireAccounting: Readonly<ContextWireState> | null;
  readonly toolResultBytesByTool: Readonly<Record<string, number>>;
}

export function emptyGovernorState(): GovernorState {
  return {
    capturedAtMs: 0,
    sessionId: "",
    branchLeafId: null,
    model: null,
    measurement: {
      tokens: null,
      contextWindow: 0,
      percent: null,
      source: "unknown",
      unknownReason: "no-model",
    },
    budget: {
      nativeLimitTokens: null,
      nativeSource: "unavailable",
      nativeProactiveEnabled: null,
      advisoryLimitTokens: null,
      effectiveSafeLimitTokens: null,
      effectiveSource: "unavailable",
    },
    headroomTokens: null,
    safeLimitRatio: null,
    growth: {
      latestTokens: null,
      ewmaTokens: null,
      p95Tokens: null,
      conservativeTokens: null,
      sampleCount: 0,
    },
    runwayRuns: null,
    pressure: { level: null, reasons: [] },
    footerEnabled: true,
    pressureTokens: null,
    pressureTokenSource: "resident",
    wireAccounting: null,
    toolResultBytesByTool: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function isPressureLevel(value: unknown): value is PressureLevel {
  return (
    value === "green" ||
    value === "yellow" ||
    value === "orange" ||
    value === "red" ||
    value === "emergency"
  );
}

function isUnknownReason(value: unknown): value is MeasurementUnknownReason {
  return (
    value === "post-compaction" ||
    value === "model-changed" ||
    value === "no-model" ||
    value === "usage-unavailable"
  );
}

function isModelIdentity(value: unknown): value is ModelIdentity {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.id === "string" &&
    isFiniteNumber(value.contextWindow) &&
    value.contextWindow > 0
  );
}

function isMeasurement(value: unknown): value is ContextMeasurement {
  if (!isRecord(value) || !isNonNegativeNumber(value.contextWindow)) {
    return false;
  }
  if (value.source === "unknown") {
    return (
      value.tokens === null &&
      value.percent === null &&
      isUnknownReason(value.unknownReason)
    );
  }
  return (
    (value.source === "pi-usage" || value.source === "message-estimate") &&
    isNonNegativeNumber(value.tokens) &&
    isNonNegativeNumber(value.percent) &&
    value.unknownReason === undefined
  );
}

function isBudget(value: unknown): value is ResolvedBudget {
  if (
    !isRecord(value) ||
    !isNullableFiniteNumber(value.nativeLimitTokens) ||
    !isNullableNonNegativeNumber(value.advisoryLimitTokens) ||
    !isNullableFiniteNumber(value.effectiveSafeLimitTokens) ||
    (value.effectiveSource !== "governor-percent" &&
      value.effectiveSource !== "native-limit" &&
      value.effectiveSource !== "minimum-of-governor-and-native" &&
      value.effectiveSource !== "unavailable")
  ) {
    return false;
  }
  if (value.nativeSource === "unavailable") {
    return (
      value.nativeProactiveEnabled === null && value.nativeLimitTokens === null
    );
  }
  if (value.nativeSource === "disabled") {
    return (
      value.nativeProactiveEnabled === false && value.nativeLimitTokens === null
    );
  }
  return (
    (value.nativeSource === "threshold-percent" ||
      value.nativeSource === "reserve-tokens") &&
    value.nativeProactiveEnabled === true &&
    isFiniteNumber(value.nativeLimitTokens)
  );
}

function isGrowth(value: unknown): value is GrowthState {
  return (
    isRecord(value) &&
    isNullableNonNegativeNumber(value.latestTokens) &&
    isNullableNonNegativeNumber(value.ewmaTokens) &&
    isNullableNonNegativeNumber(value.p95Tokens) &&
    isNullableNonNegativeNumber(value.conservativeTokens) &&
    isNonNegativeSafeInteger(value.sampleCount)
  );
}

function isPressure(value: unknown): value is PressureState {
  return (
    isRecord(value) &&
    (value.level === null || isPressureLevel(value.level)) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string")
  );
}

function isToolBytes(
  value: unknown,
): value is Readonly<Record<string, number>> {
  return (
    isRecord(value) &&
    Object.values(value).every((bytes) => isNonNegativeSafeInteger(bytes))
  );
}

export function isGovernorState(value: unknown): value is GovernorState {
  return (
    isRecord(value) &&
    isNonNegativeSafeInteger(value.capturedAtMs) &&
    typeof value.sessionId === "string" &&
    (value.branchLeafId === null || typeof value.branchLeafId === "string") &&
    (value.model === null || isModelIdentity(value.model)) &&
    isMeasurement(value.measurement) &&
    isBudget(value.budget) &&
    isNullableFiniteNumber(value.headroomTokens) &&
    isNullableNonNegativeNumber(value.safeLimitRatio) &&
    isGrowth(value.growth) &&
    isNullableFiniteNumber(value.runwayRuns) &&
    isPressure(value.pressure) &&
    typeof value.footerEnabled === "boolean" &&
    isNullableNonNegativeNumber(value.pressureTokens) &&
    (value.pressureTokenSource === "resident" ||
      value.pressureTokenSource === "effective-wire") &&
    (value.wireAccounting === null ||
      isContextWireState(value.wireAccounting)) &&
    isToolBytes(value.toolResultBytesByTool)
  );
}
