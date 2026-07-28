import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  inferOutputClass,
  parseOutputBrokerConfig,
  resolveOutputBudget,
  utf8Bytes,
  type JsonObject,
  type OutputBroker,
  type OutputClass,
  type OutputEnvelope,
  type PressureLevel,
  type OutputBrokerConfigInput,
} from "../../context-archive/src/index.ts";
import {
  DEFAULT_CONTEXT_OUTPUT_CONFIG,
  errorResultLimit,
  type ContextOutputConfig,
  type ContextOutputMode,
  type ErrorResultBudgetConfig,
} from "./config.ts";

export type BrokerageOutcome =
  | "ignored"
  | "non-text"
  | "error-preserved"
  | "inline"
  | "would-shorten"
  | "shortened"
  | "fail-open";

export interface BrokerageObservation {
  readonly schemaVersion: 1;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly outputClass: OutputClass | null;
  readonly pressure: PressureLevel | null;
  readonly mode: ContextOutputMode;
  readonly outcome: BrokerageOutcome;
  readonly isError: boolean;
  readonly inputBytes: number;
  readonly deliveredBytes: number;
  readonly appliedLimitBytes: number | null;
  readonly bytesSaved: number;
  readonly artifactStored: boolean;
  readonly failOpen: boolean;
}

export interface ToolResultBrokerageRequest {
  readonly event: ToolResultEvent;
  readonly outputClass: OutputClass | null;
  readonly pressure: PressureLevel | null;
  readonly mode: ContextOutputMode;
  readonly broker: OutputBroker;
  /** A broker with the configured error hard ceiling; defaults to broker. */
  readonly errorBroker?: OutputBroker;
  readonly errorConfig?: ErrorResultBudgetConfig;
  readonly explicitLimitBytes?: number;
  readonly brokerConfig?: OutputBrokerConfigInput;
}

export interface ToolResultBrokerageResult {
  readonly patch?: {
    readonly content: ToolResultEvent["content"];
    readonly details: unknown;
    readonly isError: boolean;
    readonly usage?: ToolResultEvent["usage"];
  };
  readonly observation: BrokerageObservation;
  readonly envelope?: OutputEnvelope;
}

function textOutput(event: ToolResultEvent) {
  return event.content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function replaceTextBlocks(
  content: ToolResultEvent["content"],
  replacement: string,
): ToolResultEvent["content"] {
  let replaced = false;
  const next: ToolResultEvent["content"] = [];
  for (const block of content) {
    if (block.type !== "text") {
      next.push(block);
    } else if (!replaced) {
      next.push({ type: "text", text: replacement });
      replaced = true;
    }
  }
  return replaced ? next : content;
}

function patchedDetails(
  event: ToolResultEvent,
  envelope: OutputEnvelope,
): unknown {
  const reference = envelope.artifact?.reference;
  if (reference === undefined) return event.details;
  const contextArtifact = Object.freeze({
    id: reference.id,
    uri: reference.uri,
  });
  if (
    typeof event.details === "object" &&
    event.details !== null &&
    !Array.isArray(event.details)
  ) {
    const details = event.details as Record<string, unknown>;
    // A producer's artifact/spill reference remains authoritative. Keep its
    // conventional key and place this adapter's archive reference beside it.
    if (Object.hasOwn(details, "contextArtifact")) {
      return { ...details, contextOutputArtifact: contextArtifact };
    }
    return { ...details, contextArtifact };
  }
  return event.details === undefined
    ? { contextArtifact }
    : { originalDetails: event.details, contextArtifact };
}

function observation(input: {
  event: ToolResultEvent;
  outputClass: OutputClass | null;
  pressure: PressureLevel | null;
  mode: ContextOutputMode;
  outcome: BrokerageOutcome;
  inputBytes: number;
  deliveredBytes?: number;
  appliedLimitBytes?: number | null;
  artifactStored?: boolean;
  failOpen?: boolean;
}): BrokerageObservation {
  const deliveredBytes = input.deliveredBytes ?? input.inputBytes;
  return Object.freeze({
    schemaVersion: 1,
    toolName: input.event.toolName,
    toolCallId: input.event.toolCallId,
    outputClass: input.outputClass,
    isError: input.event.isError,
    pressure: input.pressure,
    mode: input.mode,
    outcome: input.outcome,
    inputBytes: input.inputBytes,
    deliveredBytes,
    appliedLimitBytes: input.appliedLimitBytes ?? null,
    bytesSaved: Math.max(0, input.inputBytes - deliveredBytes),
    artifactStored: input.artifactStored ?? false,
    failOpen: input.failOpen ?? false,
  });
}

/**
 * Thin tool-result adapter. It preserves usage, isError, image blocks, and
 * tool identity; enforced archives add their bounded reference to details.
 */
export async function brokerToolResult(
  request: ToolResultBrokerageRequest,
): Promise<ToolResultBrokerageResult> {
  const { event, pressure, mode, broker, brokerConfig, explicitLimitBytes } =
    request;
  // Ordinary results remain opt-in by tool class. Error results are always
  // budgeted so an unclassified producer cannot inject an unbounded failure.
  const outputClass =
    request.outputClass ??
    (event.isError ? inferOutputClass(event.toolName) : null);
  const rawOutput = textOutput(event);
  const inputBytes = utf8Bytes(rawOutput);
  const base = { event, outputClass, pressure, mode, inputBytes };

  if (outputClass === null || mode === "off") {
    return { observation: observation({ ...base, outcome: "ignored" }) };
  }
  if (rawOutput.length === 0) {
    return { observation: observation({ ...base, outcome: "non-text" }) };
  }

  const isError = event.isError;
  const errorConfig =
    request.errorConfig ?? DEFAULT_CONTEXT_OUTPUT_CONFIG.errors;
  const selectedLimit = isError
    ? errorResultLimit(errorConfig, pressure)
    : explicitLimitBytes;
  const budgetConfig = isError
    ? parseOutputBrokerConfig({
        hardCeilingBytes: errorConfig.hardCeilingBytes,
      })
    : parseOutputBrokerConfig(brokerConfig);
  const budget = resolveOutputBudget(
    {
      toolName: event.toolName,
      outputClass,
      pressure,
      ...(selectedLimit === undefined
        ? {}
        : { explicitLimitBytes: selectedLimit }),
    },
    budgetConfig,
  );

  if (mode === "shadow") {
    return {
      observation: observation({
        ...base,
        outcome:
          inputBytes > budget.appliedLimitBytes
            ? "would-shorten"
            : isError
              ? "error-preserved"
              : "inline",
        appliedLimitBytes: budget.appliedLimitBytes,
      }),
    };
  }

  // Small errors remain exact and do not create an unnecessary artifact.
  if (isError && inputBytes <= budget.appliedLimitBytes) {
    return {
      observation: observation({
        ...base,
        outcome: "error-preserved",
        appliedLimitBytes: budget.appliedLimitBytes,
      }),
    };
  }

  const metadata: JsonObject = Object.freeze({
    toolCallId: event.toolCallId,
    isError,
    textBlockCount: event.content.filter((block) => block.type === "text")
      .length,
    imageBlockCount: event.content.filter((block) => block.type === "image")
      .length,
  });
  const activeBroker = isError ? (request.errorBroker ?? broker) : broker;
  const envelope = await activeBroker.process({
    toolName: event.toolName,
    outputClass,
    pressure,
    rawOutput,
    ...(selectedLimit === undefined
      ? {}
      : { explicitLimitBytes: selectedLimit }),
    ...(isError
      ? { presentation: "error" as const, recallToolName: "context_recall" }
      : {}),
    metadata,
    tags: isError
      ? ["tool-result", "error-result", outputClass]
      : ["tool-result", outputClass],
  });

  if (envelope.disposition === "fail-open") {
    return {
      envelope,
      observation: observation({
        ...base,
        outcome: "fail-open",
        appliedLimitBytes: envelope.budget.appliedLimitBytes,
        artifactStored: envelope.artifact !== null,
        failOpen: true,
      }),
    };
  }
  if (!envelope.shortened) {
    return {
      envelope,
      observation: observation({
        ...base,
        outcome: isError ? "error-preserved" : "inline",
        appliedLimitBytes: envelope.budget.appliedLimitBytes,
      }),
    };
  }

  return {
    envelope,
    patch: {
      content: replaceTextBlocks(event.content, envelope.output),
      details: patchedDetails(event, envelope),
      isError: event.isError,
      ...(event.usage === undefined ? {} : { usage: event.usage }),
    },
    observation: observation({
      ...base,
      outcome: "shortened",
      deliveredBytes: envelope.metrics.deliveredBytes,
      appliedLimitBytes: envelope.budget.appliedLimitBytes,
      artifactStored: envelope.artifact !== null,
    }),
  };
}

/** Test seam for completion/custom-message brokerage using the same broker. */
export async function brokerText(options: {
  readonly broker: OutputBroker;
  readonly toolName: string;
  readonly outputClass: OutputClass;
  readonly pressure: PressureLevel | null;
  readonly mode: ContextOutputMode;
  readonly output: string;
  readonly explicitLimitBytes?: number;
  readonly metadata?: JsonObject;
  readonly brokerConfig?: OutputBrokerConfigInput;
}) {
  const budget = resolveOutputBudget(
    {
      toolName: options.toolName,
      outputClass: options.outputClass,
      pressure: options.pressure,
      ...(options.explicitLimitBytes === undefined
        ? {}
        : { explicitLimitBytes: options.explicitLimitBytes }),
    },
    parseOutputBrokerConfig(options.brokerConfig),
  );
  if (options.mode !== "enforce") {
    return {
      output: options.output,
      envelope: null,
      wouldShorten: utf8Bytes(options.output) > budget.appliedLimitBytes,
      failOpen: false,
    } as const;
  }
  const envelope = await options.broker.process({
    toolName: options.toolName,
    outputClass: options.outputClass,
    pressure: options.pressure,
    rawOutput: options.output,
    ...(options.explicitLimitBytes === undefined
      ? {}
      : { explicitLimitBytes: options.explicitLimitBytes }),
    metadata: options.metadata,
  });
  return {
    output: envelope.output,
    envelope,
    wouldShorten: envelope.shortened,
    failOpen: envelope.disposition === "fail-open",
  } as const;
}

export function configuredLimit(
  toolName: string,
  config: ContextOutputConfig,
): number | undefined {
  return config.explicitLimitBytes[toolName.trim().toLowerCase()];
}
