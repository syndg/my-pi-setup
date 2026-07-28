import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_OUTPUT_COMPLETION_CHANNEL,
  isCompletionBrokerEvent,
  offerCompletion,
  shouldWakeParent,
} from "./src/completion.ts";

const request = {
  kind: "workflow" as const,
  id: "wf-1",
  title: "review",
  status: "success" as const,
  output: "done",
  toolName: "workflow_completion",
  outputClass: "subagent-final" as const,
  customType: "workflow-result",
};

test("completion claim is synchronous while delivery is asynchronous", async () => {
  const bus = createEventBus();
  bus.on(CONTEXT_OUTPUT_COMPLETION_CHANNEL, (value) => {
    assert.equal(isCompletionBrokerEvent(value), true);
    if (isCompletionBrokerEvent(value)) {
      value.accept(
        Promise.resolve({ claimed: true, delivered: true, wokeParent: false }),
      );
    }
  });
  const delivery = offerCompletion(bus, request);
  assert.ok(delivery);
  assert.deepEqual(await delivery, {
    claimed: true,
    delivered: true,
    wokeParent: false,
  });
});

test("unclaimed producers retain their legacy delivery path", () => {
  assert.equal(offerCompletion(createEventBus(), request), null);
});

test("routine success does not wake; wait, failure, and urgency do", () => {
  assert.equal(shouldWakeParent({ status: "success" }), false);
  assert.equal(shouldWakeParent({ status: "success", waited: true }), true);
  assert.equal(shouldWakeParent({ status: "success", urgent: true }), true);
  assert.equal(shouldWakeParent({ status: "failure" }), true);
});
