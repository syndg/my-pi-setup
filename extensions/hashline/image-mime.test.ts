import assert from "node:assert/strict";
import test from "node:test";
import { detectImageMime } from "./image-mime.ts";

function png(ihdrLength: number) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(ihdrLength, 8);
  buffer.write("IHDR", 12, "ascii");
  return buffer;
}

test("PNG parity requires an exact 13-byte IHDR", () => {
  assert.equal(detectImageMime(png(13)), "image/png");
  assert.equal(detectImageMime(png(12)), null);
  assert.equal(detectImageMime(png(14)), null);
});
