import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateTokens,
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ContextMeasurement,
  MeasurementUnknownReason,
  ModelIdentity,
} from "../../shared/context-governor-state.ts";

export interface NativeCompactionSettings {
  readonly enabled: boolean;
  readonly thresholdPercent?: number;
  readonly reserveTokens: number;
}

export interface ContextUsageLike {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly compactionThreshold?: unknown;
  readonly source?: unknown;
}

export interface RuntimeCompactionThreshold {
  readonly tokens: number;
  readonly source: "percentage" | "reserve";
  readonly percentage?: number;
  readonly reserveTokens?: number;
}

export interface MeasurementInput {
  readonly model: ModelIdentity | null;
  readonly usage: ContextUsageLike | undefined;
  readonly messages: readonly AgentMessage[];
  readonly unknownReason?: MeasurementUnknownReason;
  readonly rejectUsage?: boolean;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function hasCurrentModelAssistant(
  messages: readonly AgentMessage[],
  model: ModelIdentity,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      return false;
    }
    return message.provider === model.provider && message.model === model.id;
  }
  return false;
}

function sameModelUsageEpoch(
  messages: readonly AgentMessage[],
  model: ModelIdentity,
) {
  return (
    !messages.some((message) => message.role === "assistant") ||
    hasCurrentModelAssistant(messages, model)
  );
}

export function estimateMessageTokens(messages: readonly AgentMessage[]) {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return tokens;
}

export function measureContext(input: MeasurementInput): ContextMeasurement {
  const { model, usage, messages } = input;
  if (!model || model.contextWindow <= 0) {
    return {
      tokens: null,
      contextWindow: 0,
      percent: null,
      source: "unknown",
      unknownReason: "no-model",
    };
  }

  const usageMatchesModel =
    input.rejectUsage !== true &&
    usage?.contextWindow === model.contextWindow &&
    sameModelUsageEpoch(messages, model);
  if (
    usageMatchesModel &&
    isFiniteNonNegative(usage.tokens) &&
    usage.tokens !== null
  ) {
    return {
      tokens: usage.tokens,
      contextWindow: model.contextWindow,
      percent: (usage.tokens / model.contextWindow) * 100,
      source: "pi-usage",
    };
  }

  try {
    const tokens = estimateMessageTokens(messages);
    return {
      tokens,
      contextWindow: model.contextWindow,
      percent: (tokens / model.contextWindow) * 100,
      source: "message-estimate",
    };
  } catch {
    return {
      tokens: null,
      contextWindow: model.contextWindow,
      percent: null,
      source: "unknown",
      unknownReason:
        input.unknownReason ??
        (usageMatchesModel ? "usage-unavailable" : "model-changed"),
    };
  }
}

export function modelIdentity(ctx: ExtensionContext): ModelIdentity | null {
  const model = ctx.model;
  if (!model || !isFiniteNonNegative(model.contextWindow)) return null;
  return {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  };
}

export function readExtensionContextUsage(
  ctx: Pick<ExtensionContext, "getContextUsage">,
): ContextUsageLike | undefined {
  try {
    return ctx.getContextUsage() as ContextUsageLike | undefined;
  } catch {
    return undefined;
  }
}

export function measureExtensionContext(
  ctx: ExtensionContext,
  messages: readonly AgentMessage[],
  unknownReason?: MeasurementUnknownReason,
  rejectUsage = false,
  usage = readExtensionContextUsage(ctx),
) {
  return measureContext({
    model: modelIdentity(ctx),
    usage,
    messages,
    unknownReason,
    rejectUsage,
  });
}

export function normalizeRuntimeCompactionThreshold(
  value: unknown,
): RuntimeCompactionThreshold | null {
  if (!isRecord(value) || !isFiniteNonNegative(value.tokens)) return null;
  if (
    value.source === "percentage" &&
    typeof value.percentage === "number" &&
    Number.isFinite(value.percentage)
  ) {
    return {
      tokens: value.tokens,
      source: "percentage",
      percentage: value.percentage,
    };
  }
  if (value.source === "reserve" && isFiniteNonNegative(value.reserveTokens)) {
    return {
      tokens: value.tokens,
      source: "reserve",
      reserveTokens: value.reserveTokens,
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeNativeCompactionSettings(
  value: unknown,
): NativeCompactionSettings | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    !isFiniteNonNegative(value.reserveTokens)
  ) {
    return null;
  }

  const thresholdPercent =
    "thresholdPercent" in value &&
    typeof value.thresholdPercent === "number" &&
    Number.isFinite(value.thresholdPercent)
      ? value.thresholdPercent
      : undefined;
  return {
    enabled: value.enabled,
    thresholdPercent,
    reserveTokens: value.reserveTokens,
  };
}

export function readNativeCompactionSettings(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): NativeCompactionSettings | null {
  try {
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (manager.drainErrors().length > 0) return null;
    return normalizeNativeCompactionSettings(manager.getCompactionSettings());
  } catch {
    return null;
  }
}
