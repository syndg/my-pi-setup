import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeText,
  encodeText,
  joinLogicalText,
  splitLogicalText,
} from "./text.ts";

for (const fixture of [
  { name: "LF", raw: "alpha\nbeta\n" },
  { name: "CRLF", raw: "alpha\r\nbeta\r\n" },
  { name: "BOM CRLF", raw: "\uFEFFalpha\r\nbeta\r\n" },
  { name: "no final newline", raw: "alpha\nbeta" },
  { name: "Unicode tabs and blanks", raw: "λ\tvalue\n\n" },
]) {
  test(`round-trips ${fixture.name} fidelity`, () => {
    const decoded = decodeText(Buffer.from(fixture.raw));
    assert.equal(encodeText(decoded.normalized, decoded.fidelity), fixture.raw);
  });
}

test("rejects malformed UTF-8, NUL text, and bare carriage returns", () => {
  assert.throws(() => decodeText(Buffer.from([0xc3, 0x28])), /UTF-8/);
  assert.throws(() => decodeText(Buffer.from("safe\0unsafe")), /NUL/);
  assert.throws(() => decodeText(Buffer.from("one\rtwo")), /carriage return/);
});

test("logical line model preserves final-newline intent without a phantom row", () => {
  assert.deepEqual(splitLogicalText("a\n"), {
    lines: ["a"],
    finalNewline: true,
  });
  assert.deepEqual(splitLogicalText(""), { lines: [], finalNewline: false });
  assert.equal(
    joinLogicalText({ lines: ["a", ""], finalNewline: true }),
    "a\n\n",
  );
  assert.equal(joinLogicalText({ lines: [], finalNewline: true }), "");
});
