import type { CacheAuditEvaluation, CacheRunRecord } from "./types.ts";

function ratio(value: number | null) {
  return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function tokens(value: number | null) {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

export function formatCacheStatus(
  records: readonly CacheRunRecord[],
  evaluation: Readonly<CacheAuditEvaluation>,
  telemetryPath: string,
): string {
  const latest = records.at(-1);
  const latestProviders =
    latest?.providers.map(
      (provider) =>
        `${provider.provider}/${provider.model}: in ${tokens(provider.input)}, out ${tokens(provider.output)}, cache read ${tokens(provider.cacheRead)}, write ${tokens(provider.cacheWrite)}`,
    ) ?? [];
  return [
    "Context cache observer (metrics only; advisory)",
    `Runs: ${evaluation.evaluatedRuns}; provider-cache observable: ${evaluation.cacheObservableRuns}; aggregate hit ratio: ${ratio(evaluation.aggregateCacheRatio)}`,
    `Prefix churn: ${evaluation.flags.deepPrefixChurn ? "FLAGGED" : "stable"}; decay epoch churn: ${evaluation.flags.decayEpochChurn ? "FLAGGED" : "stable"}; additive activations: ${evaluation.additiveActivationCount}`,
    `Latest decay cache epoch: ${latest?.decayEpochs.at(-1)?.cacheEpochId ?? "none observed"}`,
    `Recommendation: ${evaluation.recommendationText}`,
    ...latestProviders.map((line) => `- ${line}`),
    `Telemetry: ${telemetryPath}`,
    "Observer never changes tools, system prompts, messages, decay, or context.",
  ].join("\n");
}
