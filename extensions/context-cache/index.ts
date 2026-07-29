import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Prompt-cache observation is intentionally retired from the live runtime.
 * The metrics-only evaluator remains available for offline tests/reference.
 */
export default function contextCacheExtension(_pi: ExtensionAPI): void {}

export * from "./src/evaluator.ts";
export * from "./src/prefix.ts";
export * from "./src/status.ts";
export * from "./src/telemetry.ts";
export * from "./src/types.ts";
export * from "./src/usage.ts";
