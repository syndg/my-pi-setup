import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLineOperations,
  parseCompleteOperations,
  parseEditInput,
  type LineOperation,
} from "./operations.ts";

const text = "one\ntwo\nthree\nfour\n";
const seen = new Set([1, 2, 3, 4]);

const cases: Array<{
  name: string;
  operations: LineOperation[];
  expected: string;
}> = [
  {
    name: "replace inclusive range",
    operations: [{ op: "replace", start: 2, end: 3, lines: ["TWO", "THREE"] }],
    expected: "one\nTWO\nTHREE\nfour\n",
  },
  {
    name: "delete range",
    operations: [{ op: "delete", start: 2, end: 3 }],
    expected: "one\nfour\n",
  },
  {
    name: "insert around original anchors",
    operations: [
      { op: "insert-before", line: 2, lines: ["before"] },
      { op: "insert-after", line: 3, lines: ["after"] },
    ],
    expected: "one\nbefore\ntwo\nthree\nafter\nfour\n",
  },
  {
    name: "head and tail",
    operations: [
      { op: "head", lines: ["head"] },
      { op: "tail", lines: ["tail"] },
    ],
    expected: "head\none\ntwo\nthree\nfour\ntail\n",
  },
];

for (const fixture of cases) {
  test(fixture.name, () => {
    assert.equal(
      applyLineOperations(text, fixture.operations, seen),
      fixture.expected,
    );
  });
}

for (const fixture of [
  { name: "final newline", text: "only\n" },
  { name: "no final newline", text: "only" },
  { name: "sole blank row", text: "\n" },
]) {
  test(`whole-file deletion yields empty text with ${fixture.name}`, () => {
    assert.equal(
      applyLineOperations(
        fixture.text,
        [{ op: "delete", start: 1, end: 1 }],
        new Set([1]),
      ),
      "",
    );
  });
}

test("head can create content in an empty file", () => {
  assert.equal(
    applyLineOperations("", [{ op: "head", lines: ["created"] }], new Set()),
    "created",
  );
});

test("preflight rejects bounds, overlap, changed anchors, unseen rows, and no-ops", () => {
  assert.throws(
    () => applyLineOperations(text, [{ op: "delete", start: 0, end: 1 }], seen),
    /outside/,
  );
  assert.throws(
    () =>
      applyLineOperations(
        text,
        [
          { op: "delete", start: 2, end: 3 },
          { op: "replace", start: 3, end: 4, lines: ["x"] },
        ],
        seen,
      ),
    /overlaps/,
  );
  assert.throws(
    () =>
      applyLineOperations(
        text,
        [
          { op: "delete", start: 2, end: 2 },
          { op: "insert-before", line: 2, lines: ["x"] },
        ],
        seen,
      ),
    /also replaced or deleted/,
  );
  assert.throws(
    () =>
      applyLineOperations(
        text,
        [{ op: "replace", start: 3, end: 3, lines: ["THREE"] }],
        new Set([1, 2]),
      ),
    /unseen line 3/,
  );
  assert.throws(
    () =>
      applyLineOperations(
        text,
        [{ op: "replace", start: 2, end: 2, lines: ["two"] }],
        seen,
      ),
    /made no changes/,
  );
});

test("strict runtime parser rejects extra fields and malformed destination lines", () => {
  assert.throws(
    () =>
      parseEditInput({
        path: "a.ts",
        tag: "0123456789ABCDEF",
        operations: [{ op: "delete", start: 1, end: 1, lines: [] }],
      }),
    /unexpected field/,
  );
  assert.throws(
    () =>
      parseEditInput({
        path: "a.ts",
        tag: "lowercase12345678",
        operations: [{ op: "head", lines: ["x"] }],
      }),
    /16 uppercase/,
  );
  assert.throws(
    () =>
      parseEditInput({
        path: "a.ts",
        tag: "0123456789ABCDEF",
        operations: [{ op: "head", lines: ["two\nlines"] }],
      }),
    /newline-free/,
  );
});

test("partial parser keeps only a complete structured operation prefix", () => {
  assert.deepEqual(
    parseCompleteOperations([
      { op: "delete", start: 1, end: 1 },
      { op: "replace", start: 2 },
      { op: "head", lines: ["must not pass incomplete predecessor"] },
    ]),
    [{ op: "delete", start: 1, end: 1 }],
  );
});
