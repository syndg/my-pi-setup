import type { Usage } from "@earendil-works/pi-ai/compat";
import {
  mergeCheckpoint,
  parseCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
  type CheckpointUpdate,
  type CheckpointValidationIssue,
  type ContextCheckpoint,
} from "../../context-checkpoints/src/index.ts";
import { chooseRetainedBoundary } from "./boundary.ts";
import { buildDeterministicFallback } from "./fallback.ts";
import {
  buildCheckpointSummaryPrompt,
  CHECKPOINT_SUMMARY_SYSTEM_PROMPT,
  serializeBoundedCompactionInput,
} from "./prompt.ts";
import { resolveReasonPolicy } from "./policy.ts";
import type {
  BoundarySelection,
  CheckpointSummaryModel,
  CheckpointVerifier,
  CompactionPrototypeDecision,
  CompactionPrototypeInput,
  ContextCompactionDetails,
  NativeFallbackCode,
} from "./types.ts";
import { combineUsage } from "./usage.ts";

function previousCheckpoint(input: CompactionPrototypeInput):
  | { readonly ok: true; readonly checkpoint?: ContextCheckpoint }
  | {
      readonly ok: false;
      readonly issues: readonly CheckpointValidationIssue[];
    } {
  if (input.previousCheckpoint !== undefined) {
    const validation =
      typeof input.previousCheckpoint === "string"
        ? parseCheckpoint(input.previousCheckpoint)
        : validateCheckpoint(input.previousCheckpoint);
    return validation.ok
      ? { ok: true, checkpoint: validation.checkpoint }
      : { ok: false, issues: validation.issues };
  }
  if (input.previousSummary) {
    const parsed = parseCheckpoint(input.previousSummary);
    if (parsed.ok) return { ok: true, checkpoint: parsed.checkpoint };
  }
  return { ok: true };
}

function checkpointAsUpdate(checkpoint: ContextCheckpoint): CheckpointUpdate {
  const { schemaVersion: _schemaVersion, ...update } = checkpoint;
  return update;
}

function mergeValidatedModelCheckpoint(
  modelCheckpoint: ContextCheckpoint,
  previous: ContextCheckpoint | undefined,
  input: CompactionPrototypeInput,
): ContextCheckpoint {
  const merged = mergeCheckpoint({
    previous,
    updates: {
      ...checkpointAsUpdate(modelCheckpoint),
      ...(input.contextPolicyState
        ? { contextPolicyState: input.contextPolicyState }
        : {}),
    },
  });
  if (!merged.ok)
    throw new Error(merged.issues.map((issue) => issue.message).join("\n"));
  return merged.checkpoint;
}

function failure(options: {
  readonly code: NativeFallbackCode;
  readonly message: string;
  readonly boundary?: BoundarySelection;
  readonly usage?: Usage;
}): CompactionPrototypeDecision {
  return { kind: "native-fallback", ...options };
}

function localResult(options: {
  readonly input: CompactionPrototypeInput;
  readonly boundary: BoundarySelection;
  readonly checkpoint: ContextCheckpoint;
  readonly packet: ReturnType<typeof serializeBoundedCompactionInput>;
  readonly verifier: ContextCompactionDetails["verifier"];
  readonly usage?: Awaited<
    ReturnType<CheckpointSummaryModel["summarize"]>
  >["usage"];
  readonly source: ContextCompactionDetails["source"];
  readonly diagnostics: readonly string[];
}): CompactionPrototypeDecision {
  const summary = serializeCheckpoint(options.checkpoint);
  const result = {
    summary,
    firstKeptEntryId: options.boundary.firstKeptEntryId,
    tokensBefore: options.input.tokensBefore,
    estimatedTokensAfter:
      Math.ceil(Buffer.byteLength(summary, "utf8") / 4) +
      options.boundary.retainedEstimatedTokens,
    ...(options.usage ? { usage: options.usage } : {}),
    details: {
      prototype: "context-compaction/phase-6a",
      checkpointSchema: "context-checkpoint/v1",
      reason: options.input.reason,
      source: options.source,
      retainedEstimatedTokens: options.boundary.retainedEstimatedTokens,
      summarizedEstimatedTokens: options.boundary.summarizedEstimatedTokens,
      isSplitTurn: options.boundary.isSplitTurn,
      verifier: options.verifier,
      inputBytes: options.packet.bytes,
      truncatedInputSections: options.packet.truncatedSections,
    },
  } as const;
  return {
    kind: "custom",
    result,
    checkpoint: options.checkpoint,
    boundary: options.boundary,
    source: options.source,
    diagnostics: options.diagnostics,
  };
}

export function createContextCompactionPrototype(options: {
  readonly model: CheckpointSummaryModel;
  readonly verifier?: CheckpointVerifier;
}) {
  return {
    async compact(
      input: CompactionPrototypeInput,
    ): Promise<CompactionPrototypeDecision> {
      const policy = resolveReasonPolicy(input.reason, input.reasonPolicy);
      if (policy.action === "native") {
        return failure({
          code: "reason-policy",
          message: `${input.reason} compaction remains assigned to native Pi recovery.`,
        });
      }

      const boundary = chooseRetainedBoundary(
        input.entries,
        input.boundary,
        input.summarizeFromEntryId,
      );
      if (!boundary) {
        return failure({
          code: "no-valid-boundary",
          message:
            "No committed retained boundary preserves tool-call/result structure.",
        });
      }

      const previous = previousCheckpoint(input);
      if (!previous.ok) {
        return {
          kind: "native-fallback",
          code: "invalid-previous-checkpoint",
          message:
            "The explicit previous checkpoint is invalid and cannot be silently discarded.",
          validationIssues: previous.issues,
          boundary,
        };
      }

      const packet = serializeBoundedCompactionInput({
        input,
        boundary,
        previousCheckpoint: previous.checkpoint,
      });
      let usage: Awaited<
        ReturnType<CheckpointSummaryModel["summarize"]>
      >["usage"];
      let failureCode: NativeFallbackCode = "model-failure";
      let failureMessage = "Compaction summary model failed.";
      let verifierState: ContextCompactionDetails["verifier"] = "not-run";
      const diagnostics: string[] = [];

      try {
        const response = await options.model.summarize({
          systemPrompt: CHECKPOINT_SUMMARY_SYSTEM_PROMPT,
          prompt: buildCheckpointSummaryPrompt(packet),
          reason: input.reason,
          maxOutputTokens: input.maxOutputTokens ?? 16_384,
          signal: input.signal,
        });
        usage = response.usage;
        const parsed = parseCheckpoint(response.text);
        if (!parsed.ok) {
          failureCode = "malformed-model-output";
          failureMessage = parsed.issues
            .map((issue) => issue.message)
            .join("\n");
          diagnostics.push(failureMessage);
          throw new Error(failureMessage);
        }
        const checkpoint = mergeValidatedModelCheckpoint(
          parsed.checkpoint,
          previous.checkpoint,
          input,
        );

        if (options.verifier) {
          const verification = await options.verifier.verify({
            checkpoint,
            serializedInput: packet.text,
            reason: input.reason,
            firstKeptEntryId: boundary.firstKeptEntryId,
            signal: input.signal,
          });
          usage = combineUsage(usage, verification.usage);
          if (!verification.ok) {
            verifierState = "failed";
            failureCode = "verifier-rejected";
            failureMessage =
              verification.message ??
              "Checkpoint verifier rejected the model output.";
            diagnostics.push(failureMessage);
            throw new Error(failureMessage);
          }
          verifierState = "passed";
        }

        return localResult({
          input,
          boundary,
          checkpoint,
          packet,
          verifier: verifierState,
          usage,
          source: "model",
          diagnostics,
        });
      } catch (error) {
        if (diagnostics.length === 0) {
          failureMessage =
            error instanceof Error ? error.message : String(error);
          diagnostics.push(failureMessage);
        }
        if (policy.onFailure === "native") {
          return failure({
            code: failureCode,
            message: failureMessage,
            boundary,
            usage,
          });
        }
        try {
          const checkpoint = buildDeterministicFallback({
            input,
            boundary,
            previousCheckpoint: previous.checkpoint,
          });
          return localResult({
            input,
            boundary,
            checkpoint,
            packet,
            verifier: verifierState,
            usage,
            source: "local-fallback",
            diagnostics,
          });
        } catch (fallbackError) {
          return failure({
            code: "local-fallback-failed",
            message:
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError),
            boundary,
            usage,
          });
        }
      }
    },
  };
}
