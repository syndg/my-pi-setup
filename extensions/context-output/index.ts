import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import {
  createContextArchive,
  createOutputBroker,
  type ContextArchive,
  type OutputBroker,
  terminalSafe,
  type PressureLevel,
} from "../context-archive/src/index.ts";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  isGovernorState,
  type GovernorState,
} from "../shared/context-governor-state.ts";
import {
  brokerText,
  brokerToolResult,
  configuredLimit,
  type BrokerageObservation,
} from "./src/adapter.ts";
import {
  boundedExternalReferences,
  CONTEXT_OUTPUT_COMPLETION_CHANNEL,
  isCompletionBrokerEvent,
  shouldWakeParent,
  type CompletionBrokerEvent,
  type CompletionDeliveryOutcome,
} from "./src/completion.ts";
import {
  configuredOutputClass,
  loadContextOutputConfig,
  type ContextOutputConfig,
} from "./src/config.ts";

export const CONTEXT_OUTPUT_METRICS_CHANNEL = "context-output:metrics";
export const CONTEXT_OUTPUT_METRICS_ENTRY = "context-output-metrics";
const CONFIG_FILE = "config.private.json";

export interface ContextOutputExtensionOptions {
  readonly config?: ContextOutputConfig;
  readonly rootDirectory?: string;
}

export function contextOutputPaths() {
  const root = join(getAgentDir(), "context-output");
  return {
    config: join(root, CONFIG_FILE),
    artifacts: join(root, "artifacts"),
  };
}

function recallText(value: Awaited<ReturnType<ContextArchive["recall"]>>) {
  const next = value.next ? `; next byte offset ${value.next.offsetBytes}` : "";
  return [
    `${value.reference.uri} (${value.returnedBytes} bytes, bytes ${value.range.startByte}-${value.range.endByte}${next})`,
    value.content,
  ].join("\n");
}

function sessionEntryLocator(
  value: string,
  sessionId: string,
  entries: readonly SessionEntry[],
): SessionEntry | null {
  if (!value.startsWith("session-entry://")) {
    return entries.find((entry) => entry.id === value) ?? null;
  }
  const match = /^session-entry:\/\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error("Invalid session-entry URI.");
  let referencedSession: string;
  let entryId: string;
  try {
    referencedSession = decodeURIComponent(match[1] as string);
    entryId = decodeURIComponent(match[2] as string);
  } catch {
    throw new Error("Invalid session-entry URI encoding.");
  }
  if (referencedSession !== sessionId)
    throw new Error("Session-entry URI belongs to another session.");
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry)
    throw new Error(
      `Session entry not found on the active durable branch: ${entryId}`,
    );
  return entry;
}

function boundedSessionEntrySlice(
  entry: SessionEntry,
  uri: string,
  params: {
    readonly offset_bytes?: number;
    readonly max_bytes?: number;
    readonly start_line?: number;
    readonly line_count?: number;
  },
  config: ContextOutputConfig,
) {
  const serialized = terminalSafe(JSON.stringify(entry, null, 2));
  const maximumBytes = Math.min(
    config.recall.maximumBytes,
    Math.max(1, Math.floor(params.max_bytes ?? config.recall.defaultBytes)),
  );
  if (params.start_line !== undefined || params.line_count !== undefined) {
    const startLine = Math.max(1, Math.floor(params.start_line ?? 1));
    const lineCount = Math.min(
      config.recall.maximumLines,
      Math.max(1, Math.floor(params.line_count ?? config.recall.maximumLines)),
    );
    const selected = serialized
      .split("\n")
      .slice(startLine - 1, startLine - 1 + lineCount)
      .join("\n");
    const buffer = Buffer.from(selected, "utf8");
    let end = Math.min(buffer.length, maximumBytes);
    while (
      end > 0 &&
      end < buffer.length &&
      ((buffer[end] as number) & 0xc0) === 0x80
    )
      end -= 1;
    const content = buffer.subarray(0, end).toString("utf8");
    return {
      content,
      details: {
        reference: { kind: "session-entry", id: entry.id, uri },
        range: {
          startLine,
          endLine: startLine + Math.max(0, content.split("\n").length - 1),
        },
        returnedBytes: end,
        truncated:
          end < buffer.length ||
          startLine - 1 + lineCount < serialized.split("\n").length,
      },
    };
  }
  const buffer = Buffer.from(serialized, "utf8");
  let start = Math.min(
    buffer.length,
    Math.max(0, Math.floor(params.offset_bytes ?? 0)),
  );
  while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80)
    start += 1;
  let end = Math.min(buffer.length, start + maximumBytes);
  while (
    end > start &&
    end < buffer.length &&
    ((buffer[end] as number) & 0xc0) === 0x80
  )
    end -= 1;
  return {
    content: buffer.subarray(start, end).toString("utf8"),
    details: {
      reference: { kind: "session-entry", id: entry.id, uri },
      range: { startByte: start, endByte: end },
      returnedBytes: end - start,
      truncated: end < buffer.length,
      next: end < buffer.length ? { kind: "bytes", offsetBytes: end } : null,
    },
  };
}

export function createContextOutputExtension(
  options: ContextOutputExtensionOptions = {},
) {
  return function contextOutputExtension(pi: ExtensionAPI) {
    let config =
      options.config ?? loadContextOutputConfig(contextOutputPaths().config);
    let archive: ContextArchive | undefined;
    let broker: OutputBroker | undefined;
    let errorBroker: OutputBroker | undefined;
    let sessionId = "";
    let governor: GovernorState | undefined;
    let sessionContext: ExtensionContext | undefined;
    let metricEntries = 0;
    let sessionGeneration = 0;

    const pressure = (): PressureLevel | null =>
      governor?.sessionId === sessionId ? governor.pressure.level : null;

    const publish = (value: BrokerageObservation) => {
      if (config.metrics.emitEvents)
        pi.events.emit(CONTEXT_OUTPUT_METRICS_CHANNEL, value);
      if (
        config.metrics.appendEntries &&
        metricEntries < config.metrics.maximumEntriesPerSession
      ) {
        metricEntries += 1;
        // Counts/outcomes only; custom JSONL entries never enter provider context.
        pi.appendEntry(CONTEXT_OUTPUT_METRICS_ENTRY, value);
      }
    };

    const stopGovernor = pi.events.on(CONTEXT_GOVERNOR_CHANNEL, (value) => {
      if (isGovernorState(value)) governor = value;
    });

    const deliverCompletion = async (
      event: CompletionBrokerEvent,
    ): Promise<CompletionDeliveryOutcome> => {
      const activeBroker = broker;
      const activeGeneration = sessionGeneration;
      if (!activeBroker)
        return {
          claimed: true,
          delivered: false,
          accepted: false,
          wokeParent: false,
          deliveryConfirmed: false,
          error: "no active session",
        };
      const result = await brokerText({
        broker: activeBroker,
        toolName: event.toolName,
        outputClass: event.outputClass,
        pressure: pressure(),
        mode: config.mode,
        output: event.output,
        metadata: { completionKind: event.kind, completionId: event.id },
        brokerConfig: config.broker,
      });
      if (
        activeGeneration !== sessionGeneration ||
        activeBroker !== broker ||
        !sessionContext
      ) {
        return {
          claimed: true,
          accepted: false,
          delivered: false,
          deliveryConfirmed: false,
          wokeParent: false,
          error: "completion session changed during brokerage",
        };
      }
      const references = boundedExternalReferences(
        event.externalArtifactReferences,
        config.completions.maximumExternalReferences,
      );
      const lines = [result.output];
      if (references.length > 0)
        lines.push(
          `External artifacts:\n${references.map((ref) => `- ${ref}`).join("\n")}`,
        );
      const wake = shouldWakeParent(event);
      try {
        pi.sendMessage(
          {
            customType: event.customType,
            content: lines.filter(Boolean).join("\n\n"),
            display: true,
            details: {
              ...(event.details ?? {}),
              contextArtifact: result.envelope?.artifact?.reference.uri,
            },
          },
          wake
            ? { deliverAs: "followUp", triggerTurn: true }
            : { deliverAs: "nextTurn", triggerTurn: false },
        );
        return {
          claimed: true,
          accepted: true,
          delivered: true,
          deliveryConfirmed: false,
          wokeParent: wake,
          ...(result.envelope?.artifact
            ? { artifactUri: result.envelope.artifact.reference.uri }
            : {}),
        };
      } catch (error) {
        return {
          claimed: true,
          accepted: false,
          delivered: false,
          deliveryConfirmed: false,
          wokeParent: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const stopCompletion = pi.events.on(
      CONTEXT_OUTPUT_COMPLETION_CHANNEL,
      (value) => {
        if (!config.completions.enabled || !isCompletionBrokerEvent(value))
          return;
        // Claim synchronously before archive I/O. Brokerage failures resolve to
        // a rejected handoff so producers can retain their fallback result.
        value.accept(
          deliverCompletion(value).catch((error) => ({
            claimed: true,
            accepted: false,
            delivered: false,
            deliveryConfirmed: false,
            wokeParent: false,
            error: error instanceof Error ? error.message : String(error),
          })),
        );
      },
    );

    pi.on("session_start", (_event, ctx) => {
      sessionGeneration += 1;
      config =
        options.config ?? loadContextOutputConfig(contextOutputPaths().config);
      sessionId = ctx.sessionManager.getSessionId();
      sessionContext = ctx;
      metricEntries = 0;
      const paths = contextOutputPaths();
      archive = createContextArchive({
        rootDirectory: options.rootDirectory ?? paths.artifacts,
        sessionId,
        defaultRecallBytes: config.recall.defaultBytes,
        maximumRecallBytes: config.recall.maximumBytes,
        maximumRecallLines: config.recall.maximumLines,
        maximumQueryResults: config.recall.maximumQueryResults,
      });
      broker = createOutputBroker({ archive, config: config.broker });
      errorBroker = createOutputBroker({
        archive,
        config: { hardCeilingBytes: config.errors.hardCeilingBytes },
      });
      if (governor?.sessionId !== sessionId) governor = undefined;
    });

    pi.on("session_tree", (_event, ctx) => {
      if (ctx.sessionManager.getSessionId() !== sessionId) governor = undefined;
      sessionContext = ctx;
    });

    pi.on("tool_result", async (event: ToolResultEvent) => {
      if (!broker || !errorBroker || event.toolName === "context_recall")
        return;
      const outputClass = configuredOutputClass(event.toolName, config);
      const result = await brokerToolResult({
        event,
        outputClass,
        pressure: pressure(),
        mode: config.mode,
        broker,
        errorBroker,
        errorConfig: config.errors,
        brokerConfig: config.broker,
        explicitLimitBytes: configuredLimit(event.toolName, config),
      });
      publish(result.observation);
      return result.patch;
    });

    pi.on("session_shutdown", () => {
      sessionGeneration += 1;
      archive = undefined;
      broker = undefined;
      errorBroker = undefined;
      sessionId = "";
      governor = undefined;
      metricEntries = 0;
      sessionContext = undefined;
    });

    pi.registerTool({
      name: "context_recall",
      label: "Recall Context Artifact",
      description:
        "Recall a bounded byte/line slice from this session's context artifact or durable branch entry, or query artifact metadata. Never reads arbitrary paths or returns unbounded content.",
      parameters: Type.Object({
        artifact: Type.Optional(
          Type.String({
            description:
              "Artifact ID/context:// URI, session entry ID, or session-entry:// URI",
          }),
        ),
        query: Type.Optional(
          Type.String({
            description: "Metadata query when artifact is omitted",
          }),
        ),
        offset_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
        max_bytes: Type.Optional(Type.Integer({ minimum: 1 })),
        start_line: Type.Optional(Type.Integer({ minimum: 1 })),
        line_count: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      async execute(_id, params) {
        if (!archive) throw new Error("No active context archive session.");
        const entries = sessionContext?.sessionManager.getBranch?.() ?? [];
        const entry = params.artifact
          ? sessionEntryLocator(params.artifact, sessionId, entries)
          : null;
        if (entry) {
          const uri = `session-entry://${encodeURIComponent(sessionId)}/${encodeURIComponent(entry.id)}`;
          const recalled = boundedSessionEntrySlice(entry, uri, params, config);
          return {
            content: [
              { type: "text" as const, text: `${uri}\n${recalled.content}` },
            ],
            details: recalled.details,
          };
        }
        if (!params.artifact) {
          const queried = await archive.query({
            text: params.query,
            limit: params.limit,
          });
          const text =
            queried.artifacts.length === 0
              ? "No matching context artifacts."
              : queried.artifacts
                  .map(
                    (item) =>
                      `${item.reference.uri} · ${item.metadata.toolName}/${item.metadata.outputClass} · ${item.metadata.storedBytes} bytes · ${item.metadata.synopsis}`,
                  )
                  .join("\n");
          const details: Record<string, unknown> = {
            matched: queried.matched,
            limited: queried.limited,
          };
          return { content: [{ type: "text" as const, text }], details };
        }
        const slice =
          params.start_line !== undefined || params.line_count !== undefined
            ? {
                kind: "lines" as const,
                startLine: params.start_line,
                lineCount: params.line_count,
                maxBytes: params.max_bytes,
              }
            : {
                kind: "bytes" as const,
                offsetBytes: params.offset_bytes,
                maxBytes: params.max_bytes,
              };
        const recalled = await archive.recall({
          artifact: params.artifact,
          slice,
        });
        const details: Record<string, unknown> = {
          reference: recalled.reference,
          range: recalled.range,
          truncated: recalled.truncated,
          next: recalled.next,
        };
        return {
          content: [{ type: "text" as const, text: recallText(recalled) }],
          details,
        };
      },
    });

    // Event-bus listeners are runtime-scoped, but explicit cleanup prevents
    // stale claims in test harnesses that retain a bus across reloads.
    pi.on("session_shutdown", () => {
      stopGovernor();
      stopCompletion();
    });
  };
}

export default createContextOutputExtension();
export * from "./src/adapter.ts";
export * from "./src/completion.ts";
export * from "./src/config.ts";
