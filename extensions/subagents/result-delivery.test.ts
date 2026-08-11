import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";

const first = { id: "sa-1", runSequence: 1, output: "first" };
const second = { id: "sa-1", runSequence: 2, output: "second" };

test("a wait reservation atomically owns a deferred exact run", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  const owner = delivery.createToolOwner("wait");
  delivery.defer(first);

  assert.deepEqual(delivery.reserve(owner, [first]), [
    { run: first, ownership: "tool" },
  ]);
  assert.deepEqual(delivery.beginAutomaticDelivery(), []);
  delivery.consume(owner, [first]);

  assert.deepEqual(
    delivery.reserve(delivery.createToolOwner("wait"), [first]),
    [{ run: first, ownership: "consumed" }],
  );
});

test("automatic in-flight ownership prevents a wait from returning that run", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  delivery.defer(first);
  const [automatic] = delivery.beginAutomaticDelivery();
  assert.ok(automatic);

  assert.deepEqual(
    delivery.reserve(delivery.createToolOwner("wait"), [first]),
    [{ run: first, ownership: "automatic" }],
  );

  automatic.retry();
  const [retry] = delivery.beginAutomaticDelivery();
  assert.ok(retry);
  assert.equal(retry.result, first);
  retry.complete();

  assert.deepEqual(
    delivery.reserve(delivery.createToolOwner("wait"), [first]),
    [{ run: first, ownership: "automatic" }],
  );
});

test("aborting a cancel reservation leaves its exact settlement deliverable", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  const owner = delivery.createToolOwner("cancel");
  assert.deepEqual(delivery.reserve(owner, [first]), [
    { run: first, ownership: "tool" },
  ]);
  delivery.defer(first);
  assert.deepEqual(delivery.beginAutomaticDelivery(), []);

  delivery.release(owner, [first]);
  const [automatic] = delivery.beginAutomaticDelivery();
  assert.ok(automatic);
  assert.equal(automatic.result, first);
});

test("repeated runs for one child retain distinct lifecycle keys", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  delivery.defer(first);
  delivery.defer(second);
  delivery.reserve(delivery.createToolOwner("wait"), [second]);

  const automatic = delivery.beginAutomaticDelivery();
  assert.deepEqual(
    automatic.map((claim) => claim.result),
    [first],
  );
});

test("concurrent waits cannot both own the same exact run", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  const firstWait = delivery.createToolOwner("wait");
  const secondWait = delivery.createToolOwner("wait");

  assert.equal(delivery.reserve(firstWait, [first])[0]?.ownership, "tool");
  assert.equal(
    delivery.reserve(secondWait, [first])[0]?.ownership,
    "other-tool",
  );
});

test("newer runs prune only older terminal delivery tombstones", () => {
  const delivery = createDeferredResultDelivery<typeof first>();

  for (let runSequence = 1; runSequence <= 100; runSequence++) {
    const run = { ...first, runSequence };
    delivery.defer(run);
    const [automatic] = delivery.beginAutomaticDelivery();
    assert.ok(automatic);
    automatic.complete();
  }
  assert.equal(delivery.stateSizeForTests(), 1);

  const wait = delivery.createToolOwner("wait");
  const consumed = { ...first, runSequence: 101 };
  delivery.reserve(wait, [consumed]);
  delivery.consume(wait, [consumed]);
  assert.equal(delivery.stateSizeForTests(), 1);

  delivery.reserve(delivery.createToolOwner("wait"), [
    { ...first, runSequence: 102 },
  ]);
  assert.equal(delivery.stateSizeForTests(), 1);
});

test("terminal tombstones are globally bounded across unique children", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  for (let index = 1; index <= 1_000; index++) {
    const run = { ...first, id: `sa-${index}` };
    delivery.defer(run);
    const [automatic] = delivery.beginAutomaticDelivery();
    assert.ok(automatic);
    automatic.complete();
  }
  assert.ok(delivery.stateSizeForTests() <= 256);
});

test("newer runs retain older pending, reserved, and automatic in-flight state", () => {
  const delivery = createDeferredResultDelivery<typeof first>();
  delivery.defer(first);
  delivery.defer(second);
  const automatic = delivery.beginAutomaticDelivery();
  assert.equal(automatic.length, 2);

  const third = { ...first, runSequence: 3 };
  delivery.reserve(delivery.createToolOwner("wait"), [third]);
  const fourth = { ...first, runSequence: 4 };
  delivery.defer(fourth);

  assert.equal(delivery.stateSizeForTests(), 4);
});
