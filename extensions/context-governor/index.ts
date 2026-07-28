import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  CONTEXT_GOVERNOR_REFRESH_CHANNEL,
  emptyGovernorState,
  type GovernorState,
  type MeasurementUnknownReason,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
import {
  CONTEXT_WIRE_STATE_CHANNEL,
  contextWireFingerprint,
  contextWireModelKey,
  matchContextWireState,
  newerContextWireState,
  type ContextWireState,
} from "../shared/context-wire-state.ts";
import {
  DEFAULT_GOVERNOR_CONFIG,
  loadGovernorConfig,
  type GovernorConfig,
} from "./src/config.ts";
import {
  createContextGovernor,
  resolveBudget,
  type ContextGovernor,
  type GovernorEvent,
  type GovernorSnapshot,
} from "./src/governor.ts";
import {
  hasCurrentModelAssistant,
  measureExtensionContext,
  modelIdentity,
  normalizeRuntimeCompactionThreshold,
  readExtensionContextUsage,
  readNativeCompactionSettings,
} from "./src/measurement.ts";
import { formatStatusReport } from "./src/status-report.ts";
import {
  createTelemetryWriter,
  type TelemetryWriter,
} from "./src/telemetry.ts";

const ADVISORY_CUSTOM_TYPE = "context-governor-advisory";
const CONFIG_FILE_NAME = "config.private.json";
const MAX_TRACKED_TOOL_NAMES = 128;
const OTHER_TOOL_NAME = "(other tools)";

interface OpenRun {
  readonly id: string;
}

function contextGovernorDirectory() {
  return join(getAgentDir(), "context-governor");
}

export function contextGovernorPaths() {
  const root = contextGovernorDirectory();
  return {
    config: join(root, CONFIG_FILE_NAME),
    telemetryDirectory: join(root, "telemetry"),
  };
}

function sessionMessages(ctx: ExtensionContext): readonly AgentMessage[] {
  try {
    return ctx.sessionManager
      .buildContextEntries()
      .flatMap(sessionEntryToContextMessages);
  } catch {
    return [];
  }
}

function sameModel(
  left: GovernorState["model"],
  right: GovernorState["model"],
) {
  return (
    left?.provider === right?.provider &&
    left?.id === right?.id &&
    left?.contextWindow === right?.contextWindow
  );
}

function contextGeneration(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.buildContextEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return `compaction:${entry.id}`;
  }
  return "uncompacted";
}

function immutableState(
  state: Readonly<GovernorState>,
): Readonly<GovernorState> {
  return Object.freeze({
    ...state,
    model: state.model === null ? null : Object.freeze({ ...state.model }),
    measurement: Object.freeze({ ...state.measurement }),
    budget: Object.freeze({ ...state.budget }),
    growth: Object.freeze({ ...state.growth }),
    pressure: Object.freeze({
      level: state.pressure.level,
      reasons: Object.freeze([...state.pressure.reasons]),
    }),
    wireAccounting:
      state.wireAccounting === null
        ? null
        : Object.freeze({ ...state.wireAccounting }),
    toolResultBytesByTool: Object.freeze({ ...state.toolResultBytesByTool }),
  });
}

function emptyPublishedState() {
  return immutableState(emptyGovernorState());
}

function toolResultBytes(result: ToolResultMessage) {
  let bytes = 0;
  for (const block of result.content) {
    if (block.type === "text") {
      bytes += Buffer.byteLength(block.text, "utf8");
    } else if (block.type === "image") {
      bytes += Buffer.byteLength(block.data, "utf8");
    }
  }
  return bytes;
}

export function accumulateToolResultBytes(
  results: readonly ToolResultMessage[],
  seenToolCallIds: Set<string>,
  totals: Map<string, number>,
) {
  for (const result of results) {
    if (seenToolCallIds.has(result.toolCallId)) continue;
    seenToolCallIds.add(result.toolCallId);
    const toolName =
      totals.has(result.toolName) || totals.size < MAX_TRACKED_TOOL_NAMES - 1
        ? result.toolName
        : OTHER_TOOL_NAME;
    totals.set(toolName, (totals.get(toolName) ?? 0) + toolResultBytes(result));
  }
}

function formatTokens(value: number | null) {
  if (value === null) return "unknown";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function pressureAdvice(level: PressureLevel) {
  const profiles =
    "If delegation would help, keep it scoped and choose the least-privilege research, coding, review, or minimal profile; require a bounded structured report with artifact references.";
  if (level === "red" || level === "emergency") {
    return `For this turn: avoid broad parent-session searches, request bounded slices, and keep output minimal. ${profiles}`;
  }
  return `For this turn: avoid broad parent-session searches and request bounded slices. ${profiles}`;
}

function truncateNotice(value: string, maximum: number) {
  const limit = Math.max(1, Math.floor(maximum));
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

export function formatContextNotice(
  state: Readonly<GovernorState>,
  maximumCharacters: number,
) {
  const level = state.pressure.level;
  if (level === null || level === "green") return null;
  const latest =
    state.growth.latestTokens === null
      ? "last run unknown"
      : `${state.growth.latestTokens >= 0 ? "+" : ""}${formatTokens(state.growth.latestTokens)} last run`;
  const runway =
    state.runwayRuns === null
      ? "runway unknown"
      : `~${state.runwayRuns.toFixed(1)} similar runs remain`;
  const occupancy =
    state.wireAccounting?.mode === "applied"
      ? `R ${formatTokens(state.wireAccounting.residentTokens)}; W ${formatTokens(state.wireAccounting.effectiveWireTokens)}/${formatTokens(state.measurement.contextWindow)}`
      : `${formatTokens(state.measurement.tokens)}/${formatTokens(state.measurement.contextWindow)}`;
  const text = `Context budget: ${occupancy}; safe ${formatTokens(state.budget.effectiveSafeLimitTokens)}; ${latest}; ${runway} (${level}).\n${pressureAdvice(level)}`;
  return truncateNotice(text, maximumCharacters);
}

export function appendContextNotice(
  messages: readonly AgentMessage[],
  state: Readonly<GovernorState>,
  config: Readonly<GovernorConfig>,
  timestamp = Date.now(),
): AgentMessage[] | null {
  if (!config.notice.enabled) return null;
  const content = formatContextNotice(state, config.notice.maxCharacters);
  if (content === null) return null;
  return [
    ...messages,
    {
      role: "custom",
      customType: ADVISORY_CUSTOM_TYPE,
      content,
      display: false,
      timestamp,
    },
  ];
}

export default function contextGovernorExtension(pi: ExtensionAPI) {
  let config = DEFAULT_GOVERNOR_CONFIG;
  let governor: ContextGovernor = createContextGovernor(config);
  let publishedState = emptyPublishedState();
  let currentContext: ExtensionContext | undefined;
  let openRun: OpenRun | null = null;
  let engineRunNeedsRebase = false;
  let rejectPiUsage = false;
  let runSequence = 0;
  let seenToolCallIds = new Set<string>();
  let toolBytes = new Map<string, number>();
  let telemetry: TelemetryWriter | undefined;
  let latestWireState: Readonly<ContextWireState> | null = null;
  let telemetryPath = contextGovernorPaths().telemetryDirectory;
  let nativeLimitProvenance: "runtime-resolved" | "settings-file-derived" =
    "settings-file-derived";
  let contextUsageProvenance: string | undefined;

  const publish = (state: Readonly<GovernorState>) => {
    publishedState = immutableState(state);
    pi.events.emit(CONTEXT_GOVERNOR_CHANNEL, publishedState);
    return publishedState;
  };

  const appendTelemetry = (state: Readonly<GovernorState>) => {
    telemetry?.append(state, governor.audit());
  };

  const toolByteRecord = () => Object.fromEntries(toolBytes.entries());

  const stopWireListener = pi.events.on(CONTEXT_WIRE_STATE_CHANNEL, (value) => {
    latestWireState = newerContextWireState(latestWireState, value);
  });

  const snapshot = (
    ctx: ExtensionContext,
    event: GovernorEvent,
    messages = sessionMessages(ctx),
    unknownReason?: MeasurementUnknownReason,
  ): GovernorSnapshot => {
    const model = modelIdentity(ctx);
    const usage = readExtensionContextUsage(ctx);
    const native = readNativeCompactionSettings(ctx);
    const runtimeThreshold = normalizeRuntimeCompactionThreshold(
      usage?.compactionThreshold,
    );
    const useRuntimeThreshold = native !== null && runtimeThreshold !== null;
    nativeLimitProvenance = useRuntimeThreshold
      ? "runtime-resolved"
      : "settings-file-derived";
    contextUsageProvenance =
      typeof usage?.source === "string" ? usage.source.slice(0, 80) : undefined;
    const fingerprint = contextWireFingerprint(messages);
    const wireMatch = matchContextWireState(latestWireState, {
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      modelKey: contextWireModelKey(model),
      contextGeneration: contextGeneration(ctx),
      contextFingerprint: fingerprint,
    });
    const wireAccounting = wireMatch === null ? null : latestWireState;
    return {
      capturedAtMs: Date.now(),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      model,
      measurement: measureExtensionContext(
        ctx,
        messages,
        unknownReason,
        rejectPiUsage,
        usage,
      ),
      budget: resolveBudget({
        contextWindow: model?.contextWindow ?? 0,
        nativeProactiveEnabled: native?.enabled ?? null,
        thresholdPercent: native?.thresholdPercent,
        reserveTokens: native?.reserveTokens,
        resolvedNativeLimit: useRuntimeThreshold
          ? {
              tokens: runtimeThreshold.tokens,
              source: runtimeThreshold.source,
            }
          : null,
        advisorySafePercent: config.advisorySafePercent,
      }),
      event,
      wireAccounting,
      toolResultBytesByTool:
        event.kind === "run-settled" ? toolByteRecord() : undefined,
    };
  };

  const observe = (
    ctx: ExtensionContext,
    event: GovernorEvent,
    messages?: readonly AgentMessage[],
    unknownReason?: MeasurementUnknownReason,
  ) => {
    currentContext = ctx;
    let next = snapshot(ctx, event, messages, unknownReason);
    if (
      governor.current().sessionId !== "" &&
      event.kind !== "session-start" &&
      event.kind !== "model-reset" &&
      !sameModel(governor.current().model, next.model)
    ) {
      rejectPiUsage = true;
      openRun = null;
      engineRunNeedsRebase = false;
      seenToolCallIds = new Set();
      toolBytes = new Map();
      next = snapshot(ctx, event, messages, "model-changed");
      const resetState = governor.observe({
        ...next,
        event: { kind: "model-reset" },
      });
      appendTelemetry(resetState);
    }
    return governor.observe(next);
  };

  const openUmbrellaRun = (ctx: ExtensionContext) => {
    if (openRun !== null) return;
    runSequence += 1;
    openRun = {
      id: `${ctx.sessionManager.getSessionId()}:${runSequence}`,
    };
    engineRunNeedsRebase = false;
    seenToolCallIds = new Set();
    toolBytes = new Map();
    publish(observe(ctx, { kind: "run-start", runId: openRun.id }));
  };

  const rebaseEngineRun = (ctx: ExtensionContext) => {
    if (openRun === null || !engineRunNeedsRebase) return;
    engineRunNeedsRebase = false;
    publish(observe(ctx, { kind: "run-start", runId: openRun.id }));
  };

  const stopRefreshListener = pi.events.on(
    CONTEXT_GOVERNOR_REFRESH_CHANNEL,
    () => {
      if (!currentContext) return;
      publish(observe(currentContext, { kind: "sample" }));
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    await telemetry?.flush();
    currentContext = ctx;
    openRun = null;
    engineRunNeedsRebase = false;
    rejectPiUsage = false;
    runSequence = 0;
    seenToolCallIds = new Set();
    toolBytes = new Map();

    latestWireState = null;
    const paths = contextGovernorPaths();
    config = loadGovernorConfig(paths.config);
    governor = createContextGovernor(config);
    telemetry = createTelemetryWriter({
      enabled: config.telemetry.enabled,
      directory: paths.telemetryDirectory,
      sessionId: ctx.sessionManager.getSessionId(),
      maxRecords: config.telemetry.maxRecords,
      maxBytes: config.telemetry.maxBytes,
    });
    telemetryPath = telemetry.path;
    const state = publish(observe(ctx, { kind: "session-start" }));
    appendTelemetry(state);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    openUmbrellaRun(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    openUmbrellaRun(ctx);
    rebaseEngineRun(ctx);
  });

  pi.on("context", (event, ctx) => {
    rebaseEngineRun(ctx);
    const state = publish(observe(ctx, { kind: "sample" }, event.messages));
    const messages = appendContextNotice(
      event.messages,
      state,
      config,
      state.capturedAtMs,
    );
    return messages === null ? undefined : { messages };
  });

  pi.on("turn_end", (event) => {
    accumulateToolResultBytes(event.toolResults, seenToolCallIds, toolBytes);
  });

  pi.on("agent_end", (event, ctx) => {
    const identity = modelIdentity(ctx);
    if (
      identity !== null &&
      hasCurrentModelAssistant(event.messages, identity)
    ) {
      rejectPiUsage = false;
    }
    publish(observe(ctx, { kind: "sample" }));
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "overflow") return;
    publish(
      observe(ctx, {
        kind: "emergency",
        reason: "provider-overflow",
      }),
    );
  });

  pi.on("session_compact", (event, ctx) => {
    const state = publish(
      observe(
        ctx,
        { kind: "compaction", reason: event.reason },
        sessionMessages(ctx),
        "post-compaction",
      ),
    );
    appendTelemetry(state);
    if (openRun !== null) {
      engineRunNeedsRebase = true;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (openRun === null) {
      publish(observe(ctx, { kind: "sample" }));
      return;
    }
    if (!ctx.isIdle()) {
      publish(observe(ctx, { kind: "sample" }));
      return;
    }
    const settledRun = openRun;
    const state = publish(
      observe(ctx, { kind: "run-settled", runId: settledRun.id }),
    );
    openRun = null;
    engineRunNeedsRebase = false;
    appendTelemetry(state);
  });

  pi.on("model_select", (_event, ctx) => {
    openRun = null;
    engineRunNeedsRebase = false;
    rejectPiUsage = true;
    seenToolCallIds = new Set();
    toolBytes = new Map();
    const state = publish(
      observe(
        ctx,
        { kind: "model-reset" },
        sessionMessages(ctx),
        "model-changed",
      ),
    );
    appendTelemetry(state);
  });

  pi.on("session_tree", (_event, ctx) => {
    openRun = null;
    engineRunNeedsRebase = false;
    seenToolCallIds = new Set();
    toolBytes = new Map();
    const state = publish(observe(ctx, { kind: "tree-reset" }));
    appendTelemetry(state);
  });

  pi.on("session_shutdown", async () => {
    stopRefreshListener();
    latestWireState = null;
    await telemetry?.flush();
    telemetry = undefined;
    currentContext = undefined;
    openRun = null;
    engineRunNeedsRebase = false;
    rejectPiUsage = false;
    publishedState = emptyPublishedState();
    stopWireListener();
    pi.events.emit(CONTEXT_GOVERNOR_CHANNEL, publishedState);
  });

  pi.registerCommand("context-status", {
    description: "Show the advisory context governor report",
    handler: async (_args, ctx) => {
      const state = publish(observe(ctx, { kind: "sample" }));
      const paths = contextGovernorPaths();
      ctx.ui.notify(
        formatStatusReport(state, config, {
          config: paths.config,
          telemetry: telemetryPath,
          nativeLimitProvenance,
          contextUsageProvenance,
        }),
        "info",
      );
    },
  });
}
