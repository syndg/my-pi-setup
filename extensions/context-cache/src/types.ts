export type CacheMetricAvailability = "reported" | "unavailable";

export interface ProviderRunMetrics {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly cacheReadAvailability: CacheMetricAvailability;
  readonly cacheWriteAvailability: CacheMetricAvailability;
}

export interface ToolActivationObservation {
  readonly sequence: number;
  readonly source: "tool-result" | "observed-active-set" | "external";
  readonly addedToolNames: readonly string[];
}

export interface DecayEpochObservation {
  readonly sequence: number;
  readonly mode: "shadow" | "armed" | "applied";
  readonly stable: boolean;
  readonly cacheEpochId: string;
}

export interface PrefixAuditMetrics {
  readonly samples: number;
  readonly changes: number;
  readonly additiveChanges: number;
  readonly nonAdditiveChanges: number;
  readonly unexplainedChanges: number;
  readonly latestPrefixBytes: number | null;
}

export interface CacheRunRecord {
  readonly schemaVersion: 1;
  readonly timestampMs: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly boundary: "session" | "model" | "compaction" | "tree" | null;
  readonly providers: readonly ProviderRunMetrics[];
  readonly cacheRatio: number | null;
  readonly prefix: PrefixAuditMetrics;
  readonly additiveActivations: readonly ToolActivationObservation[];
  readonly decayEpochs: readonly DecayEpochObservation[];
}

export interface CacheAuditPolicy {
  readonly historyRuns: number;
  readonly minimumEpochStableRuns: number;
  readonly cacheWarmupRuns: number;
  readonly lowCacheRatio: number;
}

export interface CacheAuditEvaluation {
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
  readonly recommendation:
    | "observe-more"
    | "none"
    | "stabilize-prefix"
    | "increase-decay-epoch-lifetime"
    | "investigate-cache-hit-regression";
  readonly recommendationText: string;
}

export const DEFAULT_CACHE_AUDIT_POLICY: Readonly<CacheAuditPolicy> =
  Object.freeze({
    historyRuns: 24,
    minimumEpochStableRuns: 3,
    cacheWarmupRuns: 2,
    lowCacheRatio: 0.35,
  });
