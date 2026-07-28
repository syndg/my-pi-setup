const DEFAULT_MAX_MESSAGES = 100;
export const MAX_SUBAGENT_MESSAGE_CHARS = 4 * 1024;
const MAX_REPLY_TO_CHARS = 128;

export interface ChildToParentMessage {
  readonly id: string;
  readonly subagentId: string;
  readonly title: string;
  readonly message: string;
  readonly replyTo?: string;
  readonly createdAt: number;
}

export function liveMessageBudgetBytes(
  reportBudgetBytes: number | undefined,
  pressureBudgetBytes: number | undefined,
  maximum = MAX_SUBAGENT_MESSAGE_CHARS,
) {
  return Math.max(
    256,
    Math.min(
      maximum,
      reportBudgetBytes ?? maximum,
      pressureBudgetBytes ?? maximum,
    ),
  );
}

export function boundedLiveMessage(message: string, maxBytes: number) {
  if (Buffer.byteLength(message, "utf8") <= maxBytes) return message;
  const marker =
    "\n[child message truncated; full text remains in subagent_inbox]";
  const target = Math.max(1, maxBytes - Buffer.byteLength(marker, "utf8"));
  let end = Math.min(message.length, target);
  while (end > 0 && Buffer.byteLength(message.slice(0, end), "utf8") > target)
    end--;
  return `${message.slice(0, end)}${marker}`;
}

export function shouldWakeForChildMessage(message: ChildToParentMessage) {
  return (
    message.replyTo !== undefined ||
    /^\s*\[(?:urgent|failure|failed|error)\b/i.test(message.message)
  );
}

export interface ParentToChildMessage {
  readonly id: string;
  readonly prompt: string;
}

export interface ChildMessenger {
  readonly childId: string;
  sendToParent(message: string, replyTo?: string): ChildToParentMessage;
}

function requiredMessage(value: string) {
  const message = value.trim();
  if (!message) throw new Error("message must not be empty.");
  if (message.length > MAX_SUBAGENT_MESSAGE_CHARS) {
    throw new Error(
      `message must be at most ${MAX_SUBAGENT_MESSAGE_CHARS.toLocaleString()} characters.`,
    );
  }
  return message;
}

function optionalReplyTo(value: string | undefined) {
  const replyTo = value?.trim();
  if (!replyTo) return undefined;
  if (replyTo.length > MAX_REPLY_TO_CHARS) {
    throw new Error(
      `reply_to must be at most ${MAX_REPLY_TO_CHARS} characters.`,
    );
  }
  return replyTo;
}

/**
 * Bounded, session-local parent/child mailbox. It owns message ids and wire
 * formatting so tools and backends do not need to coordinate those details.
 */
export class ParentChildMailbox {
  readonly #maxMessages: number;
  readonly #inbox: ChildToParentMessage[] = [];
  #parentSequence = 0;
  #childSequence = 0;

  constructor(maxMessages = DEFAULT_MAX_MESSAGES) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new Error("maxMessages must be a positive integer.");
    }
    this.#maxMessages = maxMessages;
  }

  createParentMessage(
    subagentId: string,
    message: string,
    replyTo?: string,
  ): ParentToChildMessage {
    const id = `pm-${++this.#parentSequence}`;
    const body = requiredMessage(message);
    const reply = optionalReplyTo(replyTo);
    const replyLine = reply ? ` in reply to ${reply}` : "";

    return {
      id,
      prompt:
        `[Orchestrator message ${id}${replyLine}]\n${body}\n\n` +
        `If a response is useful before you finish, call message_orchestrator and set reply_to to ${id}.`,
    };
  }

  receiveChildMessage(
    subagentId: string,
    title: string,
    message: string,
    replyTo?: string,
  ): ChildToParentMessage {
    const received: ChildToParentMessage = {
      id: `cm-${++this.#childSequence}`,
      subagentId,
      title,
      message: requiredMessage(message),
      replyTo: optionalReplyTo(replyTo),
      createdAt: Date.now(),
    };
    this.#inbox.push(received);
    if (this.#inbox.length > this.#maxMessages) {
      this.#inbox.splice(0, this.#inbox.length - this.#maxMessages);
    }
    return received;
  }

  acknowledgeChildMessage(id: string) {
    const index = this.#inbox.findIndex((message) => message.id === id);
    if (index === -1) return false;
    this.#inbox.splice(index, 1);
    return true;
  }

  drain() {
    return this.#inbox.splice(0);
  }

  clear() {
    this.#inbox.length = 0;
  }
}
