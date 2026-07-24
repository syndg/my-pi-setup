import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { readParameters } from "./schema.ts";

test("read offset and limit accept only positive integers", () => {
  for (const field of ["offset", "limit"] as const) {
    assert.equal(Value.Check(readParameters, { path: "a", [field]: 1 }), true);
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.equal(
        Value.Check(readParameters, { path: "a", [field]: value }),
        false,
        `${field} should reject ${value}`,
      );
    }
  }
});
