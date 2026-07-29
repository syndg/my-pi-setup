import { readFileSync } from "node:fs";

export interface GovernorConfig {
  readonly advisorySafePercent: number;
  readonly historyLength: number;
  readonly ewmaAlpha: number;
  readonly conservativeQuantile: number;
  readonly minimumP95Samples: number;
  readonly minimumRunwaySamples: number;
  readonly yellowContextRatio: number;
  readonly yellowAbsoluteTokens: number;
  readonly largeRunTokens: number;
  readonly largeRunSafeFraction: number;
  readonly orangeRunwayBelow: number;
  readonly orangeSafeLimitRatio: number;
  readonly redRunwayBelow: number;
  readonly redSafeLimitRatio: number;
  readonly emergencyMarginTokens: number;
  readonly recoveryRuns: number;
  readonly notice: {
    readonly enabled: boolean;
    readonly maxCharacters: number;
  };
  readonly footer: {
    readonly enabled: boolean;
    readonly mode: "compact";
  };
  readonly telemetry: {
    readonly enabled: boolean;
    readonly maxRecords: number;
    readonly maxBytes: number;
  };
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = Object.freeze({
  advisorySafePercent: 70,
  historyLength: 20,
  ewmaAlpha: 0.35,
  conservativeQuantile: 0.95,
  minimumP95Samples: 5,
  minimumRunwaySamples: 3,
  yellowContextRatio: 0.5,
  yellowAbsoluteTokens: 150_000,
  largeRunTokens: 20_000,
  largeRunSafeFraction: 0.1,
  orangeRunwayBelow: 2,
  orangeSafeLimitRatio: 0.85,
  redRunwayBelow: 1,
  redSafeLimitRatio: 0.95,
  emergencyMarginTokens: 8_192,
  recoveryRuns: 2,
  notice: Object.freeze({ enabled: false, maxCharacters: 320 }),
  footer: Object.freeze({ enabled: true, mode: "compact" }),
  telemetry: Object.freeze({
    enabled: true,
    maxRecords: 200,
    maxBytes: 524_288,
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  minimumInclusive = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (minimumInclusive ? value < minimum : value <= minimum) ||
    value > maximum
  ) {
    return fallback;
  }
  return value;
}

function nonNegative(value: unknown, fallback: number): number {
  return finiteInRange(value, fallback, 0, Number.MAX_SAFE_INTEGER);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Parses each setting independently. A malformed private override cannot poison
 * unrelated settings or disable the governor accidentally.
 */
export function parseGovernorConfig(value: unknown): GovernorConfig {
  const root = isRecord(value) ? value : {};
  const notice = isRecord(root.notice) ? root.notice : {};
  const footer = isRecord(root.footer) ? root.footer : {};
  const telemetry = isRecord(root.telemetry) ? root.telemetry : {};

  return {
    advisorySafePercent: finiteInRange(
      root.advisorySafePercent,
      DEFAULT_GOVERNOR_CONFIG.advisorySafePercent,
      1,
      99,
    ),
    historyLength: positiveInteger(
      root.historyLength,
      DEFAULT_GOVERNOR_CONFIG.historyLength,
    ),
    ewmaAlpha: finiteInRange(
      root.ewmaAlpha,
      DEFAULT_GOVERNOR_CONFIG.ewmaAlpha,
      0,
      1,
      false,
    ),
    conservativeQuantile: finiteInRange(
      root.conservativeQuantile,
      DEFAULT_GOVERNOR_CONFIG.conservativeQuantile,
      0,
      1,
      false,
    ),
    minimumP95Samples: positiveInteger(
      root.minimumP95Samples,
      DEFAULT_GOVERNOR_CONFIG.minimumP95Samples,
    ),
    minimumRunwaySamples: positiveInteger(
      root.minimumRunwaySamples,
      DEFAULT_GOVERNOR_CONFIG.minimumRunwaySamples,
    ),
    yellowContextRatio: finiteInRange(
      root.yellowContextRatio,
      DEFAULT_GOVERNOR_CONFIG.yellowContextRatio,
      0,
      1,
    ),
    yellowAbsoluteTokens: nonNegative(
      root.yellowAbsoluteTokens,
      DEFAULT_GOVERNOR_CONFIG.yellowAbsoluteTokens,
    ),
    largeRunTokens: nonNegative(
      root.largeRunTokens,
      DEFAULT_GOVERNOR_CONFIG.largeRunTokens,
    ),
    largeRunSafeFraction: finiteInRange(
      root.largeRunSafeFraction,
      DEFAULT_GOVERNOR_CONFIG.largeRunSafeFraction,
      0,
      1,
    ),
    orangeRunwayBelow: nonNegative(
      root.orangeRunwayBelow,
      DEFAULT_GOVERNOR_CONFIG.orangeRunwayBelow,
    ),
    orangeSafeLimitRatio: finiteInRange(
      root.orangeSafeLimitRatio,
      DEFAULT_GOVERNOR_CONFIG.orangeSafeLimitRatio,
      0,
      1,
    ),
    redRunwayBelow: nonNegative(
      root.redRunwayBelow,
      DEFAULT_GOVERNOR_CONFIG.redRunwayBelow,
    ),
    redSafeLimitRatio: finiteInRange(
      root.redSafeLimitRatio,
      DEFAULT_GOVERNOR_CONFIG.redSafeLimitRatio,
      0,
      1,
    ),
    emergencyMarginTokens: nonNegative(
      root.emergencyMarginTokens,
      DEFAULT_GOVERNOR_CONFIG.emergencyMarginTokens,
    ),
    recoveryRuns: positiveInteger(
      root.recoveryRuns,
      DEFAULT_GOVERNOR_CONFIG.recoveryRuns,
    ),
    notice: {
      // Request-time pressure instructions are intentionally retired; the
      // footer and /context-status remain sufficient observability.
      enabled: false,
      maxCharacters: positiveInteger(
        notice.maxCharacters,
        DEFAULT_GOVERNOR_CONFIG.notice.maxCharacters,
      ),
    },
    footer: {
      enabled: booleanOr(
        footer.enabled,
        DEFAULT_GOVERNOR_CONFIG.footer.enabled,
      ),
      mode:
        footer.mode === "compact"
          ? footer.mode
          : DEFAULT_GOVERNOR_CONFIG.footer.mode,
    },
    telemetry: {
      enabled: booleanOr(
        telemetry.enabled,
        DEFAULT_GOVERNOR_CONFIG.telemetry.enabled,
      ),
      maxRecords: positiveInteger(
        telemetry.maxRecords,
        DEFAULT_GOVERNOR_CONFIG.telemetry.maxRecords,
      ),
      maxBytes: positiveInteger(
        telemetry.maxBytes,
        DEFAULT_GOVERNOR_CONFIG.telemetry.maxBytes,
      ),
    },
  };
}

/** Fail-open, read-only loader. The adapter owns path resolution. */
export function loadGovernorConfig(path: string): GovernorConfig {
  try {
    return parseGovernorConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return parseGovernorConfig(undefined);
  }
}
