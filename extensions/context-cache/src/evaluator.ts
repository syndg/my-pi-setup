import {
  DEFAULT_CACHE_AUDIT_POLICY,
  type CacheAuditEvaluation,
  type CacheAuditPolicy,
  type CacheRunRecord,
} from "./types.ts";

function aggregateRatio(runs: readonly CacheRunRecord[]): {
  ratio: number | null;
  observableRuns: number;
} {
  let read = 0;
  let eligible = 0;
  let observableRuns = 0;
  for (const run of runs) {
    let runObservable = false;
    for (const provider of run.providers) {
      if (provider.cacheRead === null) continue;
      runObservable = true;
      read += provider.cacheRead;
      eligible +=
        provider.input + provider.cacheRead + (provider.cacheWrite ?? 0);
    }
    if (runObservable) observableRuns += 1;
  }
  return { ratio: eligible > 0 ? read / eligible : null, observableRuns };
}

/** Pure advisory evaluation. It performs no I/O and cannot mutate tools or context. */
export function evaluateCacheAudit(
  records: readonly CacheRunRecord[],
  policy: Readonly<CacheAuditPolicy> = DEFAULT_CACHE_AUDIT_POLICY,
): Readonly<CacheAuditEvaluation> {
  const runs = records.slice(-Math.max(1, Math.floor(policy.historyRuns)));
  const cache = aggregateRatio(runs);
  const additiveActivationCount = runs.reduce(
    (sum, run) =>
      sum +
      run.additiveActivations.reduce(
        (count, event) => count + event.addedToolNames.length,
        0,
      ),
    0,
  );
  const unexpectedPrefix = runs.some(
    (run) =>
      run.prefix.nonAdditiveChanges > 0 || run.prefix.unexplainedChanges > 0,
  );

  let previousEpoch: string | null = null;
  let previousEpochRun = -1;
  let epochTransitions = 0;
  let decayEpochChurn = false;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const boundary = runs[runIndex]?.boundary;
    if (
      boundary === "session" ||
      boundary === "model" ||
      boundary === "compaction" ||
      boundary === "tree"
    ) {
      previousEpoch = null;
      previousEpochRun = -1;
    }
    const epochs =
      runs[runIndex]?.decayEpochs
        .filter((event) => event.mode === "applied" && event.stable)
        .map((event) => event.cacheEpochId) ?? [];
    for (const epoch of epochs) {
      if (epoch === previousEpoch) continue;
      if (previousEpoch !== null) {
        epochTransitions += 1;
        if (runIndex - previousEpochRun < policy.minimumEpochStableRuns)
          decayEpochChurn = true;
      }
      previousEpoch = epoch;
      previousEpochRun = runIndex;
    }
  }

  const lowCacheHitRate =
    cache.observableRuns >= policy.cacheWarmupRuns &&
    cache.ratio !== null &&
    cache.ratio < policy.lowCacheRatio;
  const deepPrefixChurn = unexpectedPrefix || decayEpochChurn;
  let recommendation: CacheAuditEvaluation["recommendation"] = "none";
  let recommendationText =
    "Observed prefix and decay epochs are stable; no tuning is recommended.";
  if (decayEpochChurn) {
    recommendation = "increase-decay-epoch-lifetime";
    recommendationText = `Batch decay changes and keep each cache epoch stable for at least ${policy.minimumEpochStableRuns} settled runs; do not mutate context automatically.`;
  } else if (unexpectedPrefix) {
    recommendation = "stabilize-prefix";
    recommendationText =
      "Investigate non-additive tool changes or unexplained system/tool prefix changes; preserve additive activation.";
  } else if (lowCacheHitRate) {
    recommendation = "investigate-cache-hit-regression";
    recommendationText =
      "Cache reads remain low after warmup; compare provider capability, tool activation, and decay epoch boundaries.";
  } else if (cache.observableRuns < policy.cacheWarmupRuns) {
    recommendation = "observe-more";
    recommendationText =
      "Not enough provider-reported cache runs are available to recommend tuning.";
  }

  return Object.freeze({
    evaluatedRuns: runs.length,
    cacheObservableRuns: cache.observableRuns,
    aggregateCacheRatio: cache.ratio,
    flags: Object.freeze({ deepPrefixChurn, decayEpochChurn, lowCacheHitRate }),
    epochTransitions,
    additiveActivationCount,
    recommendation,
    recommendationText,
  });
}
