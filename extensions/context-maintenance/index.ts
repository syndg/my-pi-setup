import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The pressure-maintenance menu is intentionally retired. Native proactive
 * compaction and overflow recovery own routine context pressure; explicit
 * handoff remains available through the context-handoff extension.
 */
export default function contextMaintenanceExtension(_pi: ExtensionAPI): void {}

export * from "./src/config.ts";
export * from "./src/policy.ts";
