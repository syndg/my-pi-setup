import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { applyDecayEpoch, planContextDecay } from "./engine.ts";
import type { ContextDecayPrivateConfig } from "./config.ts";
import {
  createAutomaticDecayPolicyState,
  evaluateAutomaticDecayPolicy,
  recordAutomaticDecaySettledRun,
  type AutomaticCacheAdvisorySignal,
  type AutomaticDecayIdentity,
  type AutomaticDecayPolicyDecision,
  type AutomaticDecayPolicyState,
  type AutomaticGovernorSignal,
} from "./automatic-policy.ts";
import type {
  DecayContext,
  DecayedContext,
  DecayMessageInput,
  DecayPlan,
} from "./types.ts";

export const CONTEXT_DECAY_SHADOW_CHANNEL = "context-decay:shadow-report";

export interface ShadowCandidateReport {
  readonly identity: string;
  readonly classification: string;
  readonly estimatedTokens: number;
  readonly selected: boolean;
  readonly blockedReason: string | null;
}

export interface ContextDecayShadowReport {
  readonly schemaVersion: 1;
  readonly mode:
    "shadow" | "explicit-apply-armed" | "explicit-apply" | "automatic-apply";
  readonly epochId: string;
  readonly sessionId: string;
  readonly modelKey: string;
  readonly contextGeneration: string;
  readonly residentTokens: number;
  readonly effectiveWireTokens: number;
  readonly proposedTokensSaved: number;
  readonly candidateCount: number;
  readonly replacementCount: number;
  readonly candidatesLimited: boolean;
  readonly oversizedProtectedTurn: boolean;
  readonly sequenceValid: boolean;
  readonly pressure: string | null;
  readonly candidates: readonly ShadowCandidateReport[];
}

function signature(message: AgentMessage): string {
  return JSON.stringify(message);
}

/**
 * Joins the deep-copied `context` messages back to active session entries.
 * Exact ordered matches receive durable entry IDs. Provider/extension-generated
 * messages that have no entry remain unmapped and use the engine's deterministic
 * synthetic identity. This is the adapter seam context-output may replace with a
 * future first-class Pi message→entry API.
 */
export function mapMessagesToSessionEntries(
  messages: readonly AgentMessage[],
  entries: readonly SessionEntry[],
  durableBranchEntries: readonly SessionEntry[],
): readonly DecayMessageInput[] {
  const projected = entries.flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message) => ({
      entryId: entry.id,
      signature: signature(message),
      message,
    })),
  );
  const durableIds = new Set(durableBranchEntries.map((entry) => entry.id));
  const consumed = new Set<number>();
  let cursor = 0;
  return messages.map((message) => {
    const expected = signature(message);
    let match = -1;
    for (let index = cursor; index < projected.length; index += 1) {
      if (!consumed.has(index) && projected[index]?.signature === expected) {
        match = index;
        break;
      }
    }
    if (match < 0 && message.role === "toolResult") {
      match = projected.findIndex(
        (item, index) =>
          !consumed.has(index) &&
          item?.message.role === "toolResult" &&
          item.message.toolCallId === message.toolCallId,
      );
    }
    if (match < 0) return { message };
    consumed.add(match);
    cursor = Math.max(cursor, match + 1);
    const entryId = projected[match]?.entryId;
    return {
      message,
      entryId,
      entryRecallable: entryId !== undefined && durableIds.has(entryId),
    };
  });
}

export function createShadowReport(
  plan: DecayPlan,
  maximumCandidates: number,
  mode: ContextDecayShadowReport["mode"] = "shadow",
  pressure: string | null = null,
  transformed?: DecayedContext,
): ContextDecayShadowReport {
  const limit = Math.max(1, Math.floor(maximumCandidates));
  const candidates = plan.candidates.slice(0, limit).map((candidate) =>
    Object.freeze({
      identity: candidate.identity,
      classification: candidate.classification,
      estimatedTokens: candidate.estimatedTokens,
      selected: candidate.selected,
      blockedReason: candidate.blockedReason,
    }),
  );
  const actual =
    (mode === "explicit-apply" || mode === "automatic-apply") &&
    transformed !== undefined;
  const accounting = actual ? transformed.accounting : plan.accounting;
  return Object.freeze({
    schemaVersion: 1,
    mode,
    epochId: plan.epoch.id,
    sessionId: plan.epoch.sessionId,
    modelKey: plan.epoch.modelKey,
    contextGeneration: plan.epoch.contextGeneration,
    residentTokens: accounting.residentTokens,
    effectiveWireTokens: accounting.effectiveWireTokens,
    proposedTokensSaved: accounting.proposedTokensSaved,
    candidateCount: plan.candidates.length,
    replacementCount: actual
      ? transformed.transformation.replacementCount
      : plan.epoch.replacementOrder.length,
    candidatesLimited: plan.candidates.length > candidates.length,
    oversizedProtectedTurn: plan.oversizedProtectedTurn,
    sequenceValid:
      plan.inputValidation.valid &&
      plan.outputValidation.valid &&
      (transformed?.validation.valid ?? true),
    pressure,
    candidates: Object.freeze(candidates),
  });
}

export interface ApplyRequestResult {
  readonly applied: boolean;
  readonly reason: "enabled" | "private-flag-disabled";
  readonly plan: DecayPlan;
}

export interface ContextDecayShadowController {
  preview(context: DecayContext): DecayPlan;
  requestExplicitApply(context: DecayContext): ApplyRequestResult;
  transform(context: DecayContext): DecayedContext | null;
  activePlan(): DecayPlan | null;
  reset(): void;
  activeEpochId(): string | null;
}

export function createContextDecayShadowController(
  config: ContextDecayPrivateConfig,
): ContextDecayShadowController {
  let activePlan: DecayPlan | null = null;
  return Object.freeze({
    preview(context: DecayContext) {
      return planContextDecay(context, config);
    },
    requestExplicitApply(context: DecayContext) {
      const plan = planContextDecay(context, config);
      if (!config.allowExplicitApply) {
        return Object.freeze({
          applied: false,
          reason: "private-flag-disabled",
          plan,
        });
      }
      activePlan = plan;
      return Object.freeze({ applied: true, reason: "enabled", plan });
    },
    transform(context: DecayContext) {
      if (activePlan === null) return null;
      const epoch = activePlan.epoch;
      if (
        epoch.sessionId !== context.sessionId ||
        epoch.modelKey !== context.modelKey ||
        epoch.contextGeneration !== context.contextGeneration
      ) {
        activePlan = null;
        return null;
      }
      return applyDecayEpoch(context, epoch);
    },
    activePlan() {
      return activePlan;
    },
    reset() {
      activePlan = null;
    },
    activeEpochId() {
      return activePlan?.epoch.id ?? null;
    },
  });
}

export interface AutomaticDecayConsideration {
  readonly plan: DecayPlan;
  readonly decision: AutomaticDecayPolicyDecision;
  readonly transformed: DecayedContext | null;
}

export interface AutomaticDecayController {
  consider(input: {
    readonly context: DecayContext;
    readonly identity: AutomaticDecayIdentity;
    readonly governor?: AutomaticGovernorSignal | null;
    readonly cacheAdvisory?: AutomaticCacheAdvisorySignal | null;
    readonly nowMs: number;
  }): AutomaticDecayConsideration;
  recordSettledRun(): void;
  activePlan(): DecayPlan | null;
  policyState(): AutomaticDecayPolicyState | null;
  reset(identity: AutomaticDecayIdentity, nowMs: number): void;
}

/** Stateful adapter around the pure policy; all epoch and spacing state is memory-only. */
export function createAutomaticDecayController(
  config: ContextDecayPrivateConfig,
  initial?: Readonly<{ identity: AutomaticDecayIdentity; nowMs: number }>,
): AutomaticDecayController {
  let state =
    initial === undefined
      ? null
      : createAutomaticDecayPolicyState(initial.identity, initial.nowMs);
  let activePlan: DecayPlan | null = null;

  return Object.freeze({
    consider(input: Parameters<AutomaticDecayController["consider"]>[0]) {
      if (state === null)
        state = createAutomaticDecayPolicyState(input.identity, input.nowMs);
      const plan = planContextDecay(input.context, config);
      const decision = evaluateAutomaticDecayPolicy({
        config,
        identity: input.identity,
        state,
        plan,
        activeEpoch: activePlan?.epoch,
        governor: input.governor,
        cacheAdvisory: input.cacheAdvisory,
        nowMs: input.nowMs,
      });
      state = decision.state;
      if (decision.blockers.includes("identity-reset")) activePlan = null;
      if (decision.arm) activePlan = plan;

      const epoch = activePlan?.epoch;
      if (epoch === undefined) {
        return Object.freeze({ plan, decision, transformed: null });
      }
      if (
        epoch.sessionId !== input.context.sessionId ||
        epoch.modelKey !== input.context.modelKey ||
        epoch.contextGeneration !== input.context.contextGeneration
      ) {
        activePlan = null;
        return Object.freeze({ plan, decision, transformed: null });
      }
      const transformed = applyDecayEpoch(input.context, epoch);
      return Object.freeze({ plan, decision, transformed });
    },
    recordSettledRun() {
      if (state !== null) state = recordAutomaticDecaySettledRun(state);
    },
    activePlan() {
      return activePlan;
    },
    policyState() {
      return state;
    },
    reset(identity: AutomaticDecayIdentity, nowMs: number) {
      activePlan = null;
      state = createAutomaticDecayPolicyState(identity, nowMs);
    },
  });
}

export function formatShadowReport(
  report: ContextDecayShadowReport,
  maximumCharacters: number,
): string {
  const lines = [
    `Context decay ${report.mode}: epoch ${report.epochId}`,
    `resident ~${report.residentTokens.toLocaleString("en-US")} tokens; effective wire ~${report.effectiveWireTokens.toLocaleString("en-US")}; proposed savings ~${report.proposedTokensSaved.toLocaleString("en-US")}`,
    `candidates ${report.candidateCount}; replacements ${report.replacementCount}; sequence ${report.sequenceValid ? "valid" : "INVALID"}${report.oversizedProtectedTurn ? "; oversized protected turn" : ""}`,
    ...report.candidates.map(
      (candidate) =>
        `- ${candidate.classification} ${candidate.identity}: ~${candidate.estimatedTokens} (${candidate.selected ? "replace" : (candidate.blockedReason ?? "keep")})`,
    ),
    report.candidatesLimited ? "- …additional candidates omitted" : "",
  ].filter(Boolean);
  const text = lines.join("\n");
  const limit = Math.max(1, Math.floor(maximumCharacters));
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
