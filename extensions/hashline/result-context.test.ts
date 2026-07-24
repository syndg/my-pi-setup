import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_POST_EDIT_CONTEXT_LINES,
  formatPostEditResult,
  selectPostEditContext,
} from "./result-context.ts";

test("selects numbered context around disjoint changed regions", () => {
  const before = Array.from(
    { length: 20 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const lines = before.split("\n");
  lines[4] = "changed-five";
  lines[16] = "changed-seventeen";
  const context = selectPostEditContext(before, lines.join("\n"));
  assert.deepEqual(
    context.rows.map((row) => row.line),
    [3, 4, 5, 6, 7, 15, 16, 17, 18, 19],
  );
  assert.equal(context.truncated, false);
});

test("large post-edit context is bounded and explicitly requires read", () => {
  const before = Array.from({ length: 100 }, (_, index) => `old-${index}`).join(
    "\n",
  );
  const after = Array.from({ length: 100 }, (_, index) => `new-${index}`).join(
    "\n",
  );
  const context = selectPostEditContext(before, after);
  assert.equal(context.rows.length, MAX_POST_EDIT_CONTEXT_LINES);
  assert.equal(context.truncated, true);
  const output = formatPostEditResult({
    path: "a.ts",
    tag: "0123456789ABCDEF",
    operationCount: 1,
    ...context,
  });
  assert.match(output, /^Successfully applied/);
  assert.match(output, /\[a\.ts#0123456789ABCDEF\]/);
  assert.match(output, /context was truncated; call read/);
});
