import { readFileSync } from "node:fs";
import type { DedicatedSummaryModelConfig } from "./model-adapter.ts";
import type { RetainedBoundaryConfig } from "./types.ts";

export interface ContextCompactionConfig {
  readonly manual: { readonly custom: boolean };
  readonly threshold: {
    readonly custom: boolean;
    readonly observationOptIn: boolean;
  };
  readonly overflow: { readonly experimentalCustom: boolean };
  readonly summaryModel: DedicatedSummaryModelConfig;
  readonly verifier: {
    readonly enabled: boolean;
    readonly maxOutputTokens: number;
  };
  readonly retainedBoundary: RetainedBoundaryConfig;
  readonly maxOutputTokens: number;
  readonly metrics: {
    readonly emitEvents: boolean;
    readonly appendEntries: boolean;
    readonly maximumEntriesPerSession: number;
  };
}

export const DEFAULT_CONTEXT_COMPACTION_CONFIG: ContextCompactionConfig =
  Object.freeze({
    manual: Object.freeze({ custom: false }),
    threshold: Object.freeze({ custom: false, observationOptIn: false }),
    overflow: Object.freeze({ experimentalCustom: false }),
    summaryModel: Object.freeze({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "medium",
      timeoutMs: 60_000,
    }),
    verifier: Object.freeze({ enabled: false, maxOutputTokens: 1_024 }),
    retainedBoundary: Object.freeze({
      minimumTokens: 8_000,
      targetTokens: 10_000,
      maximumTokens: 12_000,
    }),
    maxOutputTokens: 16_384,
    metrics: Object.freeze({
      emitEvents: true,
      appendEntries: true,
      maximumEntriesPerSession: 64,
    }),
  });

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

const REASONING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function parseContextCompactionConfig(
  value: unknown,
): ContextCompactionConfig {
  const root = record(value);
  const manual = record(root.manual);
  const threshold = record(root.threshold);
  const overflow = record(root.overflow);
  const model = record(root.summaryModel);
  const verifier = record(root.verifier);
  const boundary = record(root.retainedBoundary);
  const metrics = record(root.metrics);

  const minimumTokens = positiveInteger(
    boundary.minimumTokens,
    DEFAULT_CONTEXT_COMPACTION_CONFIG.retainedBoundary.minimumTokens,
    1_000_000,
  );
  const targetTokens = positiveInteger(
    boundary.targetTokens,
    DEFAULT_CONTEXT_COMPACTION_CONFIG.retainedBoundary.targetTokens,
    1_000_000,
  );
  const maximumTokens = positiveInteger(
    boundary.maximumTokens,
    DEFAULT_CONTEXT_COMPACTION_CONFIG.retainedBoundary.maximumTokens,
    1_000_000,
  );
  const orderedBoundary =
    minimumTokens <= targetTokens && targetTokens <= maximumTokens
      ? { minimumTokens, targetTokens, maximumTokens }
      : DEFAULT_CONTEXT_COMPACTION_CONFIG.retainedBoundary;

  const provider =
    typeof model.provider === "string" && model.provider.trim()
      ? model.provider.trim()
      : DEFAULT_CONTEXT_COMPACTION_CONFIG.summaryModel.provider;
  const modelId =
    typeof model.model === "string" && model.model.trim()
      ? model.model.trim()
      : DEFAULT_CONTEXT_COMPACTION_CONFIG.summaryModel.model;
  const reasoning =
    typeof model.reasoning === "string" && REASONING.has(model.reasoning)
      ? (model.reasoning as DedicatedSummaryModelConfig["reasoning"])
      : DEFAULT_CONTEXT_COMPACTION_CONFIG.summaryModel.reasoning;

  return Object.freeze({
    manual: Object.freeze({
      custom: boolean(
        manual.custom,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.manual.custom,
      ),
    }),
    threshold: Object.freeze({
      custom: boolean(
        threshold.custom,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.threshold.custom,
      ),
      observationOptIn: boolean(
        threshold.observationOptIn,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.threshold.observationOptIn,
      ),
    }),
    overflow: Object.freeze({
      experimentalCustom: boolean(
        overflow.experimentalCustom,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.overflow.experimentalCustom,
      ),
    }),
    summaryModel: Object.freeze({
      provider,
      model: modelId,
      reasoning,
      timeoutMs: positiveInteger(
        model.timeoutMs,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.summaryModel.timeoutMs ?? 60_000,
        10 * 60_000,
      ),
    }),
    verifier: Object.freeze({
      enabled: boolean(
        verifier.enabled,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.verifier.enabled,
      ),
      maxOutputTokens: positiveInteger(
        verifier.maxOutputTokens,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.verifier.maxOutputTokens,
        16_384,
      ),
    }),
    retainedBoundary: Object.freeze(orderedBoundary),
    maxOutputTokens: positiveInteger(
      root.maxOutputTokens,
      DEFAULT_CONTEXT_COMPACTION_CONFIG.maxOutputTokens,
      65_536,
    ),
    metrics: Object.freeze({
      emitEvents: boolean(
        metrics.emitEvents,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.metrics.emitEvents,
      ),
      appendEntries: boolean(
        metrics.appendEntries,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.metrics.appendEntries,
      ),
      maximumEntriesPerSession: positiveInteger(
        metrics.maximumEntriesPerSession,
        DEFAULT_CONTEXT_COMPACTION_CONFIG.metrics.maximumEntriesPerSession,
        10_000,
      ),
    }),
  });
}

/** Private, fail-open loader. Invalid or absent fields retain conservative defaults. */
export function loadContextCompactionConfig(path: string) {
  try {
    return parseContextCompactionConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return parseContextCompactionConfig(undefined);
  }
}

export function customEnabledForReason(
  reason: "manual" | "threshold" | "overflow",
  config: ContextCompactionConfig,
) {
  if (reason === "manual") return config.manual.custom;
  if (reason === "threshold") {
    return config.threshold.custom && config.threshold.observationOptIn;
  }
  return config.overflow.experimentalCustom;
}
