import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
  JsonObject,
  OutputClass,
} from "../../context-archive/src/index.ts";

export const CONTEXT_OUTPUT_COMPLETION_CHANNEL = "context-output:completion";

export type CompletionKind = "subagent" | "background-terminal" | "workflow";
export type CompletionStatus = "success" | "failure" | "killed";

export interface CompletionDeliveryOutcome {
  readonly claimed: true;
  readonly delivered: boolean;
  readonly wokeParent: boolean;
  readonly artifactUri?: string;
  readonly error?: string;
}

export interface CompletionBrokerRequest {
  readonly kind: CompletionKind;
  readonly id: string;
  readonly title: string;
  readonly status: CompletionStatus;
  readonly output: string;
  readonly toolName: string;
  readonly outputClass: OutputClass;
  readonly customType: string;
  readonly details?: JsonObject;
  readonly externalArtifactReferences?: readonly string[];
  /** Existing producers may set this only when their own interface exposes urgency. */
  readonly urgent?: boolean;
  /** Explicit waits normally return a tool result and do not use this channel. */
  readonly waited?: boolean;
}

export interface CompletionBrokerEvent extends CompletionBrokerRequest {
  /** Must be called synchronously by exactly one listener. */
  readonly accept: (delivery: Promise<CompletionDeliveryOutcome>) => void;
}

function isRequest(value: unknown): value is CompletionBrokerRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<CompletionBrokerRequest>;
  return (
    (request.kind === "subagent" ||
      request.kind === "background-terminal" ||
      request.kind === "workflow") &&
    (request.status === "success" ||
      request.status === "failure" ||
      request.status === "killed") &&
    typeof request.id === "string" &&
    typeof request.title === "string" &&
    typeof request.output === "string" &&
    typeof request.toolName === "string" &&
    typeof request.outputClass === "string" &&
    typeof request.customType === "string"
  );
}

export function isCompletionBrokerEvent(
  value: unknown,
): value is CompletionBrokerEvent {
  return (
    isRequest(value) &&
    typeof (value as CompletionBrokerEvent).accept === "function"
  );
}

/**
 * Synchronous claim + asynchronous result handshake over Pi's synchronous
 * event bus. A null return means no adapter claimed the completion.
 */
export function offerCompletion(
  events: EventBus,
  request: CompletionBrokerRequest,
): Promise<CompletionDeliveryOutcome> | null {
  let delivery: Promise<CompletionDeliveryOutcome> | null = null;
  let accepted = false;
  const event: CompletionBrokerEvent = {
    ...request,
    accept(candidate) {
      if (accepted) return;
      accepted = true;
      delivery = candidate;
    },
  };
  events.emit(CONTEXT_OUTPUT_COMPLETION_CHANNEL, event);
  return delivery;
}

export function shouldWakeParent(
  request: Pick<CompletionBrokerRequest, "status" | "urgent" | "waited">,
) {
  return (
    request.status === "failure" ||
    request.urgent === true ||
    request.waited === true
  );
}

export function boundedExternalReferences(
  values: readonly string[] | undefined,
  maximum: number,
): readonly string[] {
  if (values === undefined) return [];
  return [
    ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  ]
    .slice(0, maximum)
    .map((value) => (value.length <= 512 ? value : `${value.slice(0, 511)}…`));
}
