import {
  DEFAULT_OUTPUT_BROKER_CONFIG,
  parseOutputBrokerConfig,
  resolveOutputBudget,
  type OutputBrokerConfig,
  type OutputBrokerConfigInput,
} from "./config.ts";
import { conciseLabel, lineCount, utf8Bytes, utf8Prefix } from "./safe-text.ts";
import type {
  ContextArchive,
  OutputBroker,
  OutputEnvelope,
  OutputMetrics,
  OutputRequest,
  StoredArtifact,
} from "./types.ts";

export interface OutputBrokerOptions {
  readonly archive: ContextArchive;
  readonly config?: OutputBrokerConfig | OutputBrokerConfigInput;
  readonly estimateTokens?: (value: string) => number;
  /** Metrics-only seam for the governor adapter. Exceptions are ignored. */
  readonly onMetrics?: (metrics: OutputMetrics) => void;
}

function defaultTokenEstimate(value: string): number {
  return Math.ceil(utf8Bytes(value) / 4);
}

function tokenEstimate(
  estimator: (value: string) => number,
  value: string,
): number {
  try {
    const estimate = estimator(value);
    return Number.isFinite(estimate) && estimate >= 0
      ? Math.floor(estimate)
      : defaultTokenEstimate(value);
  } catch {
    return defaultTokenEstimate(value);
  }
}

function errorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return conciseLabel(message, 240) || "artifact persistence failed";
}

function retrievalInstructions(
  artifact: StoredArtifact,
  request: OutputRequest,
): string {
  const recallToolName = conciseLabel(request.recallToolName ?? "", 80);
  if (recallToolName) {
    return `Use ${recallToolName} with artifact: ${artifact.reference.uri} to retrieve bounded slices.`;
  }
  return `Recall ${artifact.reference.uri} with ContextArchive.recall({ artifact, slice: { kind: "bytes" | "lines", ... } }); full content: ${artifact.reference.path}`;
}

function compactMarker(
  artifact: StoredArtifact,
  request: OutputRequest,
  inputBytes: number,
  limitBytes: number,
): string {
  if (request.presentation === "error") {
    const recallToolName = conciseLabel(
      request.recallToolName ?? "context_recall",
      80,
    );
    return utf8Prefix(
      [
        `[Oversized error (${inputBytes} bytes) archived.`,
        `Use ${recallToolName} with artifact: ${artifact.reference.uri} for bounded recall.]`,
        `Error synopsis: ${artifact.metadata.synopsis}`,
      ].join("\n"),
      limitBytes,
    );
  }
  return utf8Prefix(
    `[Archived ${inputBytes} bytes from ${
      conciseLabel(request.toolName, 80) || "tool"
    }: ${artifact.reference.uri}]`,
    limitBytes,
  );
}

async function replacementText(
  archive: ContextArchive,
  artifact: StoredArtifact,
  request: OutputRequest,
  inputBytes: number,
  limitBytes: number,
  reason: string,
): Promise<string> {
  if (limitBytes <= 0) return "";
  const instructions = retrievalInstructions(artifact, request);
  const required =
    request.presentation === "error"
      ? [
          `[Oversized tool error archived before shortening: ${reason}]`,
          `Tool: ${conciseLabel(request.toolName, 120) || "unknown-tool"}`,
          `Original: ${inputBytes} bytes; stored: ${artifact.metadata.storedBytes} bytes; lines: ${artifact.metadata.storedLines}`,
          `Error synopsis: ${artifact.metadata.synopsis}`,
          `Artifact: ${artifact.reference.uri}`,
          `Recall: ${instructions}`,
        ].join("\n")
      : [
          `[Output archived before shortening: ${reason}]`,
          `Tool: ${conciseLabel(request.toolName, 120) || "unknown-tool"}`,
          `Original: ${inputBytes} bytes; stored: ${artifact.metadata.storedBytes} bytes; lines: ${artifact.metadata.storedLines}`,
          `Synopsis: ${artifact.metadata.synopsis}`,
          `Artifact: ${artifact.reference.uri}`,
          `Path: ${artifact.reference.path}`,
          `Recall: ${instructions}`,
        ].join("\n");
  const requiredBytes = utf8Bytes(required);
  if (requiredBytes > limitBytes) {
    return compactMarker(artifact, request, inputBytes, limitBytes);
  }

  const separator = "\n--- bounded preview ---\n";
  const previewBudget = limitBytes - requiredBytes - utf8Bytes(separator);
  if (previewBudget <= 0) return required;
  const preview = await archive.recall({
    artifact: artifact.reference.uri,
    slice: { kind: "bytes", offsetBytes: 0, maxBytes: previewBudget },
  });
  if (preview.content.length === 0) return required;
  return utf8Prefix(`${required}${separator}${preview.content}`, limitBytes);
}

function buildMetrics(input: {
  readonly request: OutputRequest;
  readonly outputClass: OutputMetrics["outputClass"];
  readonly pressure: OutputMetrics["pressure"];
  readonly delivered: string;
  readonly inputBytes: number;
  readonly artifactBytes: number;
  readonly artifactStored: boolean;
  readonly failOpen: boolean;
  readonly estimator: (value: string) => number;
}): OutputMetrics {
  const deliveredBytes = utf8Bytes(input.delivered);
  const estimatedInputTokens = tokenEstimate(
    input.estimator,
    input.request.rawOutput,
  );
  const estimatedDeliveredTokens = tokenEstimate(
    input.estimator,
    input.delivered,
  );
  return Object.freeze({
    toolName: conciseLabel(input.request.toolName, 160) || "unknown-tool",
    outputClass: input.outputClass,
    pressure: input.pressure,
    inputBytes: input.inputBytes,
    deliveredBytes,
    artifactBytes: input.artifactBytes,
    bytesSaved: Math.max(0, input.inputBytes - deliveredBytes),
    estimatedInputTokens,
    estimatedDeliveredTokens,
    estimatedTokensSaved: Math.max(
      0,
      estimatedInputTokens - estimatedDeliveredTokens,
    ),
    artifactStored: input.artifactStored,
    failOpen: input.failOpen,
  });
}

class ArchiveOutputBroker implements OutputBroker {
  readonly #archive: ContextArchive;
  readonly #config: OutputBrokerConfig;
  readonly #estimateTokens: (value: string) => number;
  readonly #onMetrics: ((metrics: OutputMetrics) => void) | undefined;

  constructor(options: OutputBrokerOptions) {
    this.#archive = options.archive;
    this.#config =
      options.config === undefined
        ? DEFAULT_OUTPUT_BROKER_CONFIG
        : parseOutputBrokerConfig(options.config);
    this.#estimateTokens = options.estimateTokens ?? defaultTokenEstimate;
    this.#onMetrics = options.onMetrics;
  }

  async process(request: OutputRequest): Promise<OutputEnvelope> {
    if (typeof request.rawOutput !== "string") {
      throw new TypeError("rawOutput must be a string");
    }
    const budget = resolveOutputBudget(request, this.#config);
    const inputBytes = utf8Bytes(request.rawOutput);
    const baseCounts = {
      inputBytes,
      inputCharacters: request.rawOutput.length,
      inputLines: lineCount(request.rawOutput),
    };

    if (inputBytes <= budget.appliedLimitBytes) {
      const metrics = buildMetrics({
        request,
        outputClass: budget.outputClass,
        pressure: budget.pressure,
        delivered: request.rawOutput,
        inputBytes,
        artifactBytes: 0,
        artifactStored: false,
        failOpen: false,
        estimator: this.#estimateTokens,
      });
      this.#publish(metrics);
      return Object.freeze({
        disposition: "inline",
        output: request.rawOutput,
        shortened: false,
        synopsis: conciseLabel(request.rawOutput.split("\n")[0] ?? "", 240),
        counts: Object.freeze({
          ...baseCounts,
          deliveredBytes: metrics.deliveredBytes,
        }),
        truncationReason: null,
        retrievalInstructions: null,
        artifact: null,
        budget,
        metrics,
        persistenceError: null,
      });
    }

    let artifact: StoredArtifact | null = null;
    try {
      // Durability invariant: await the complete atomic store and durable index
      // before computing or returning any replacement.
      artifact = await this.#archive.store({
        content: request.rawOutput,
        toolName: request.toolName,
        outputClass: budget.outputClass,
        tags: request.tags,
        metadata: request.metadata,
      });
      const reason =
        budget.appliedLimitBytes === 0
          ? `${budget.pressure} status-only policy`
          : `output exceeds ${budget.appliedLimitBytes}-byte ${budget.pressure} budget`;
      const output = await replacementText(
        this.#archive,
        artifact,
        request,
        inputBytes,
        budget.appliedLimitBytes,
        reason,
      );
      const metrics = buildMetrics({
        request,
        outputClass: budget.outputClass,
        pressure: budget.pressure,
        delivered: output,
        inputBytes,
        artifactBytes: artifact.metadata.storedBytes,
        artifactStored: true,
        failOpen: false,
        estimator: this.#estimateTokens,
      });
      this.#publish(metrics);
      return Object.freeze({
        disposition: "archived",
        output,
        shortened: true,
        synopsis: artifact.metadata.synopsis,
        counts: Object.freeze({
          ...baseCounts,
          deliveredBytes: metrics.deliveredBytes,
        }),
        truncationReason: reason,
        retrievalInstructions: retrievalInstructions(artifact, request),
        artifact,
        budget,
        metrics,
        persistenceError: null,
      });
    } catch (error) {
      // Fail open: an adapter receives the exact original output. The mode and
      // error are explicit so persistence failure can never look like success.
      const metrics = buildMetrics({
        request,
        outputClass: budget.outputClass,
        pressure: budget.pressure,
        delivered: request.rawOutput,
        inputBytes,
        artifactBytes: artifact?.metadata.storedBytes ?? 0,
        artifactStored: artifact !== null,
        failOpen: true,
        estimator: this.#estimateTokens,
      });
      this.#publish(metrics);
      return Object.freeze({
        disposition: "fail-open",
        output: request.rawOutput,
        shortened: false,
        synopsis: conciseLabel(request.rawOutput.split("\n")[0] ?? "", 240),
        counts: Object.freeze({
          ...baseCounts,
          deliveredBytes: metrics.deliveredBytes,
        }),
        truncationReason: null,
        retrievalInstructions:
          artifact === null ? null : retrievalInstructions(artifact, request),
        artifact,
        budget,
        metrics,
        persistenceError: errorLabel(error),
      });
    }
  }

  #publish(metrics: OutputMetrics): void {
    try {
      this.#onMetrics?.(metrics);
    } catch {
      // Metrics are observational and must not affect output delivery.
    }
  }
}

export function createOutputBroker(options: OutputBrokerOptions): OutputBroker {
  return new ArchiveOutputBroker(options);
}
