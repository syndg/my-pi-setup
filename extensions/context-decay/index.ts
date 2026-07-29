import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Request-time context decay is intentionally retired from the live runtime.
 * Native proactive compaction and recoverable output bounding own context
 * reduction; the pure engine remains available for offline tests/reference.
 */
export default function contextDecayExtension(_pi: ExtensionAPI): void {}

export * from "./src/adapter.ts";
export * from "./src/config.ts";
export * from "./src/engine.ts";
export * from "./src/types.ts";
export * from "./src/control.ts";
export * from "./src/automatic-policy.ts";
