import {
  isGovernorState,
  type PressureLevel,
} from "../../shared/context-governor-state.ts";
import {
  CHILD_TOOL_PROFILE_NAMES,
  type ChildToolProfile,
} from "../../shared/child-session.ts";
import type { BackendName } from "./domain.ts";

export const DELEGATION_GOVERNOR_MAX_AGE_MS = 2 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export type DelegationStateDisposition =
  | "fresh"
  | "missing"
  | "invalid"
  | "wrong-session"
  | "stale"
  | "unknown-pressure";

export type EffectiveDelegationPressure = PressureLevel | "conservative";

/** Explicit child final-report budgets. Unknown governor state uses the red-equivalent row. */
export const DELEGATION_OUTPUT_BUDGET_BYTES: Readonly<
  Record<
    EffectiveDelegationPressure,
    Readonly<Record<ChildToolProfile, number>>
  >
> = Object.freeze({
  green: Object.freeze({
    research: 12_288,
    coding: 16_384,
    review: 12_288,
    minimal: 4_096,
  }),
  yellow: Object.freeze({
    research: 8_192,
    coding: 12_288,
    review: 8_192,
    minimal: 4_096,
  }),
  orange: Object.freeze({
    research: 6_144,
    coding: 8_192,
    review: 6_144,
    minimal: 3_072,
  }),
  red: Object.freeze({
    research: 4_096,
    coding: 6_144,
    review: 4_096,
    minimal: 2_048,
  }),
  emergency: Object.freeze({
    research: 4_096,
    coding: 6_144,
    review: 4_096,
    minimal: 2_048,
  }),
  conservative: Object.freeze({
    research: 4_096,
    coding: 6_144,
    review: 4_096,
    minimal: 2_048,
  }),
});

export interface DelegationPolicy {
  readonly profile: ChildToolProfile;
  readonly pressure: EffectiveDelegationPressure;
  readonly stateDisposition: DelegationStateDisposition;
  readonly outputBudgetBytes: number;
  readonly guidanceActive: boolean;
  /** Injection is child user input, never a parent or child system-prompt rewrite. */
  readonly injectionSurface: "child-user-prompt";
}

function requestedProfile(value: unknown): ChildToolProfile {
  return CHILD_TOOL_PROFILE_NAMES.includes(value as ChildToolProfile)
    ? (value as ChildToolProfile)
    : "coding";
}

export function resolveDelegationPolicy(options: {
  readonly governorState?: unknown;
  readonly sessionId: string;
  readonly requestedProfile?: unknown;
  readonly nowMs?: number;
  readonly maximumAgeMs?: number;
}): DelegationPolicy {
  const profile = requestedProfile(options.requestedProfile);
  const nowMs = options.nowMs ?? Date.now();
  const maximumAgeMs = options.maximumAgeMs ?? DELEGATION_GOVERNOR_MAX_AGE_MS;
  let disposition: DelegationStateDisposition = "fresh";
  let pressure: EffectiveDelegationPressure = "conservative";
  const state = options.governorState;

  if (state === undefined || state === null) disposition = "missing";
  else if (!isGovernorState(state)) disposition = "invalid";
  else if (!options.sessionId || state.sessionId !== options.sessionId)
    disposition = "wrong-session";
  else if (
    state.capturedAtMs <= 0 ||
    nowMs - state.capturedAtMs > maximumAgeMs ||
    state.capturedAtMs - nowMs > MAX_FUTURE_SKEW_MS
  ) {
    disposition = "stale";
  } else if (state.pressure.level === null) disposition = "unknown-pressure";
  else pressure = state.pressure.level;

  return Object.freeze({
    profile,
    pressure,
    stateDisposition: disposition,
    outputBudgetBytes: DELEGATION_OUTPUT_BUDGET_BYTES[pressure][profile],
    guidanceActive: pressure !== "green",
    injectionSurface: "child-user-prompt" as const,
  });
}

function harnessPolicy(harness: BackendName, profile: ChildToolProfile) {
  if (harness === "pi") {
    return `Pi enforces the ${profile} schema allowlist and the recursive-orchestration denylist.`;
  }
  if (harness === "claude") {
    return `Claude Code keeps its native tool policy; ${profile} is task guidance, while native Agent/Task delegation is disabled.`;
  }
  return `Codex keeps its native tool policy; ${profile} is task guidance, while its multi-agent feature is disabled.`;
}

/** Append a bounded execution contract to the child's user task, not any system prompt. */
export function buildDelegatedChildPrompt(options: {
  readonly prompt: string;
  readonly harness: BackendName;
  readonly policy: DelegationPolicy;
}) {
  const { policy } = options;
  const pressure =
    policy.pressure === "conservative"
      ? `conservative fallback (${policy.stateDisposition})`
      : policy.pressure;
  return `${options.prompt}\n\n[Delegated execution contract]\n- Profile: ${policy.profile}. ${harnessPolicy(options.harness, policy.profile)}\n- Context pressure: ${pressure}. Keep the final report at or below ${policy.outputBudgetBytes} UTF-8 bytes.\n- Do not spawn or coordinate other agents/workflows and do not ask the user. Continue only this assigned task.\n- Put large logs, generated data, and broad source listings in durable files; report paths or artifact URIs instead of pasting them.\n- Return these concise sections: Summary; Files changed/reviewed; Decisions and unresolved risks; Validation commands and outcomes; Artifacts.\n- Do not make unrelated edits, commit, build, install, reset, clean, or stash unless the task explicitly authorizes it.`;
}

export function delegatedArtifactReferences(
  sessionFilePath: string | undefined,
): readonly string[] {
  const value = sessionFilePath?.trim();
  return value ? Object.freeze([value]) : Object.freeze([]);
}
