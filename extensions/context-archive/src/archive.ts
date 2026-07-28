import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { redactCommonSecrets } from "./redaction.ts";
import {
  conciseLabel,
  lineCount,
  safeBufferSlice,
  terminalSafe,
  utf8Bytes,
} from "./safe-text.ts";
import type {
  ArchivableOutput,
  ArchiveQuery,
  ArchiveQueryResult,
  ArtifactMetadata,
  ArtifactReference,
  ContextArchive,
  JsonObject,
  RecallRequest,
  RecallResult,
  Redactor,
  StoredArtifact,
} from "./types.ts";

const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const SESSION_SCOPE_PATTERN = /^[a-f0-9]{24}$/;
const MAX_CREATE_ATTEMPTS = 8;
const SCHEMA_VERSION = 1;

export interface ContextArchiveOptions {
  readonly rootDirectory: string;
  readonly sessionId: string;
  readonly redactor?: Redactor;
  readonly clock?: () => number;
  readonly idGenerator?: () => string;
  readonly defaultRecallBytes?: number;
  readonly maximumRecallBytes?: number;
  readonly maximumRecallLines?: number;
  readonly maximumQueryResults?: number;
  readonly maximumMetadataBytes?: number;
}

interface NormalizedOptions {
  readonly rootDirectory: string;
  readonly sessionScope: string;
  readonly redactor: Redactor;
  readonly clock: () => number;
  readonly idGenerator: () => string;
  readonly defaultRecallBytes: number;
  readonly maximumRecallBytes: number;
  readonly maximumRecallLines: number;
  readonly maximumQueryResults: number;
  readonly maximumMetadataBytes: number;
}

function normalizePositive(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function sessionScopeFor(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  return createHash("sha256")
    .update(sessionId, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function defaultArtifactId(): string {
  return `${Date.now().toString(36)}-${randomBytes(10).toString("hex")}`;
}

function normalizeOptions(options: ContextArchiveOptions): NormalizedOptions {
  if (!isAbsolute(options.rootDirectory)) {
    throw new TypeError("rootDirectory must be absolute");
  }
  const maximumRecallBytes = normalizePositive(
    options.maximumRecallBytes,
    64 * 1024,
  );
  return {
    rootDirectory: resolve(options.rootDirectory),
    sessionScope: sessionScopeFor(options.sessionId),
    redactor: options.redactor ?? redactCommonSecrets,
    clock: options.clock ?? Date.now,
    idGenerator: options.idGenerator ?? defaultArtifactId,
    defaultRecallBytes: Math.min(
      maximumRecallBytes,
      normalizePositive(options.defaultRecallBytes, 16 * 1024),
    ),
    maximumRecallBytes,
    maximumRecallLines: normalizePositive(options.maximumRecallLines, 500),
    maximumQueryResults: normalizePositive(options.maximumQueryResults, 100),
    maximumMetadataBytes: normalizePositive(
      options.maximumMetadataBytes,
      32 * 1024,
    ),
  };
}

function artifactUri(sessionScope: string, id: string): string {
  return `context://${sessionScope}/${id}`;
}

function referenceFor(
  options: NormalizedOptions,
  id: string,
): ArtifactReference {
  return Object.freeze({
    id,
    uri: artifactUri(options.sessionScope, id),
    path: join(
      options.rootDirectory,
      options.sessionScope,
      "artifacts",
      id,
      "content.txt",
    ),
    sessionScope: options.sessionScope,
  });
}

function artifactIdFrom(value: string, sessionScope: string): string {
  if (ARTIFACT_ID_PATTERN.test(value)) return value;
  const match =
    /^context:\/\/([a-f0-9]{24})\/([a-z0-9][a-z0-9_-]{0,79})$/i.exec(value);
  if (match === null) {
    throw new TypeError("artifact must be a safe artifact ID or context URI");
  }
  if (match[1]?.toLowerCase() !== sessionScope) {
    throw new TypeError("artifact URI belongs to a different session");
  }
  return match[2] as string;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function durableExclusiveWrite(
  path: string,
  content: string | Buffer,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeTags(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  return Object.freeze(
    [
      ...new Set(
        values.map((value) => conciseLabel(String(value), 80)).filter(Boolean),
      ),
    ]
      .slice(0, 32)
      .sort(),
  );
}

function synopsisOf(content: string): string {
  const firstMeaningful = terminalSafe(content)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return conciseLabel(firstMeaningful ?? "(empty output)", 240);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateRedacted(
  value: Awaited<ReturnType<Redactor>>,
): asserts value is {
  readonly content: string;
  readonly metadata: JsonObject;
  readonly redactionCount: number;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.content !== "string" ||
    typeof value.metadata !== "object" ||
    value.metadata === null ||
    Array.isArray(value.metadata) ||
    !Number.isSafeInteger(value.redactionCount) ||
    value.redactionCount < 0
  ) {
    throw new TypeError("redactor returned an invalid result");
  }
}

function parseMetadata(
  value: unknown,
  expectedId: string,
  scope: string,
): ArtifactMetadata {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION ||
    (value as { id?: unknown }).id !== expectedId ||
    (value as { sessionScope?: unknown }).sessionScope !== scope
  ) {
    throw new Error(`Invalid artifact metadata for ${expectedId}`);
  }
  return value as ArtifactMetadata;
}

function requestedMaximum(
  requested: number | undefined,
  fallback: number,
  hardMaximum: number,
): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return fallback;
  }
  return Math.min(hardMaximum, Math.floor(requested));
}

function lineStartOffsets(buffer: Buffer): number[] {
  const offsets = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a && index + 1 < buffer.length)
      offsets.push(index + 1);
  }
  return offsets;
}

class FileContextArchive implements ContextArchive {
  readonly #options: NormalizedOptions;
  readonly #sessionDirectory: string;
  readonly #artifactsDirectory: string;
  readonly #indexPath: string;
  #storeQueue: Promise<void> = Promise.resolve();

  constructor(options: ContextArchiveOptions) {
    this.#options = normalizeOptions(options);
    this.#sessionDirectory = join(
      this.#options.rootDirectory,
      this.#options.sessionScope,
    );
    this.#artifactsDirectory = join(this.#sessionDirectory, "artifacts");
    this.#indexPath = join(this.#sessionDirectory, "index.jsonl");
  }

  async store(output: ArchivableOutput): Promise<StoredArtifact> {
    const previous = this.#storeQueue;
    let release = () => {};
    this.#storeQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await this.#store(output);
    } finally {
      release();
    }
  }

  async #store(output: ArchivableOutput): Promise<StoredArtifact> {
    if (typeof output.content !== "string") {
      throw new TypeError("artifact content must be a string");
    }
    const redacted = await this.#options.redactor({
      content: output.content,
      metadata: output.metadata ?? {},
    });
    validateRedacted(redacted);

    const contentBuffer = Buffer.from(redacted.content, "utf8");
    const toolName = conciseLabel(output.toolName, 160) || "unknown-tool";
    const tags = safeTags(output.tags);
    const sourceMetadataJson = JSON.stringify(redacted.metadata);
    if (utf8Bytes(sourceMetadataJson) > this.#options.maximumMetadataBytes) {
      throw new RangeError("artifact metadata exceeds maximumMetadataBytes");
    }

    await mkdir(this.#artifactsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#sessionDirectory, 0o700);
    await chmod(this.#artifactsDirectory, 0o700);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const id = this.#options.idGenerator();
      if (!ARTIFACT_ID_PATTERN.test(id)) {
        throw new TypeError("idGenerator returned an unsafe artifact ID");
      }
      const finalDirectory = join(this.#artifactsDirectory, id);
      if (await pathExists(finalDirectory)) continue;

      const reference = referenceFor(this.#options, id);
      const metadata: ArtifactMetadata = Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        id,
        sessionScope: this.#options.sessionScope,
        createdAtMs: Math.max(0, Math.floor(this.#options.clock())),
        toolName,
        outputClass: output.outputClass,
        tags,
        synopsis: synopsisOf(redacted.content),
        originalBytes: utf8Bytes(output.content),
        storedBytes: contentBuffer.length,
        storedLines: lineCount(redacted.content),
        storedSha256: sha256(contentBuffer),
        redactionCount: redacted.redactionCount,
        sourceMetadata: redacted.metadata,
      });
      const metadataJson = `${JSON.stringify(metadata)}\n`;
      if (utf8Bytes(metadataJson) > this.#options.maximumMetadataBytes) {
        throw new RangeError(
          "serialized artifact metadata exceeds maximumMetadataBytes",
        );
      }

      const temporaryDirectory = join(
        this.#artifactsDirectory,
        `.${id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        await mkdir(temporaryDirectory, { mode: 0o700 });
        await durableExclusiveWrite(
          join(temporaryDirectory, "content.txt"),
          contentBuffer,
        );
        await durableExclusiveWrite(
          join(temporaryDirectory, "metadata.json"),
          metadataJson,
        );
        await syncDirectory(temporaryDirectory);
        await rename(temporaryDirectory, finalDirectory);
        await syncDirectory(this.#artifactsDirectory);
        // The index is deliberately last. A broker cannot replace output until
        // store resolves, and store resolves only after this durable append.
        await appendDurable(this.#indexPath, metadataJson);
        await syncDirectory(this.#sessionDirectory);
        return Object.freeze({ reference, metadata });
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    }
    throw new Error("could not allocate a unique artifact ID");
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const id = artifactIdFrom(request.artifact, this.#options.sessionScope);
    const reference = referenceFor(this.#options, id);
    const artifactDirectory = join(this.#artifactsDirectory, id);
    const [metadataText, contentBuffer] = await Promise.all([
      readFile(join(artifactDirectory, "metadata.json"), "utf8"),
      readFile(join(artifactDirectory, "content.txt")),
    ]);
    const metadata = parseMetadata(
      JSON.parse(metadataText) as unknown,
      id,
      this.#options.sessionScope,
    );
    if (
      metadata.storedBytes !== contentBuffer.length ||
      metadata.storedSha256 !== sha256(contentBuffer)
    ) {
      throw new Error(`Artifact integrity check failed for ${id}`);
    }

    const slice = request.slice;
    let requestedStart = 0;
    let maximum = this.#options.defaultRecallBytes;
    let startLine: number | undefined;
    let endLine: number | undefined;

    if (slice?.kind === "bytes") {
      requestedStart = Math.max(0, Math.floor(slice.offsetBytes ?? 0));
      maximum = requestedMaximum(
        slice.maxBytes,
        this.#options.defaultRecallBytes,
        this.#options.maximumRecallBytes,
      );
    } else if (slice?.kind === "lines") {
      const offsets = lineStartOffsets(contentBuffer);
      startLine = Math.min(
        Math.max(1, Math.floor(slice.startLine ?? 1)),
        Math.max(1, offsets.length),
      );
      const lineCountLimit = Math.min(
        this.#options.maximumRecallLines,
        Math.max(
          1,
          Math.floor(slice.lineCount ?? this.#options.maximumRecallLines),
        ),
      );
      requestedStart = offsets[startLine - 1] ?? contentBuffer.length;
      const requestedEnd =
        offsets[startLine - 1 + lineCountLimit] ?? contentBuffer.length;
      maximum = Math.min(
        requestedEnd - requestedStart,
        requestedMaximum(
          slice.maxBytes,
          this.#options.defaultRecallBytes,
          this.#options.maximumRecallBytes,
        ),
      );
    }

    const selected = safeBufferSlice(contentBuffer, requestedStart, maximum);
    if (startLine !== undefined) {
      let newlines = 0;
      for (const byte of selected.buffer) if (byte === 0x0a) newlines += 1;
      const selectedLines =
        selected.buffer.length === 0
          ? 0
          : newlines +
            (selected.buffer[selected.buffer.length - 1] === 0x0a ? 0 : 1);
      endLine =
        selectedLines === 0
          ? undefined
          : Math.min(metadata.storedLines, startLine + selectedLines - 1);
    }
    const content = terminalSafe(selected.buffer.toString("utf8"));
    return Object.freeze({
      reference,
      metadata,
      content,
      returnedBytes: utf8Bytes(content),
      range: Object.freeze({
        startByte: selected.start,
        endByte: selected.end,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
      }),
      truncated: selected.start > 0 || selected.end < contentBuffer.length,
      next:
        selected.end < contentBuffer.length
          ? Object.freeze({ kind: "bytes" as const, offsetBytes: selected.end })
          : null,
    });
  }

  async query(request: ArchiveQuery = {}): Promise<ArchiveQueryResult> {
    let index = "";
    try {
      index = await readFile(this.#indexPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const byId = new Map<string, ArtifactMetadata>();
    for (const line of index.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          sessionScope?: unknown;
        };
        if (
          typeof parsed.id !== "string" ||
          !ARTIFACT_ID_PATTERN.test(parsed.id) ||
          parsed.sessionScope !== this.#options.sessionScope
        ) {
          continue;
        }
        byId.set(
          parsed.id,
          parseMetadata(parsed, parsed.id, this.#options.sessionScope),
        );
      } catch {
        // A process crash may leave one incomplete trailing index record. The
        // committed artifact remains directly recallable by its safe ID/URI.
      }
    }

    const requestedTags = new Set(request.tags ?? []);
    const text = request.text?.trim().toLowerCase();
    const matches = [...byId.values()].filter((metadata) => {
      if (
        request.toolName !== undefined &&
        metadata.toolName !== request.toolName
      ) {
        return false;
      }
      if (
        request.outputClass !== undefined &&
        metadata.outputClass !== request.outputClass
      ) {
        return false;
      }
      if (
        request.createdAfterMs !== undefined &&
        metadata.createdAtMs < request.createdAfterMs
      ) {
        return false;
      }
      if (
        request.createdBeforeMs !== undefined &&
        metadata.createdAtMs > request.createdBeforeMs
      ) {
        return false;
      }
      if ([...requestedTags].some((tag) => !metadata.tags.includes(tag))) {
        return false;
      }
      if (text !== undefined && text.length > 0) {
        const haystack =
          `${metadata.toolName}\n${metadata.synopsis}\n${metadata.tags.join(
            " ",
          )}\n${JSON.stringify(metadata.sourceMetadata)}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    matches.sort((left, right) =>
      request.order === "oldest"
        ? left.createdAtMs - right.createdAtMs
        : right.createdAtMs - left.createdAtMs,
    );
    const requestedLimit = normalizePositive(request.limit, 20);
    const limit = Math.min(this.#options.maximumQueryResults, requestedLimit);
    const selected = matches.slice(0, limit).map((metadata) =>
      Object.freeze({
        reference: referenceFor(this.#options, metadata.id),
        metadata,
      }),
    );
    return Object.freeze({
      artifacts: Object.freeze(selected),
      matched: matches.length,
      limited: matches.length > selected.length,
    });
  }
}

export function createContextArchive(
  options: ContextArchiveOptions,
): ContextArchive {
  return new FileContextArchive(options);
}
