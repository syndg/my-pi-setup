import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedLiveMessage,
  childMessageDeliveryOptions,
  liveMessageBudgetBytes,
  MAX_SUBAGENT_MESSAGE_CHARS,
  ParentChildMailbox,
  shouldWakeForChildMessage,
} from "./src/messaging.ts";

test("parent messages carry ids and reply instructions", () => {
  const mailbox = new ParentChildMailbox();
  const first = mailbox.createParentMessage("sa-1", "Check the parser too");
  const second = mailbox.createParentMessage("sa-1", "That answers it", "cm-4");

  assert.equal(first.id, "pm-1");
  assert.match(first.prompt, /\[Orchestrator message pm-1\]/);
  assert.match(first.prompt, /reply_to to pm-1/);
  assert.equal(second.id, "pm-2");
  assert.match(second.prompt, /in reply to cm-4/);
});

test("child inbox is bounded and drains in arrival order", () => {
  const mailbox = new ParentChildMailbox(2);
  mailbox.receiveChildMessage("sa-1", "one", "first");
  mailbox.receiveChildMessage("sa-2", "two", "second", "pm-1");
  mailbox.receiveChildMessage("sa-1", "one", "third");

  assert.deepEqual(
    mailbox.drain().map(({ id, subagentId, message, replyTo }) => ({
      id,
      subagentId,
      message,
      replyTo,
    })),
    [
      {
        id: "cm-2",
        subagentId: "sa-2",
        message: "second",
        replyTo: "pm-1",
      },
      {
        id: "cm-3",
        subagentId: "sa-1",
        message: "third",
        replyTo: undefined,
      },
    ],
  );
  assert.deepEqual(mailbox.drain(), []);
});

test("acknowledging live delivery removes only that inbox message", () => {
  const mailbox = new ParentChildMailbox();
  const first = mailbox.receiveChildMessage("sa-1", "one", "first");
  mailbox.receiveChildMessage("sa-2", "two", "second");

  assert.equal(mailbox.acknowledgeChildMessage(first.id), true);
  assert.equal(mailbox.acknowledgeChildMessage(first.id), false);
  assert.deepEqual(
    mailbox.drain().map(({ id, message }) => ({ id, message })),
    [{ id: "cm-2", message: "second" }],
  );
});

test("mailbox rejects empty and oversized messages", () => {
  const mailbox = new ParentChildMailbox();
  assert.throws(() => mailbox.createParentMessage("sa-1", "  "), /empty/);
  assert.throws(
    () =>
      mailbox.receiveChildMessage(
        "sa-1",
        "one",
        "x".repeat(MAX_SUBAGENT_MESSAGE_CHARS + 1),
      ),
    /at most/,
  );
});

test("live messages use the tightest pressure/profile budget", () => {
  const budget = liveMessageBudgetBytes(3_072, 2_048);
  assert.equal(budget, 2_048);
  const bounded = boundedLiveMessage("🙂".repeat(2_000), budget);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= budget);
  assert.match(bounded, /full text remains in subagent_inbox/);
});

test("live message routing steers active replies and wakes every routine delivery", () => {
  const mailbox = new ParentChildMailbox();
  const info = mailbox.receiveChildMessage("sa-1", "one", "progress update");
  const failure = mailbox.receiveChildMessage(
    "sa-1",
    "one",
    "[failure] tests failed",
  );
  const urgent = mailbox.receiveChildMessage(
    "sa-1",
    "one",
    "[urgent] need input",
  );
  const reply = mailbox.receiveChildMessage("sa-1", "one", "answer", "pm-1");
  assert.equal(shouldWakeForChildMessage(info), false);
  assert.equal(shouldWakeForChildMessage(failure), true);
  assert.equal(shouldWakeForChildMessage(urgent), true);
  assert.equal(shouldWakeForChildMessage(reply), true);
  assert.deepEqual(childMessageDeliveryOptions(reply, false), {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.deepEqual(childMessageDeliveryOptions(urgent, false), {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.deepEqual(childMessageDeliveryOptions(info, false), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.deepEqual(childMessageDeliveryOptions(info, true), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.deepEqual(childMessageDeliveryOptions(reply, true), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});
