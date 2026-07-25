import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import type { LineOperation } from "./operations.ts";
import { createStreamingPreview } from "./streaming-preview.ts";

const source = "one\ntwo\nthree\nfour\n";
const seenLines = new Set([1, 2, 3, 4]);

const preview = (operations: LineOperation[]) =>
  createStreamingPreview(source, operations, seenLines);

test("streaming preview formats replacements without a full-file diff", () => {
  assert.equal(
    preview([
      {
        op: "replace",
        start: 2,
        end: 3,
        lines: ["TWO", "two-and-a-half"],
      },
    ]),
    "-2 two\n-3 three\n+2 TWO\n+3 two-and-a-half",
  );
});

test("streaming preview formats deletions", () => {
  assert.equal(
    preview([{ op: "delete", start: 2, end: 3 }]),
    "-2 two\n-3 three",
  );
});

test("streaming preview preserves operation order and original anchors", () => {
  assert.equal(
    preview([
      { op: "insert-after", line: 3, lines: ["after three"] },
      { op: "insert-before", line: 2, lines: ["before two"] },
    ]),
    "+4 after three\n+2 before two",
  );
});

test("successive tail-then-head frames grow without rewriting prior rows", () => {
  const tail = preview([{ op: "tail", lines: ["tail"] }]);
  const tailThenHead = preview([
    { op: "tail", lines: ["tail"] },
    { op: "head", lines: ["head"] },
  ]);

  assert.equal(tail, "+5 tail");
  assert.equal(tailThenHead, "+5 tail\n+1 head");
  assert.ok(tailThenHead.startsWith(tail));
});

test("successive out-of-order insert frames keep prior bytes stable", () => {
  const first = preview([
    { op: "insert-after", line: 3, lines: ["after three"] },
  ]);
  const second = preview([
    { op: "insert-after", line: 3, lines: ["after three"] },
    { op: "insert-before", line: 2, lines: ["before two"] },
  ]);

  assert.equal(second, `${first}\n+2 before two`);
});

test("streaming preview validates operation semantics before formatting", () => {
  assert.throws(
    () => preview([{ op: "delete", start: 2, end: 5 }]),
    /outside 1\.\.4/,
  );
});

test("streaming preview rejects an unchanged replacement", () => {
  assert.throws(
    () => preview([{ op: "replace", start: 2, end: 2, lines: ["two"] }]),
    /made no changes/,
  );
});

test("large replacement previews stay on the linear streaming path", () => {
  const lineCount = 4_000;
  const original = Array.from(
    { length: lineCount },
    (_, index) => `old-${index + 1}`,
  ).join("\n");
  const replacements = Array.from(
    { length: lineCount },
    (_, index) => `new-${index + 1}`,
  );
  const started = performance.now();
  const diff = createStreamingPreview(
    original,
    [
      {
        op: "replace",
        start: 1,
        end: lineCount,
        lines: replacements,
      },
    ],
    new Set(Array.from({ length: lineCount }, (_, index) => index + 1)),
  );
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 750, `streaming preview took ${elapsed.toFixed(1)}ms`);
  assert.match(diff, /^-\s*1 old-1/m);
  assert.match(diff, /^\+4000 new-4000$/m);
});

test("newline-heavy maximum-size head previews stay bounded and fast", () => {
  const original = "x\n".repeat(2 * 1024 * 1024);
  const started = performance.now();
  const diff = createStreamingPreview(
    original,
    [{ op: "head", lines: ["head"] }],
    new Set(),
  );
  const elapsed = performance.now() - started;

  assert.equal(diff, "+      1 head");
  assert.ok(elapsed < 150, `head preview took ${elapsed.toFixed(1)}ms`);

  const manyOperations: LineOperation[] = Array.from(
    { length: 100 },
    (_, index) => ({
      op: "insert-after",
      line: index + 1,
      lines: [`inserted-${index + 1}`],
    }),
  );
  const manyStarted = performance.now();
  const manyDiff = createStreamingPreview(
    original,
    manyOperations,
    new Set(Array.from({ length: 100 }, (_, index) => index + 1)),
  );
  const manyElapsed = performance.now() - manyStarted;
  assert.equal(manyDiff.split("\n").length, 100);
  assert.ok(
    manyElapsed < 150,
    `100-operation preview took ${manyElapsed.toFixed(1)}ms`,
  );
});

test("newline-heavy head preview fits a bounded heap", () => {
  const moduleUrl = new URL("./streaming-preview.ts", import.meta.url).href;
  const script = `
    import { createStreamingPreview } from ${JSON.stringify(moduleUrl)};
    const source = "x\\n".repeat(2 * 1024 * 1024);
    process.stdout.write(
      createStreamingPreview(source, [{ op: "head", lines: ["head"] }], new Set()),
    );
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );

  assert.equal(output, "+      1 head");
});
