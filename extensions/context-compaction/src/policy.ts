import type {
  CompactionReason,
  ReasonPolicyConfig,
  ResolvedReasonPolicy,
} from "./types.ts";

const DEFAULTS: Readonly<Record<CompactionReason, ResolvedReasonPolicy>> = {
  manual: { reason: "manual", action: "custom", onFailure: "local" },
  threshold: { reason: "threshold", action: "custom", onFailure: "local" },
  // Phase 6A never competes with Pi's tested compact-and-retry overflow path.
  overflow: { reason: "overflow", action: "native", onFailure: "native" },
};

/** Resolve explicit manual/threshold/overflow behavior without lifecycle side effects. */
export function resolveReasonPolicy(
  reason: CompactionReason,
  config: ReasonPolicyConfig = {},
): ResolvedReasonPolicy {
  const configured = config[reason];
  const resolved = { ...DEFAULTS[reason], ...configured, reason };

  // Even experiments that opt into an overflow model call retain native recovery on failure.
  if (reason === "overflow") return { ...resolved, onFailure: "native" };
  return resolved;
}
