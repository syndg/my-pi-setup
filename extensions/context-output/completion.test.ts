import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_OUTPUT_COMPLETION_CHANNEL,
  completeWithFallback,
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
        Promise.resolve({
          claimed: true,
          accepted: true,
          delivered: true,
          deliveryConfirmed: false,
          wokeParent: true,
        }),
      );
    }
  });
  const delivery = offerCompletion(bus, request);
  assert.ok(delivery);
  assert.deepEqual(await delivery, {
    claimed: true,
    accepted: true,
    delivered: true,
    deliveryConfirmed: false,
    wokeParent: true,
  });
});

test("unclaimed producers retain their legacy delivery path", () => {
  assert.equal(offerCompletion(createEventBus(), request), null);
});

test("broker promise rejection preserves the producer fallback", async () => {
  let fallbacks = 0;
  await completeWithFallback(
    Promise.reject(new Error("broker archive failed")),
    () => {
      fallbacks += 1;
    },
  );
  assert.equal(fallbacks, 1);
});

test("an accepted broker handoff suppresses the producer fallback", async () => {
  let fallbacks = 0;
  await completeWithFallback(
    Promise.resolve({
      claimed: true,
      accepted: true,
      delivered: true,
      deliveryConfirmed: false,
      wokeParent: true,
    }),
    () => {
      fallbacks += 1;
    },
  );
  assert.equal(fallbacks, 0);
});

test("every unsolicited completion wakes the parent", () => {
  assert.equal(shouldWakeParent({ status: "success" }), true);
  assert.equal(shouldWakeParent({ status: "success", waited: true }), true);
  assert.equal(shouldWakeParent({ status: "success", urgent: true }), true);
  assert.equal(shouldWakeParent({ status: "failure" }), true);
});
