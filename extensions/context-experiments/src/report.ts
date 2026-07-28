import { deterministicJson } from "./canonical.ts";
import type { BenchmarkReport } from "./types.ts";

function cell(value: string | number | boolean | null) {
  if (value === null) return "n/a";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function list(values: readonly string[]) {
  return values.length === 0 ? "none" : values.join(", ");
}

function money(value: number | null) {
  return value === null ? "n/a" : value.toFixed(6);
}

/** Canonical key ordering, two-space indentation, and one trailing newline. */
export function renderBenchmarkJson(report: BenchmarkReport) {
  return deterministicJson(report);
}

/** Stable ordering follows corpus case order; no wall clock or host metadata is rendered. */
export function renderBenchmarkMarkdown(report: BenchmarkReport) {
  const lines = [
    "# Context Experiment Benchmark",
    "",
    `- Benchmark: \`${report.benchmarkId}\``,
    `- Corpus: \`${report.corpusId}\``,
    `- Strategy: \`${report.strategy.id}@${report.strategy.version}\` (${report.strategy.label})`,
    `- Fallback: ${report.fallbackStrategy === null ? "none" : `\`${report.fallbackStrategy.id}@${report.fallbackStrategy.version}\``}`,
    `- Provider calls allowed: ${report.providerCallsAllowed ? "yes" : "no"}`,
    "",
    "## Aggregate",
    "",
    "| Cases | Completed | Fallback | Failed | Structural fidelity | Continuation quality | Latency ms | Input tokens | Output tokens | Images | Image bytes | Estimated cost USD | Compatible |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.aggregate.caseCount} | ${report.aggregate.completedCaseCount} | ${report.aggregate.fallbackCaseCount} | ${report.aggregate.failedCaseCount} | ${report.aggregate.meanStructuralFidelity.toFixed(4)} | ${report.aggregate.meanContinuationQuality.toFixed(4)} | ${report.aggregate.totalLatencyMs} | ${report.aggregate.totalInputTokens} | ${report.aggregate.totalOutputTokens} | ${report.aggregate.totalImageCount} | ${report.aggregate.totalImageBytes} | ${money(report.aggregate.totalEstimatedCostUsd)} | ${report.aggregate.compatibleCaseCount} |`,
    "",
    "## Cases",
    "",
  ];

  for (const result of report.results) {
    lines.push(
      `### ${result.caseId} — ${result.title}`,
      "",
      "| Metric | Value |",
      "|---|---|",
      `| Primary / executed | ${cell(result.primaryStrategyId)} / ${cell(result.executedStrategyId)} |`,
      `| Structural fidelity | ${result.structuralFidelity.score.toFixed(4)} |`,
      `| Structural detail | facts ${result.structuralFidelity.factScore.toFixed(4)}; order ${result.structuralFidelity.messageOrderScore.toFixed(4)}; pairs ${result.structuralFidelity.toolPairScore.toFixed(4)}; artifacts ${result.structuralFidelity.artifactScore.toFixed(4)}; errors ${result.structuralFidelity.unresolvedErrorScore.toFixed(4)} |`,
      `| Missing / altered facts | ${cell(list([...result.structuralFidelity.missingFactIds, ...result.structuralFidelity.alteredFactIds]))} |`,
      `| Continuation quality | ${result.continuationQuality.score.toFixed(4)} (probes ${result.continuationQuality.probeScore.toFixed(4)}; next action ${result.continuationQuality.nextActionScore.toFixed(4)}) |`,
      `| Failed continuation probes | ${cell(list(result.continuationQuality.failedProbeIds))} |`,
      `| Latency ms | ${cell(result.latencyMs)} |`,
      `| Token/image cost input | ${result.costInput === null ? "n/a" : `input ${result.costInput.inputTokens}; output ${result.costInput.outputTokens}; cached ${result.costInput.cachedInputTokens}; images ${result.costInput.imageCount}; image bytes ${result.costInput.imageBytes}; image tokens ${cell(result.costInput.imageTokens)}; USD ${money(result.costInput.estimatedCostUsd)}`} |`,
      `| Cache behavior input | ${result.cacheInput === null ? "n/a" : `cacheable ${result.cacheInput.cacheablePrefixTokens}; read ${result.cacheInput.cacheReadTokens}; write ${result.cacheInput.cacheWriteTokens}; invalidations ${result.cacheInput.invalidations}; epoch ${cell(result.cacheInput.epochId)}`} |`,
      `| Provider compatibility | ${result.providerCompatibility.compatible ? "compatible" : "incompatible"}; ${cell(result.providerCompatibility.providerId)}/${cell(result.providerCompatibility.modelId)}; missing ${cell(list(result.providerCompatibility.missingCapabilities))}; calls blocked ${result.providerCompatibility.providerCallsBlocked}; image unsupported ${result.providerCompatibility.imageInputUnsupported} |`,
      `| Operational complexity | burden ${result.operationalComplexity.burdenPoints}; setup ${result.operationalComplexity.setupSteps}; dependencies ${result.operationalComplexity.externalDependencies}; services ${result.operationalComplexity.runtimeServices}; artifacts ${result.operationalComplexity.persistentArtifactKinds}; migration ${result.operationalComplexity.migrationRisk} |`,
      `| Failure / fallback | primary ${result.failureFallback.primaryOutcome}; final ${result.failureFallback.finalOutcome}; attempted ${result.failureFallback.fallbackAttempted}; fallback ${cell(result.failureFallback.fallbackStrategyId)}; code ${cell(result.failureFallback.failureCode)}; input preserved ${result.failureFallback.inputPreserved} |`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}
