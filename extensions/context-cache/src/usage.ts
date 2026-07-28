import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderRunMetrics } from "./types.ts";

const MAX_PROVIDER_GROUPS = 8;

interface CacheCapabilities {
  readonly read: boolean;
  readonly write: boolean;
}

const CAPABILITIES: Readonly<Record<string, CacheCapabilities>> = Object.freeze(
  {
    "anthropic-messages": { read: true, write: true },
    "bedrock-converse-stream": { read: true, write: true },
    "openai-responses": { read: true, write: true },
    "openai-codex-responses": { read: true, write: true },
    "azure-openai-responses": { read: true, write: true },
    "openai-completions": { read: true, write: true },
    "mistral-conversations": { read: true, write: false },
    "google-generative-ai": { read: true, write: false },
    "google-vertex": { read: true, write: false },
  },
);

export function cacheCapabilities(api: string): Readonly<CacheCapabilities> {
  return CAPABILITIES[api] ?? { read: false, write: false };
}

function validMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface MutableMetrics {
  provider: string;
  api: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheReadAvailability: "reported" | "unavailable";
  cacheWriteAvailability: "reported" | "unavailable";
}

export interface ProviderUsageAccumulator {
  add(message: AssistantMessage): void;
  snapshot(): readonly ProviderRunMetrics[];
  clear(): void;
}

function keyOf(message: AssistantMessage) {
  return `${message.provider}\u0000${message.api}\u0000${message.model}`;
}

export function createProviderUsageAccumulator(
  maximumGroups = MAX_PROVIDER_GROUPS,
): ProviderUsageAccumulator {
  const groups = new Map<string, MutableMetrics>();
  const limit = Math.max(1, Math.floor(maximumGroups));

  return {
    add(message) {
      const usage = message.usage;
      if (!validMetric(usage.input) || !validMetric(usage.output)) return;
      const key = keyOf(message);
      if (!groups.has(key) && groups.size >= limit) return;
      const declared = cacheCapabilities(message.api);
      const readAvailable =
        declared.read || (validMetric(usage.cacheRead) && usage.cacheRead > 0);
      const writeAvailable =
        declared.write ||
        (validMetric(usage.cacheWrite) && usage.cacheWrite > 0);
      const current =
        groups.get(key) ??
        ({
          provider: message.provider,
          api: message.api,
          model: message.model,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: readAvailable ? 0 : null,
          cacheWrite: writeAvailable ? 0 : null,
          cacheReadAvailability: readAvailable ? "reported" : "unavailable",
          cacheWriteAvailability: writeAvailable ? "reported" : "unavailable",
        } satisfies MutableMetrics);
      current.requests += 1;
      current.input += usage.input;
      current.output += usage.output;
      if (readAvailable && validMetric(usage.cacheRead)) {
        current.cacheRead = (current.cacheRead ?? 0) + usage.cacheRead;
        current.cacheReadAvailability = "reported";
      }
      if (writeAvailable && validMetric(usage.cacheWrite)) {
        current.cacheWrite = (current.cacheWrite ?? 0) + usage.cacheWrite;
        current.cacheWriteAvailability = "reported";
      }
      groups.set(key, current);
    },
    snapshot() {
      return Object.freeze(
        [...groups.values()].map((value) => Object.freeze({ ...value })),
      );
    },
    clear() {
      groups.clear();
    },
  };
}

export function cacheRatio(
  providers: readonly ProviderRunMetrics[],
): number | null {
  let cacheRead = 0;
  let eligibleInput = 0;
  let observable = false;
  for (const provider of providers) {
    if (provider.cacheRead === null) continue;
    observable = true;
    cacheRead += provider.cacheRead;
    eligibleInput +=
      provider.input + provider.cacheRead + (provider.cacheWrite ?? 0);
  }
  return observable && eligibleInput > 0 ? cacheRead / eligibleInput : null;
}
