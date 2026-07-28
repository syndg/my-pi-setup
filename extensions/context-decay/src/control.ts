import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ContextDecayShadowReport } from "./adapter.ts";

export const CONTEXT_DECAY_CONTROL_CHANNEL = "context-decay:control";
export type ContextDecayControlAction = "apply" | "clear";

export interface ContextDecayControlResponse {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly action: ContextDecayControlAction;
  readonly status: "applied" | "cleared" | "denied";
  readonly reason: "enabled" | "private-flag-disabled" | "session-mismatch";
  readonly report?: ContextDecayShadowReport;
}

export interface ContextDecayControlEvent {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly action: ContextDecayControlAction;
  readonly respond: (response: ContextDecayControlResponse) => void;
}

export function isContextDecayControlEvent(
  value: unknown,
): value is ContextDecayControlEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<ContextDecayControlEvent>;
  return (
    event.schemaVersion === 1 &&
    typeof event.sessionId === "string" &&
    event.sessionId.length > 0 &&
    event.sessionId.length <= 256 &&
    (event.action === "apply" || event.action === "clear") &&
    typeof event.respond === "function"
  );
}

export function isContextDecayControlResponse(
  value: unknown,
): value is ContextDecayControlResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<ContextDecayControlResponse>;
  return (
    response.schemaVersion === 1 &&
    typeof response.sessionId === "string" &&
    response.sessionId.length > 0 &&
    response.sessionId.length <= 256 &&
    (response.action === "apply" || response.action === "clear") &&
    (response.status === "applied" ||
      response.status === "cleared" ||
      response.status === "denied") &&
    (response.reason === "enabled" ||
      response.reason === "private-flag-disabled" ||
      response.reason === "session-mismatch")
  );
}

/** Synchronous, single-responder control seam. Null means no authoritative controller claimed it. */
export function requestContextDecayControl(
  events: EventBus,
  request: Readonly<{ sessionId: string; action: ContextDecayControlAction }>,
): ContextDecayControlResponse | null {
  let response: ContextDecayControlResponse | null = null;
  const event: ContextDecayControlEvent = {
    schemaVersion: 1,
    sessionId: request.sessionId,
    action: request.action,
    respond(candidate) {
      if (response !== null || !isContextDecayControlResponse(candidate))
        return;
      if (
        candidate.sessionId !== request.sessionId ||
        candidate.action !== request.action
      )
        return;
      response = Object.freeze({ ...candidate });
    },
  };
  if (!isContextDecayControlEvent(event)) return null;
  events.emit(CONTEXT_DECAY_CONTROL_CHANNEL, event);
  return response;
}
