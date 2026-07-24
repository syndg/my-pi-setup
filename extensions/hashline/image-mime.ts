import { open } from "node:fs/promises";

/** Adapted from Pi 0.82.0's MIT-licensed image MIME sniffer. */
const SNIFF_BYTES = 4100;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ascii(buffer: Buffer, offset: number, text: string) {
  return (
    buffer.subarray(offset, offset + text.length).toString("ascii") === text
  );
}

function animatedPng(buffer: Buffer) {
  let offset = PNG.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (ascii(buffer, offset + 4, "acTL")) return true;
    if (ascii(buffer, offset + 4, "IDAT")) return false;
    const next = offset + 12 + length;
    if (next <= offset || next > buffer.length) return false;
    offset = next;
  }
  return false;
}

function validBmp(buffer: Buffer) {
  if (buffer.length < 26) return false;
  const size = buffer.readUInt32LE(2);
  const pixels = buffer.readUInt32LE(10);
  const dib = buffer.readUInt32LE(14);
  if (
    (size !== 0 && size < 26) ||
    pixels < 14 + dib ||
    (size !== 0 && pixels >= size)
  ) {
    return false;
  }
  if (dib !== 12 && (dib < 40 || dib > 124)) return false;
  if (dib !== 12 && buffer.length < 30) return false;
  const planes = buffer.readUInt16LE(dib === 12 ? 22 : 26);
  const bits = buffer.readUInt16LE(dib === 12 ? 24 : 28);
  return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}

export function detectImageMime(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (buffer.subarray(0, PNG.length).equals(PNG)) {
    return buffer.length >= 16 &&
      buffer.readUInt32BE(8) === 13 &&
      ascii(buffer, 12, "IHDR") &&
      !animatedPng(buffer)
      ? "image/png"
      : null;
  }
  if (ascii(buffer, 0, "GIF")) return "image/gif";
  if (ascii(buffer, 0, "RIFF") && ascii(buffer, 8, "WEBP")) return "image/webp";
  if (ascii(buffer, 0, "BM") && validBmp(buffer)) return "image/bmp";
  return null;
}

export async function detectImageMimeFromFile(path: string) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return detectImageMime(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
