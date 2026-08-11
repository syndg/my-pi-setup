import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowSessionGeneration } from "./index.ts";

test("a replaced session rejects the old workflow before broker offer", () => {
  const sessions = createWorkflowSessionGeneration();
  sessions.start("session-a");
  const oldRun = sessions.capture("session-a");
  sessions.start("session-a");

  let brokerOffers = 0;
  const delivery = sessions.runIfCurrent(oldRun, () => {
    brokerOffers++;
    return "offered";
  });

  assert.equal(delivery, undefined);
  assert.equal(brokerOffers, 0);
});
