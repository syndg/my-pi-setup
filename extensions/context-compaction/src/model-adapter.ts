import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  CheckpointSummaryModel,
  SummaryModelRequest,
  SummaryModelResponse,
} from "./types.ts";

export type SummaryReasoningLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Structurally compatible with summaries/src/config.ts SummaryConfig. */
export interface DedicatedSummaryModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: SummaryReasoningLevel;
  readonly timeoutMs?: number;
}

function responseText(
  content: Awaited<ReturnType<typeof completeSimple>>["content"],
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Dedicated summary-model adapter; it registers no Pi events and owns no configuration files. */
export function createPiCheckpointSummaryModel(options: {
  readonly modelRegistry: ModelRegistry;
  readonly config: DedicatedSummaryModelConfig;
}): CheckpointSummaryModel {
  return {
    async summarize(
      request: SummaryModelRequest,
    ): Promise<SummaryModelResponse> {
      const model = options.modelRegistry.find(
        options.config.provider,
        options.config.model,
      );
      if (!model) {
        throw new Error(
          `Compaction summary model is unavailable: ${options.config.provider}/${options.config.model}`,
        );
      }
      const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const maximum =
        model.maxTokens > 0 ? model.maxTokens : request.maxOutputTokens;
      const response = await completeSimple(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [
            {
              role: "user",
              content: request.prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          env: auth.env,
          headers: auth.headers,
          maxTokens: Math.min(maximum, request.maxOutputTokens),
          maxRetries: 1,
          signal: request.signal,
          timeoutMs: options.config.timeoutMs ?? 60_000,
          cacheRetention: "none",
          sessionId: randomUUID(),
          ...(options.config.reasoning === "off"
            ? {}
            : { reasoning: options.config.reasoning }),
        },
      );
      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted"
      ) {
        throw new Error(
          response.errorMessage ?? "Compaction summary model request failed.",
        );
      }
      return { text: responseText(response.content), usage: response.usage };
    },
  };
}
