import type { DecayEpoch, DecayPlan } from "./types.ts";

export type AutomaticDecayPressure =
  "green" | "yellow" | "orange" | "red" | "emergency";

export interface AutomaticDecayPolicyConfig {
  readonly automaticMutationEnabled: boolean;
  /** Total projected savings required before an automatic epoch may be armed. */
  readonly automaticMinimumProjectedSavingsTokens: number;
  /** Settled agent runs required between reset/epoch boundaries. */
  readonly automaticMinimumSettledRuns: number;
  /** Wall-clock spacing required between reset/epoch boundaries. */
  readonly automaticMinimumEpochDurationMs: number;
  /** Maximum age of governor and cache-audit observations. */
  readonly automaticSignalMaximumAgeMs: number;
  /** Resident-wire target. Null disables this trigger. */
  readonly maximumWireTokens: number | null;
}

export interface AutomaticDecayIdentity {
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly modelKey: string;
  readonly contextGeneration: string;
}

export interface AutomaticGovernorSignal extends AutomaticDecayIdentity {
  readonly capturedAtMs: number;
  readonly pressure: AutomaticDecayPressure;
}

export interface AutomaticCacheAdvisorySignal extends AutomaticDecayIdentity {
  readonly capturedAtMs: number;
  readonly sequence: number;
  readonly cacheCold: boolean;
  readonly prefixChurn: boolean;
  readonly decayEpochChurn: boolean;
}

export interface AutomaticDecayPolicyState extends AutomaticDecayIdentity {
  readonly resetAtMs: number;
  readonly settledRuns: number;
  readonly lastArmedAtMs: number | null;
  readonly lastArmedSettledRun: number;
  readonly lastPressure: AutomaticDecayPressure | null;
  readonly consumedCacheSequence: number;
}

export type AutomaticDecayTrigger =
  "pressure-entry" | "wire-target-exceeded" | "cache-cold" | "cache-churn";

export type AutomaticDecayBlocker =
  | "disabled"
  | "identity-reset"
  | "invalid-plan"
  | "no-replacements"
  | "below-projected-savings-floor"
  | "settled-run-spacing"
  | "time-spacing"
  | "no-trigger"
  | "no-material-change";

export interface AutomaticDecayPolicyDecision {
  readonly arm: boolean;
  readonly triggers: readonly AutomaticDecayTrigger[];
  readonly blockers: readonly AutomaticDecayBlocker[];
  readonly governorAccepted: boolean;
  readonly cacheAdvisoryAccepted: boolean;
  readonly state: AutomaticDecayPolicyState;
}

const MAX_FUTURE_SKEW_MS = 5_000;

function frozenState(
  value: AutomaticDecayPolicyState,
): AutomaticDecayPolicyState {
  return Object.freeze({ ...value });
}

function sameIdentity(
  left: AutomaticDecayIdentity,
  right: AutomaticDecayIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.branchLeafId === right.branchLeafId &&
    left.modelKey === right.modelKey &&
    left.contextGeneration === right.contextGeneration
  );
}

function fresh(
  capturedAtMs: number,
  nowMs: number,
  maximumAgeMs: number,
): boolean {
  return (
    Number.isSafeInteger(capturedAtMs) &&
    capturedAtMs > 0 &&
    nowMs - capturedAtMs <= maximumAgeMs &&
    capturedAtMs - nowMs <= MAX_FUTURE_SKEW_MS
  );
}

function highPressure(value: AutomaticDecayPressure): boolean {
  return value === "orange" || value === "red" || value === "emergency";
}

function replacementSignature(
  epoch: DecayEpoch | null | undefined,
): string | null {
  if (epoch === null || epoch === undefined) return null;
  return JSON.stringify(
    epoch.replacementOrder.map((identity) => {
      const replacement = epoch.replacements[identity];
      return replacement === undefined
        ? [identity]
        : [identity, replacement.originalDigest, replacement.placeholder];
    }),
  );
}

export function createAutomaticDecayPolicyState(
  identity: AutomaticDecayIdentity,
  nowMs: number,
): AutomaticDecayPolicyState {
  return frozenState({
    ...identity,
    resetAtMs: Math.max(0, Math.floor(nowMs)),
    settledRuns: 0,
    lastArmedAtMs: null,
    lastArmedSettledRun: 0,
    lastPressure: null,
    consumedCacheSequence: 0,
  });
}

export function recordAutomaticDecaySettledRun(
  state: AutomaticDecayPolicyState,
): AutomaticDecayPolicyState {
  return frozenState({ ...state, settledRuns: state.settledRuns + 1 });
}

/**
 * Pure automatic-epoch policy. It only decides whether a supplied deterministic
 * plan may become the next in-memory epoch; it never mutates messages or state.
 */
export function evaluateAutomaticDecayPolicy(input: {
  readonly config: AutomaticDecayPolicyConfig;
  readonly identity: AutomaticDecayIdentity;
  readonly state: AutomaticDecayPolicyState;
  readonly plan: DecayPlan;
  readonly activeEpoch?: DecayEpoch | null;
  readonly governor?: AutomaticGovernorSignal | null;
  readonly cacheAdvisory?: AutomaticCacheAdvisorySignal | null;
  readonly nowMs: number;
}): AutomaticDecayPolicyDecision {
  const { config, identity, plan } = input;
  const nowMs = Math.max(0, Math.floor(input.nowMs));
  if (!sameIdentity(input.state, identity)) {
    return Object.freeze({
      arm: false,
      triggers: Object.freeze([]),
      blockers: Object.freeze(["identity-reset" as const]),
      governorAccepted: false,
      cacheAdvisoryAccepted: false,
      state: createAutomaticDecayPolicyState(identity, nowMs),
    });
  }

  if (!config.automaticMutationEnabled) {
    return Object.freeze({
      arm: false,
      triggers: Object.freeze([]),
      blockers: Object.freeze(["disabled" as const]),
      governorAccepted: false,
      cacheAdvisoryAccepted: false,
      state: input.state,
    });
  }

  const maximumAge = Math.max(
    1,
    Math.floor(config.automaticSignalMaximumAgeMs),
  );
  const governorAccepted =
    input.governor !== null &&
    input.governor !== undefined &&
    sameIdentity(input.governor, identity) &&
    input.governor.capturedAtMs >= input.state.resetAtMs &&
    fresh(input.governor.capturedAtMs, nowMs, maximumAge);
  const cacheAdvisoryAccepted =
    input.cacheAdvisory !== null &&
    input.cacheAdvisory !== undefined &&
    sameIdentity(input.cacheAdvisory, identity) &&
    input.cacheAdvisory.capturedAtMs >= input.state.resetAtMs &&
    fresh(input.cacheAdvisory.capturedAtMs, nowMs, maximumAge);

  const triggers: AutomaticDecayTrigger[] = [];
  const pressure = governorAccepted ? (input.governor?.pressure ?? null) : null;
  if (
    pressure !== null &&
    highPressure(pressure) &&
    pressure !== input.state.lastPressure
  ) {
    triggers.push("pressure-entry");
  }
  if (
    config.maximumWireTokens !== null &&
    plan.accounting.residentTokens > config.maximumWireTokens
  ) {
    triggers.push("wire-target-exceeded");
  }
  if (
    cacheAdvisoryAccepted &&
    (input.cacheAdvisory?.sequence ?? 0) > input.state.consumedCacheSequence
  ) {
    if (input.cacheAdvisory?.cacheCold === true) triggers.push("cache-cold");
    if (
      input.cacheAdvisory?.prefixChurn === true ||
      input.cacheAdvisory?.decayEpochChurn === true
    ) {
      triggers.push("cache-churn");
    }
  }

  const blockers: AutomaticDecayBlocker[] = [];
  if (!plan.inputValidation.valid || !plan.outputValidation.valid)
    blockers.push("invalid-plan");
  if (plan.epoch.replacementOrder.length === 0)
    blockers.push("no-replacements");
  if (
    plan.accounting.proposedTokensSaved <
    config.automaticMinimumProjectedSavingsTokens
  ) {
    blockers.push("below-projected-savings-floor");
  }
  const spacingAtMs = input.state.lastArmedAtMs ?? input.state.resetAtMs;
  const spacingAtRun =
    input.state.lastArmedAtMs === null ? 0 : input.state.lastArmedSettledRun;
  if (
    input.state.settledRuns - spacingAtRun <
    config.automaticMinimumSettledRuns
  ) {
    blockers.push("settled-run-spacing");
  }
  if (nowMs - spacingAtMs < config.automaticMinimumEpochDurationMs)
    blockers.push("time-spacing");
  if (triggers.length === 0) blockers.push("no-trigger");
  if (
    input.activeEpoch !== null &&
    input.activeEpoch !== undefined &&
    replacementSignature(input.activeEpoch) === replacementSignature(plan.epoch)
  ) {
    blockers.push("no-material-change");
  }

  const arm = blockers.length === 0;
  let nextState = input.state;
  if (arm) {
    nextState = frozenState({
      ...input.state,
      lastArmedAtMs: nowMs,
      lastArmedSettledRun: input.state.settledRuns,
      lastPressure: pressure ?? input.state.lastPressure,
      consumedCacheSequence: cacheAdvisoryAccepted
        ? Math.max(
            input.state.consumedCacheSequence,
            input.cacheAdvisory?.sequence ?? 0,
          )
        : input.state.consumedCacheSequence,
    });
  } else if (
    pressure !== null &&
    !highPressure(pressure) &&
    pressure !== input.state.lastPressure
  ) {
    // Low pressure establishes a baseline. A high-pressure observation remains
    // pending while spacing/savings gates are blocked, rather than being lost.
    nextState = frozenState({ ...input.state, lastPressure: pressure });
  }

  return Object.freeze({
    arm,
    triggers: Object.freeze(triggers),
    blockers: Object.freeze(blockers),
    governorAccepted,
    cacheAdvisoryAccepted,
    state: nextState,
  });
}

interface CacheAuditShape {
  readonly evaluatedRuns: number;
  readonly cacheObservableRuns: number;
  readonly aggregateCacheRatio: number | null;
  readonly flags: {
    readonly deepPrefixChurn: boolean;
    readonly decayEpochChurn: boolean;
    readonly lowCacheHitRate: boolean;
  };
  readonly epochTransitions: number;
  readonly additiveActivationCount: number;
  readonly recommendation: string;
  readonly recommendationText: string;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the metadata-only cache audit event before it can influence policy. */
export function isCacheAuditAdvisory(value: unknown): value is CacheAuditShape {
  if (typeof value !== "object" || value === null) return false;
  const audit = value as Partial<CacheAuditShape>;
  const flags = audit.flags;
  const recommendations = new Set([
    "observe-more",
    "none",
    "stabilize-prefix",
    "increase-decay-epoch-lifetime",
    "investigate-cache-hit-regression",
  ]);
  return (
    nonNegativeInteger(audit.evaluatedRuns) &&
    nonNegativeInteger(audit.cacheObservableRuns) &&
    audit.cacheObservableRuns <= audit.evaluatedRuns &&
    (audit.aggregateCacheRatio === null ||
      (typeof audit.aggregateCacheRatio === "number" &&
        Number.isFinite(audit.aggregateCacheRatio) &&
        audit.aggregateCacheRatio >= 0 &&
        audit.aggregateCacheRatio <= 1)) &&
    typeof flags === "object" &&
    flags !== null &&
    typeof flags.deepPrefixChurn === "boolean" &&
    typeof flags.decayEpochChurn === "boolean" &&
    typeof flags.lowCacheHitRate === "boolean" &&
    nonNegativeInteger(audit.epochTransitions) &&
    nonNegativeInteger(audit.additiveActivationCount) &&
    typeof audit.recommendation === "string" &&
    recommendations.has(audit.recommendation) &&
    typeof audit.recommendationText === "string" &&
    audit.recommendationText.length <= 10_000
  );
}

export function cacheAdvisorySignalFromAudit(
  value: unknown,
  identity: AutomaticDecayIdentity,
  sequence: number,
  capturedAtMs: number,
): AutomaticCacheAdvisorySignal | null {
  if (
    !isCacheAuditAdvisory(value) ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  )
    return null;
  return Object.freeze({
    ...identity,
    capturedAtMs: Math.max(0, Math.floor(capturedAtMs)),
    sequence,
    cacheCold: value.flags.lowCacheHitRate,
    prefixChurn: value.flags.deepPrefixChurn,
    decayEpochChurn: value.flags.decayEpochChurn,
  });
}
