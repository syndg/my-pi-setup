import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  CONTEXT_WIRE_STATE_CHANNEL,
  isContextWireState,
} from "../shared/context-wire-state.ts";
import { evaluateCacheAudit } from "./src/evaluator.ts";
import {
  addedAndRemoved,
  createPrefixKey,
  stablePrefixSample,
  type StablePrefixSample,
} from "./src/prefix.ts";
import { formatCacheStatus } from "./src/status.ts";
import {
  createCacheTelemetryWriter,
  type CacheTelemetryWriter,
} from "./src/telemetry.ts";
import {
  cacheRatio,
  createProviderUsageAccumulator,
  type ProviderUsageAccumulator,
} from "./src/usage.ts";
import {
  DEFAULT_CACHE_AUDIT_POLICY,
  type CacheRunRecord,
  type DecayEpochObservation,
  type ToolActivationObservation,
} from "./src/types.ts";

export const CONTEXT_CACHE_TOOL_ACTIVATION_CHANNEL =
  "context-cache:tool-activation";
export const CONTEXT_CACHE_AUDIT_CHANNEL = "context-cache:audit";
const MAX_EVENTS_PER_RUN = 32;

export interface ContextCacheToolActivationEvent {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly source: ToolActivationObservation["source"];
  readonly addedToolNames: readonly string[];
}

function isActivation(
  value: unknown,
): value is ContextCacheToolActivationEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ContextCacheToolActivationEvent>;
  return (
    event.schemaVersion === 1 &&
    typeof event.sessionId === "string" &&
    typeof event.runId === "string" &&
    Number.isSafeInteger(event.sequence) &&
    (event.source === "tool-result" ||
      event.source === "observed-active-set" ||
      event.source === "external") &&
    Array.isArray(event.addedToolNames) &&
    event.addedToolNames.every((name) => typeof name === "string")
  );
}

interface OpenRun {
  id: string;
  boundary: CacheRunRecord["boundary"];
  usage: ProviderUsageAccumulator;
  prefixSamples: number;
  prefixChanges: number;
  additiveChanges: number;
  nonAdditiveChanges: number;
  unexplainedChanges: number;
  latestPrefixBytes: number | null;
  activations: ToolActivationObservation[];
  epochs: DecayEpochObservation[];
}

export function contextCachePaths() {
  return {
    telemetryDirectory: join(getAgentDir(), "context-cache", "telemetry"),
  };
}

export default function contextCacheExtension(pi: ExtensionAPI) {
  const prefixKey = createPrefixKey();
  const records: CacheRunRecord[] = [];
  let sessionId = "";
  let runSequence = 0;
  let activationSequence = 0;
  let open: OpenRun | null = null;
  let previousPrefix: StablePrefixSample | null = null;
  let pendingBoundary: CacheRunRecord["boundary"] = "session";
  let resetPrefix = true;
  let telemetry: CacheTelemetryWriter | undefined;
  let telemetryPath = contextCachePaths().telemetryDirectory;

  const begin = () => {
    if (open) return open;
    runSequence += 1;
    open = {
      id: `${sessionId}:${runSequence}`,
      boundary: pendingBoundary,
      usage: createProviderUsageAccumulator(),
      prefixSamples: 0,
      prefixChanges: 0,
      additiveChanges: 0,
      nonAdditiveChanges: 0,
      unexplainedChanges: 0,
      latestPrefixBytes: null,
      activations: [],
      epochs: [],
    };
    pendingBoundary = null;
    return open;
  };

  const emitActivation = (
    names: readonly string[],
    source: ToolActivationObservation["source"],
  ) => {
    const added = [...new Set(names)].filter(Boolean).slice(0, 32);
    if (!added.length) return;
    const run = begin();
    activationSequence += 1;
    pi.events.emit(
      CONTEXT_CACHE_TOOL_ACTIVATION_CHANNEL,
      Object.freeze({
        schemaVersion: 1,
        sessionId,
        runId: run.id,
        sequence: activationSequence,
        source,
        addedToolNames: Object.freeze(added),
      } satisfies ContextCacheToolActivationEvent),
    );
  };

  const stopActivation = pi.events.on(
    CONTEXT_CACHE_TOOL_ACTIVATION_CHANNEL,
    (value) => {
      if (!isActivation(value) || value.sessionId !== sessionId) return;
      const run = begin();
      if (
        value.runId !== run.id ||
        run.activations.length >= MAX_EVENTS_PER_RUN
      )
        return;
      run.activations.push(
        Object.freeze({
          sequence: value.sequence,
          source: value.source,
          addedToolNames: Object.freeze(value.addedToolNames.slice(0, 32)),
        }),
      );
    },
  );

  const stopDecay = pi.events.on(CONTEXT_WIRE_STATE_CHANNEL, (value) => {
    if (!isContextWireState(value) || value.sessionId !== sessionId) return;
    const run = begin();
    if (run.epochs.length >= MAX_EVENTS_PER_RUN) run.epochs.shift();
    run.epochs.push(
      Object.freeze({
        sequence: value.sequence,
        mode: value.mode,
        stable: value.stable,
        cacheEpochId: value.cacheEpochId.slice(0, 120),
      }),
    );
  });

  const observePrefix = (ctx: ExtensionContext) => {
    const run = begin();
    try {
      if (resetPrefix) {
        previousPrefix = null;
        resetPrefix = false;
      }
      const sample = stablePrefixSample(
        ctx.getSystemPrompt(),
        pi.getActiveTools(),
        pi.getAllTools(),
        prefixKey,
      );
      run.prefixSamples += 1;
      run.latestPrefixBytes = sample.prefixBytes;
      if (previousPrefix && previousPrefix.fingerprint !== sample.fingerprint) {
        run.prefixChanges += 1;
        const diff = addedAndRemoved(
          previousPrefix.activeToolNames,
          sample.activeToolNames,
        );
        if (diff.added.length && diff.removed.length === 0) {
          const accounted = new Set(
            run.activations.flatMap((event) => event.addedToolNames),
          );
          const missing = diff.added.filter((name) => !accounted.has(name));
          if (missing.length) emitActivation(missing, "observed-active-set");
          run.additiveChanges += 1;
        } else if (diff.added.length || diff.removed.length) {
          run.nonAdditiveChanges += 1;
        } else {
          run.unexplainedChanges += 1;
        }
      }
      previousPrefix = sample;
    } catch {
      // Prefix audit is metrics-only and fail-open.
    }
  };

  const finish = () => {
    if (!open) return;
    const providers = open.usage.snapshot();
    const record: CacheRunRecord = Object.freeze({
      schemaVersion: 1,
      timestampMs: Date.now(),
      sessionId,
      runId: open.id,
      boundary: open.boundary,
      providers,
      cacheRatio: cacheRatio(providers),
      prefix: Object.freeze({
        samples: open.prefixSamples,
        changes: open.prefixChanges,
        additiveChanges: open.additiveChanges,
        nonAdditiveChanges: open.nonAdditiveChanges,
        unexplainedChanges: open.unexplainedChanges,
        latestPrefixBytes: open.latestPrefixBytes,
      }),
      additiveActivations: Object.freeze([...open.activations]),
      decayEpochs: Object.freeze([...open.epochs]),
    });
    records.push(record);
    if (records.length > DEFAULT_CACHE_AUDIT_POLICY.historyRuns)
      records.shift();
    telemetry?.append(record);
    pi.events.emit(CONTEXT_CACHE_AUDIT_CHANNEL, evaluateCacheAudit(records));
    open = null;
  };

  const boundary = (kind: Exclude<CacheRunRecord["boundary"], null>) => {
    pendingBoundary = kind;
    if (open) open.boundary = kind;
    resetPrefix = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    await telemetry?.flush();
    sessionId = ctx.sessionManager.getSessionId();
    runSequence = 0;
    activationSequence = 0;
    open = null;
    records.length = 0;
    previousPrefix = null;
    pendingBoundary = "session";
    resetPrefix = true;
    const directory = contextCachePaths().telemetryDirectory;
    telemetry = createCacheTelemetryWriter({
      enabled: true,
      directory,
      sessionId,
      maxRecords: 200,
      maxBytes: 524_288,
    });
    telemetryPath = telemetry.path;
  });
  pi.on("before_agent_start", (_event, ctx) => observePrefix(ctx));
  pi.on("agent_start", (_event, ctx) => observePrefix(ctx));
  pi.on("context", (_event, ctx) => {
    observePrefix(ctx);
    return undefined;
  });
  pi.on("turn_end", (event, ctx) => {
    const run = begin();
    if (event.message.role === "assistant")
      run.usage.add(event.message as AssistantMessage);
    emitActivation(
      event.toolResults.flatMap((result) => result.addedToolNames ?? []),
      "tool-result",
    );
    observePrefix(ctx);
  });
  pi.on("agent_settled", () => finish());
  pi.on("model_select", () => boundary("model"));
  pi.on("session_compact", () => boundary("compaction"));
  pi.on("session_tree", () => boundary("tree"));
  pi.on("session_shutdown", async () => {
    finish();
    await telemetry?.flush();
    telemetry = undefined;
    open = null;
    sessionId = "";
    stopActivation();
    stopDecay();
  });

  pi.registerCommand("context-cache-status", {
    description: "Show metrics-only prompt-cache and stable-prefix audit",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(
          formatCacheStatus(
            records,
            evaluateCacheAudit(records),
            telemetryPath,
          ),
          "info",
        );
      } catch {
        ctx.ui.notify(
          "Context cache observer status is unavailable; agent behavior is unaffected.",
          "warning",
        );
      }
    },
  });
}

export * from "./src/evaluator.ts";
export * from "./src/prefix.ts";
export * from "./src/status.ts";
export * from "./src/telemetry.ts";
export * from "./src/types.ts";
export * from "./src/usage.ts";
