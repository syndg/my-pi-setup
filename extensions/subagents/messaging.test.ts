import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SUBAGENT_MESSAGE_CHARS,
  ParentChildMailbox,
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
