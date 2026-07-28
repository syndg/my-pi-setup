import { createHash } from "node:crypto";

export const CONTEXT_WIRE_STATE_CHANNEL = "context-decay:wire-accounting";

export type ContextWireMode = "shadow" | "armed" | "applied";
export type ContextWireProvenance =
  "shadow-plan" | "explicit-apply-plan" | "explicit-apply-transform";

/**
 * Stable, metadata-only seam between context-decay and accounting consumers.
 * An `applied` state is authoritative only when `stable` is true and the
 * consumer matches its full session/model/generation/context identity.
 */
export interface ContextWireState {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly mode: ContextWireMode;
  readonly stable: boolean;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly modelKey: string;
  readonly contextGeneration: string;
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly residentTokens: number;
  readonly effectiveWireTokens: number;
  readonly tokensSaved: number;
  readonly epochId: string;
  readonly cacheEpochId: string;
  readonly provenance: ContextWireProvenance;
  readonly candidateCount: number;
  readonly actionCount: number;
  readonly sequenceValid: boolean;
  readonly inputMessageCount: number;
  readonly outputMessageCount: number;
}

export type ContextWireMatch = "input" | "output" | null;

export interface ContextWireIdentity {
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly modelKey: string;
  readonly contextGeneration: string;
  readonly contextFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function contextWireFingerprint(messages: readonly unknown[]): string {
  const encoded = JSON.stringify(messages);
  return `ctx-${createHash("sha256").update(encoded, "utf8").digest("hex").slice(0, 32)}`;
}

export function contextWireModelKey(
  model: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
  } | null,
): string {
  return model === null
    ? "no-model"
    : `${model.provider}/${model.id}/${model.contextWindow}`;
}

export function isContextWireState(value: unknown): value is ContextWireState {
  if (!isRecord(value)) return false;
  const mode = value.mode;
  const provenance = value.provenance;
  if (
    value.schemaVersion !== 1 ||
    !nonNegativeInteger(value.sequence) ||
    (mode !== "shadow" && mode !== "armed" && mode !== "applied") ||
    typeof value.stable !== "boolean" ||
    !nonEmpty(value.sessionId) ||
    (value.branchLeafId !== null && typeof value.branchLeafId !== "string") ||
    !nonEmpty(value.modelKey) ||
    !nonEmpty(value.contextGeneration) ||
    !nonEmpty(value.inputFingerprint) ||
    !nonEmpty(value.outputFingerprint) ||
    !nonNegativeInteger(value.residentTokens) ||
    !nonNegativeInteger(value.effectiveWireTokens) ||
    !nonNegativeInteger(value.tokensSaved) ||
    !nonEmpty(value.epochId) ||
    !nonEmpty(value.cacheEpochId) ||
    (provenance !== "shadow-plan" &&
      provenance !== "explicit-apply-plan" &&
      provenance !== "explicit-apply-transform") ||
    !nonNegativeInteger(value.candidateCount) ||
    !nonNegativeInteger(value.actionCount) ||
    typeof value.sequenceValid !== "boolean" ||
    !nonNegativeInteger(value.inputMessageCount) ||
    !nonNegativeInteger(value.outputMessageCount)
  ) {
    return false;
  }
  if (
    value.effectiveWireTokens > value.residentTokens ||
    value.tokensSaved !== value.residentTokens - value.effectiveWireTokens ||
    value.actionCount > value.candidateCount ||
    value.inputMessageCount !== value.outputMessageCount
  ) {
    return false;
  }
  if (mode === "applied") {
    return (
      value.stable &&
      value.sequenceValid &&
      provenance === "explicit-apply-transform"
    );
  }
  if (value.stable) return false;
  return mode === "shadow"
    ? provenance === "shadow-plan"
    : provenance === "explicit-apply-plan";
}

export function createContextWireState(
  value: Omit<ContextWireState, "schemaVersion">,
): Readonly<ContextWireState> {
  const state: ContextWireState = { schemaVersion: 1, ...value };
  if (!isContextWireState(state)) {
    throw new Error("Invalid context wire accounting state");
  }
  return Object.freeze(state);
}

export function matchContextWireState(
  state: Readonly<ContextWireState> | null,
  identity: Readonly<ContextWireIdentity>,
): ContextWireMatch {
  if (
    state === null ||
    state.sessionId !== identity.sessionId ||
    state.branchLeafId !== identity.branchLeafId ||
    state.modelKey !== identity.modelKey ||
    state.contextGeneration !== identity.contextGeneration
  ) {
    return null;
  }
  if (state.outputFingerprint === identity.contextFingerprint) return "output";
  if (state.inputFingerprint === identity.contextFingerprint) return "input";
  return null;
}

export function newerContextWireState(
  current: Readonly<ContextWireState> | null,
  candidate: unknown,
): Readonly<ContextWireState> | null {
  if (!isContextWireState(candidate)) return current;
  if (
    current !== null &&
    current.sessionId === candidate.sessionId &&
    current.modelKey === candidate.modelKey &&
    current.contextGeneration === candidate.contextGeneration &&
    candidate.sequence <= current.sequence
  ) {
    return current;
  }
  return Object.freeze({ ...candidate });
}

export function isAppliedContextWireState(
  state: Readonly<ContextWireState> | null | undefined,
): state is Readonly<ContextWireState> {
  return state?.mode === "applied" && state.stable && state.sequenceValid;
}
