import { readFileSync } from "node:fs";
import type { DecayConfig } from "./types.ts";
import { DEFAULT_DECAY_CONFIG } from "./types.ts";

export interface ContextDecayPrivateConfig extends DecayConfig {
  /** Explicit request-time apply requires a private opt-in. */
  readonly allowExplicitApply: boolean;
  /** Automatic request-time epochs require a separate private opt-in. */
  readonly automaticMutationEnabled: boolean;
  readonly automaticMinimumProjectedSavingsTokens: number;
  readonly automaticMinimumSettledRuns: number;
  readonly automaticMinimumEpochDurationMs: number;
  readonly automaticSignalMaximumAgeMs: number;
  readonly maximumReportedCandidates: number;
  readonly maximumReportCharacters: number;
}

export const DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG: ContextDecayPrivateConfig =
  Object.freeze({
    ...DEFAULT_DECAY_CONFIG,
    allowExplicitApply: false,
    automaticMutationEnabled: false,
    automaticMinimumProjectedSavingsTokens: 4_000,
    automaticMinimumSettledRuns: 3,
    automaticMinimumEpochDurationMs: 120_000,
    automaticSignalMaximumAgeMs: 120_000,
    maximumReportedCandidates: 24,
    maximumReportCharacters: 4_000,
  });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function parseContextDecayConfig(
  value: unknown,
): ContextDecayPrivateConfig {
  const input = record(value) ?? {};
  const maximum = input.maximumWireTokens;
  return Object.freeze({
    protectedRecentTokens: positive(
      input.protectedRecentTokens,
      DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.protectedRecentTokens,
    ),
    oldLargeResultTokens: positive(
      input.oldLargeResultTokens,
      DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.oldLargeResultTokens,
    ),
    minimumReplacementSavingsTokens: positive(
      input.minimumReplacementSavingsTokens,
      DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.minimumReplacementSavingsTokens,
    ),
    maximumWireTokens:
      maximum === null
        ? null
        : typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0
          ? Math.floor(maximum)
          : DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.maximumWireTokens,
    pinnedIdentities: Object.freeze(
      Array.isArray(input.pinnedIdentities)
        ? input.pinnedIdentities
            .filter((item): item is string => typeof item === "string")
            .slice(0, 1_000)
        : [],
    ),
    allowExplicitApply: input.allowExplicitApply === true,
    automaticMutationEnabled: input.automaticMutationEnabled === true,
    automaticMinimumProjectedSavingsTokens: positive(
      input.automaticMinimumProjectedSavingsTokens,
      DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.automaticMinimumProjectedSavingsTokens,
    ),
    automaticMinimumSettledRuns: Math.min(
      1_000,
      nonNegative(
        input.automaticMinimumSettledRuns,
        DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.automaticMinimumSettledRuns,
      ),
    ),
    automaticMinimumEpochDurationMs: Math.min(
      86_400_000,
      nonNegative(
        input.automaticMinimumEpochDurationMs,
        DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.automaticMinimumEpochDurationMs,
      ),
    ),
    automaticSignalMaximumAgeMs: Math.min(
      86_400_000,
      positive(
        input.automaticSignalMaximumAgeMs,
        DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.automaticSignalMaximumAgeMs,
      ),
    ),
    maximumReportedCandidates: Math.min(
      100,
      positive(
        input.maximumReportedCandidates,
        DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.maximumReportedCandidates,
      ),
    ),
    maximumReportCharacters: Math.min(
      20_000,
      positive(
        input.maximumReportCharacters,
        DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG.maximumReportCharacters,
      ),
    ),
  });
}

export function loadContextDecayConfig(
  path: string,
): ContextDecayPrivateConfig {
  try {
    return parseContextDecayConfig(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    return DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG;
  }
}
