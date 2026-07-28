import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createPiCheckpointSummaryModel,
  type CheckpointSummaryModel,
  type CheckpointVerifier,
} from "./src/index.ts";
import {
  createProductionCompactionAdapter,
  validateReconstructedCompactionResult,
  type ProductionCompactionAttempt,
} from "./src/adapter.ts";
import {
  loadContextCompactionConfig,
  type ContextCompactionConfig,
} from "./src/config.ts";

export const CONTEXT_COMPACTION_METRICS_CHANNEL = "context-compaction:metrics";
export const CONTEXT_COMPACTION_METRICS_ENTRY = "context-compaction/metrics-v1";
export const CONTEXT_COMPACTION_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "config.private.json",
);

export interface ContextCompactionMetric {
  readonly version: 1;
  readonly timestampMs: number;
  readonly reason: "manual" | "threshold" | "overflow";
  readonly willRetry: boolean;
  readonly fromExtension: boolean;
  readonly adapterOutcome:
    ProductionCompactionAttempt["outcome"] | "unobserved";
  readonly fallbackCode?: string;
  readonly tokensBefore: number;
  readonly usageTokens: number | null;
  readonly usageCost: number | null;
  readonly reconstructionValid: boolean | null;
}

export interface ContextCompactionExtensionOptions {
  readonly config?: ContextCompactionConfig;
  readonly model?: CheckpointSummaryModel;
  readonly verifier?: CheckpointVerifier;
  readonly now?: () => number;
}

function metricFor(
  event: SessionCompactEvent,
  attempt: ProductionCompactionAttempt | undefined,
  now: () => number,
): ContextCompactionMetric {
  let reconstructionValid: boolean | null = null;
  if (event.fromExtension && attempt?.result) {
    try {
      validateReconstructedCompactionResult({
        entries: attempt.entries,
        result: event.compactionEntry,
      });
      reconstructionValid = true;
    } catch {
      reconstructionValid = false;
    }
  }
  return {
    version: 1,
    timestampMs: now(),
    reason: event.reason,
    willRetry: event.willRetry,
    fromExtension: event.fromExtension,
    adapterOutcome: attempt?.outcome ?? "unobserved",
    ...(attempt?.fallbackCode ? { fallbackCode: attempt.fallbackCode } : {}),
    tokensBefore: event.compactionEntry.tokensBefore,
    usageTokens: event.compactionEntry.usage?.totalTokens ?? null,
    usageCost: event.compactionEntry.usage?.cost.total ?? null,
    reconstructionValid,
  };
}

export function createContextCompactionExtension(
  options: ContextCompactionExtensionOptions = {},
) {
  return function contextCompactionExtension(pi: ExtensionAPI) {
    let config =
      options.config ??
      loadContextCompactionConfig(CONTEXT_COMPACTION_CONFIG_PATH);
    let adapter:
      ReturnType<typeof createProductionCompactionAdapter> | undefined;
    let latestAttempt: ProductionCompactionAttempt | undefined;
    let metricEntries = 0;
    const now = options.now ?? Date.now;

    pi.on("session_start", (_event, ctx) => {
      config =
        options.config ??
        loadContextCompactionConfig(CONTEXT_COMPACTION_CONFIG_PATH);
      latestAttempt = undefined;
      metricEntries = 0;
      const model =
        options.model ??
        createPiCheckpointSummaryModel({
          modelRegistry: ctx.modelRegistry,
          config: config.summaryModel,
        });
      adapter = createProductionCompactionAdapter({
        config,
        model,
        verifier: options.verifier,
        observe: (attempt) => {
          latestAttempt = attempt;
        },
      });
    });

    pi.on("session_before_compact", async (event) => {
      // Returning undefined is intentional for every policy/failure path: Pi then
      // runs native compaction. This extension never returns cancel, especially on overflow.
      return adapter?.(event);
    });

    pi.on("session_compact", (event) => {
      const attempt =
        latestAttempt?.reason === event.reason ? latestAttempt : undefined;
      const metric = metricFor(event, attempt, now);
      latestAttempt = undefined;
      if (config.metrics.emitEvents) {
        pi.events.emit(CONTEXT_COMPACTION_METRICS_CHANNEL, metric);
      }
      if (
        config.metrics.appendEntries &&
        metricEntries < config.metrics.maximumEntriesPerSession
      ) {
        metricEntries += 1;
        pi.appendEntry(CONTEXT_COMPACTION_METRICS_ENTRY, metric);
      }
    });

    pi.on("session_shutdown", () => {
      adapter = undefined;
      latestAttempt = undefined;
      metricEntries = 0;
    });
  };
}

export default createContextCompactionExtension();
