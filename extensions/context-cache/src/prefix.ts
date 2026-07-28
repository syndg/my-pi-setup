import { createHmac, randomBytes } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export interface StablePrefixSample {
  readonly fingerprint: string;
  readonly systemFingerprint: string;
  readonly toolFingerprint: string;
  readonly prefixBytes: number;
  readonly activeToolNames: readonly string[];
}

export function createPrefixKey(): Buffer {
  return randomBytes(32);
}

function digest(key: Buffer, value: string) {
  return createHmac("sha256", key)
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function safeToolEncoding(
  activeNames: readonly string[],
  allTools: readonly ToolInfo[],
) {
  const active = new Set(activeNames);
  const tools = allTools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  try {
    return JSON.stringify(tools);
  } catch {
    return JSON.stringify([...activeNames].sort());
  }
}

/** Bodies are HMACed with a process-local key and are never returned or persisted. */
export function stablePrefixSample(
  systemPrompt: string,
  activeToolNames: readonly string[],
  allTools: readonly ToolInfo[],
  key: Buffer,
): Readonly<StablePrefixSample> {
  const names = Object.freeze([...new Set(activeToolNames)].sort());
  const tools = safeToolEncoding(names, allTools);
  const systemFingerprint = digest(key, systemPrompt);
  const toolFingerprint = digest(key, tools);
  return Object.freeze({
    fingerprint: digest(key, `${systemFingerprint}:${toolFingerprint}`),
    systemFingerprint,
    toolFingerprint,
    prefixBytes:
      Buffer.byteLength(systemPrompt, "utf8") +
      Buffer.byteLength(tools, "utf8"),
    activeToolNames: names,
  });
}

export function addedAndRemoved(
  previous: readonly string[],
  next: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((name) => !before.has(name)),
    removed: previous.filter((name) => !after.has(name)),
  };
}
