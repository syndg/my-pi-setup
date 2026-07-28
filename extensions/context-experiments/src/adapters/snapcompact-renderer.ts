import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { BenchmarkCase, BenchmarkMessageRole } from "../types.ts";

export type SnapcompactTextKind =
  "message-text" | "tool-call" | "tool-result" | "image-reference";

export interface SnapcompactTextIndexEntry {
  readonly id: string;
  readonly ordinal: number;
  readonly messageId: string;
  readonly role: BenchmarkMessageRole;
  readonly kind: SnapcompactTextKind;
  readonly utf8Bytes: number;
  readonly textSha256: string;
  readonly frameIds: readonly string[];
  readonly artifactUris: readonly string[];
}

export interface SnapcompactArtifactReference {
  readonly uri: string;
  readonly messageIds: readonly string[];
  readonly textIndexIds: readonly string[];
}

export interface SnapcompactFrame {
  readonly id: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly alt: string;
  readonly sourceTextIndexIds: readonly string[];
  readonly artifactUris: readonly string[];
  readonly png: Uint8Array;
}

export interface RenderedSnapcompactContext {
  readonly frames: readonly SnapcompactFrame[];
  readonly textIndex: readonly SnapcompactTextIndexEntry[];
  readonly artifactReferences: readonly SnapcompactArtifactReference[];
  /** Renderer-supplied observation; the deterministic renderer deliberately reports zero. */
  readonly latencyMs: number;
}

export interface SnapcompactFrameRenderer {
  render(
    fixture: BenchmarkCase,
  ): Promise<RenderedSnapcompactContext> | RenderedSnapcompactContext;
}

export interface DeterministicRendererOptions {
  readonly columns?: number;
  readonly rowsPerFrame?: number;
}

interface SourceEntry {
  readonly id: string;
  readonly ordinal: number;
  readonly messageId: string;
  readonly role: BenchmarkMessageRole;
  readonly kind: SnapcompactTextKind;
  readonly text: string;
  readonly artifactUris: readonly string[];
}

interface IndexedRow {
  readonly text: string;
  readonly entryId?: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ARTIFACT_PATTERN =
  /context:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*/g;
const GLYPHS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 4, 4, 8],
  ":": [0, 12, 12, 0, 12, 12, 0],
  ";": [0, 12, 12, 0, 4, 4, 8],
  "!": [4, 4, 4, 4, 4, 0, 4],
  "?": [14, 17, 1, 2, 4, 0, 4],
  "-": [0, 0, 0, 31, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  "/": [1, 2, 2, 4, 8, 8, 16],
  "\\": [16, 8, 8, 4, 2, 2, 1],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  "[": [14, 8, 8, 8, 8, 8, 14],
  "]": [14, 2, 2, 2, 2, 2, 14],
  "{": [3, 4, 4, 24, 4, 4, 3],
  "}": [24, 4, 4, 3, 4, 4, 24],
  "<": [2, 4, 8, 16, 8, 4, 2],
  ">": [8, 4, 2, 1, 2, 4, 8],
  "=": [0, 31, 0, 31, 0, 0, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  "*": [0, 17, 10, 31, 10, 17, 0],
  "#": [10, 31, 10, 10, 31, 10, 0],
  "@": [14, 17, 23, 21, 23, 16, 14],
  $: [4, 15, 20, 14, 5, 30, 4],
  "%": [24, 25, 2, 4, 8, 19, 3],
  "&": [12, 18, 20, 8, 21, 18, 13],
  "|": [4, 4, 4, 4, 4, 4, 4],
  "'": [4, 4, 8, 0, 0, 0, 0],
  '"': [10, 10, 20, 0, 0, 0, 0],
  "`": [8, 4, 0, 0, 0, 0, 0],
  "~": [0, 0, 9, 22, 0, 0, 0],
  "^": [4, 10, 17, 0, 0, 0, 0],
});

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array) {
  const type = Buffer.from(name, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([length, type, data, checksum]);
}

function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const destination = y * (width + 1);
    scanlines[destination] = 0;
    scanlines.set(pixels.subarray(y * width, (y + 1) * width), destination + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderRows(
  rows: readonly string[],
  columns: number,
  rowCount: number,
) {
  const cellWidth = 6;
  const cellHeight = 8;
  const padding = 8;
  const width = columns * cellWidth + padding * 2;
  const height = rowCount * cellHeight + padding * 2;
  const pixels = new Uint8Array(width * height);
  pixels.fill(255);
  rows.slice(0, rowCount).forEach((line, rowIndex) => {
    Array.from(line)
      .slice(0, columns)
      .forEach((character, columnIndex) => {
        const glyph = GLYPHS[character.toUpperCase()] ?? [
          31, 17, 21, 21, 21, 17, 31,
        ];
        glyph.forEach((bits, glyphRow) => {
          for (let glyphColumn = 0; glyphColumn < 5; glyphColumn += 1) {
            if ((bits & (1 << (4 - glyphColumn))) === 0) continue;
            const x = padding + columnIndex * cellWidth + glyphColumn;
            const y = padding + rowIndex * cellHeight + glyphRow;
            pixels[y * width + x] = 0;
          }
        });
      });
  });
  return { width, height, png: encodeGrayscalePng(width, height, pixels) };
}

function canonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return String(value);
}

function artifactUris(text: string, explicit?: string) {
  const found = [...(text.match(ARTIFACT_PATTERN) ?? [])].map((uri) =>
    uri.replace(/[.,;:!?]+$/u, ""),
  );
  if (explicit !== undefined) found.push(explicit);
  return Object.freeze(
    found.filter((uri, index) => found.indexOf(uri) === index),
  );
}

function sourceEntries(fixture: BenchmarkCase) {
  const entries: SourceEntry[] = [];
  const add = (
    messageId: string,
    role: BenchmarkMessageRole,
    kind: SnapcompactTextKind,
    text: string,
    explicitArtifact?: string,
  ) => {
    entries.push(
      Object.freeze({
        id: `text-${String(entries.length + 1).padStart(6, "0")}`,
        ordinal: entries.length,
        messageId,
        role,
        kind,
        text,
        artifactUris: artifactUris(text, explicitArtifact),
      }),
    );
  };
  for (const message of fixture.messages) {
    if (message.text !== undefined)
      add(message.id, message.role, "message-text", message.text);
    for (const call of message.toolCalls ?? []) {
      add(
        message.id,
        message.role,
        "tool-call",
        `tool=${call.name}\ncallId=${call.id}\narguments=${JSON.stringify(canonical(call.arguments))}`,
      );
    }
    if (message.toolResult !== undefined) {
      const result = message.toolResult;
      add(
        message.id,
        message.role,
        "tool-result",
        `tool=${result.name}\ncallId=${result.callId}\nisError=${String(result.isError)}\ncontent:\n${result.content}`,
        result.artifactUri,
      );
    }
    for (const image of message.images ?? []) {
      add(
        message.id,
        message.role,
        "image-reference",
        `image=${image.id}\nmimeType=${image.mimeType}\nsourceBytes=${image.bytes}\nalt=${image.alt}`,
      );
    }
  }
  return Object.freeze(entries);
}

function wrapEntry(entry: SourceEntry, columns: number): readonly IndexedRow[] {
  const header = `[${entry.id} message=${entry.messageId} role=${entry.role} kind=${entry.kind}]`;
  const rows: IndexedRow[] = [{ text: header, entryId: entry.id }];
  for (const rawLine of entry.text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine.replace(/\t/gu, "    ");
    const characters = Array.from(line);
    if (characters.length === 0) rows.push({ text: "", entryId: entry.id });
    for (let offset = 0; offset < characters.length; offset += columns) {
      rows.push({
        text: characters.slice(offset, offset + columns).join(""),
        entryId: entry.id,
      });
    }
  }
  rows.push({ text: "", entryId: entry.id });
  return Object.freeze(rows);
}

function unique<T>(values: readonly T[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function createDeterministicSnapcompactRenderer(
  options: DeterministicRendererOptions = {},
): SnapcompactFrameRenderer {
  const columns = options.columns ?? 152;
  const rowsPerFrame = options.rowsPerFrame ?? 80;
  if (!Number.isInteger(columns) || columns < 32)
    throw new Error(
      "Snapcompact renderer columns must be an integer of at least 32.",
    );
  if (!Number.isInteger(rowsPerFrame) || rowsPerFrame < 8)
    throw new Error(
      "Snapcompact rowsPerFrame must be an integer of at least 8.",
    );

  return Object.freeze({
    render(fixture: BenchmarkCase): RenderedSnapcompactContext {
      const entries = sourceEntries(fixture);
      const contentRows = entries.flatMap((entry) => wrapEntry(entry, columns));
      if (contentRows.length === 0)
        contentRows.push({ text: "[empty provider-neutral context]" });
      const pageCapacity = rowsPerFrame - 2;
      const pageCount = Math.ceil(contentRows.length / pageCapacity);
      const frameSources = new Map<string, string[]>();
      const frames: SnapcompactFrame[] = [];

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const id = `snapcompact:${fixture.id}:frame-${String(pageIndex + 1).padStart(4, "0")}`;
        const page = contentRows.slice(
          pageIndex * pageCapacity,
          (pageIndex + 1) * pageCapacity,
        );
        const sourceIds = unique(
          page.flatMap((row) =>
            row.entryId === undefined ? [] : [row.entryId],
          ),
        );
        const artifacts = unique(
          sourceIds.flatMap(
            (sourceId) =>
              entries.find((entry) => entry.id === sourceId)?.artifactUris ??
              [],
          ),
        );
        frameSources.set(id, sourceIds);
        const heading = `SNAPCOMPACT ${fixture.id} FRAME ${pageIndex + 1}/${pageCount}`;
        const bitmap = renderRows(
          [heading, "", ...page.map((row) => row.text)],
          columns,
          rowsPerFrame,
        );
        const png = bitmap.png;
        frames.push(
          Object.freeze({
            id,
            mimeType: "image/png" as const,
            width: bitmap.width,
            height: bitmap.height,
            bytes: png.byteLength,
            sha256: createHash("sha256").update(png).digest("hex"),
            alt: `Snapcompact bitmap frame ${pageIndex + 1} of ${pageCount} for ${fixture.id}`,
            sourceTextIndexIds: Object.freeze(sourceIds),
            artifactUris: Object.freeze(artifacts),
            png,
          }),
        );
      }

      const textIndex = entries.map((entry) =>
        Object.freeze({
          id: entry.id,
          ordinal: entry.ordinal,
          messageId: entry.messageId,
          role: entry.role,
          kind: entry.kind,
          utf8Bytes: Buffer.byteLength(entry.text, "utf8"),
          textSha256: createHash("sha256")
            .update(entry.text, "utf8")
            .digest("hex"),
          frameIds: Object.freeze(
            frames
              .filter((frame) => frameSources.get(frame.id)?.includes(entry.id))
              .map((frame) => frame.id),
          ),
          artifactUris: entry.artifactUris,
        }),
      );
      const allUris = unique(entries.flatMap((entry) => entry.artifactUris));
      const artifactReferences = allUris.map((uri) =>
        Object.freeze({
          uri,
          messageIds: Object.freeze(
            unique(
              entries
                .filter((entry) => entry.artifactUris.includes(uri))
                .map((entry) => entry.messageId),
            ),
          ),
          textIndexIds: Object.freeze(
            entries
              .filter((entry) => entry.artifactUris.includes(uri))
              .map((entry) => entry.id),
          ),
        }),
      );

      return Object.freeze({
        frames: Object.freeze(frames),
        textIndex: Object.freeze(textIndex),
        artifactReferences: Object.freeze(artifactReferences),
        latencyMs: 0,
      });
    },
  });
}

/** Deterministic, dependency-free default for experiments; it is not a production renderer registration. */
export const deterministicSnapcompactRenderer =
  createDeterministicSnapcompactRenderer();
