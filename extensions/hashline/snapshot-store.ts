import { createHash } from "node:crypto";

export const SNAPSHOT_TEXT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface Snapshot {
  canonicalPath: string;
  resolvedPath: string;
  byteIdentity: string;
  tag: string;
  text: string;
  seenLines: ReadonlySet<number>;
}

interface StoredSnapshot extends Snapshot {
  seenLines: Set<number>;
  bytes: number;
  touched: number;
}

interface SnapshotInput {
  canonicalPath: string;
  resolvedPath?: string;
  displayPath: string;
  text: string;
  byteIdentity?: string;
  seenLines?: Iterable<number>;
}

interface SnapshotStoreOptions {
  maxPaths?: number;
  maxVersionsPerPath?: number;
  maxBytes?: number;
  maxSnapshotBytes?: number;
  maxIssuedTags?: number;
  maxAliasesPerPath?: number;
  maxSeenLinesPerSnapshot?: number;
  tagger?: (text: string) => string;
}

const DEFAULTS = {
  maxPaths: 128,
  maxVersionsPerPath: 4,
  maxBytes: 32 * 1024 * 1024,
  maxSnapshotBytes: SNAPSHOT_TEXT_LIMIT_BYTES,
  maxIssuedTags: 4096,
  maxAliasesPerPath: 16,
  maxSeenLinesPerSnapshot: 4096,
};

export function computeTag(text: string) {
  return createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

function fallbackByteIdentity(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fullIdentity(input: {
  canonicalPath: string;
  byteIdentity: string;
  text: string;
}) {
  return createHash("sha256")
    .update(input.canonicalPath)
    .update("\0")
    .update(input.byteIdentity)
    .update("\0")
    .update(input.text, "utf8")
    .digest("hex");
}

export class SnapshotCollisionError extends Error {}
export class UnknownSnapshotError extends Error {}

export class SnapshotStore {
  readonly #paths = new Map<string, Map<string, StoredSnapshot>>();
  readonly #aliases = new Map<string, string>();
  readonly #aliasesByCanonical = new Map<string, Map<string, number>>();
  readonly #issued = new Map<string, string>();
  readonly #options: Required<SnapshotStoreOptions>;
  #bytes = 0;
  #seenRows = 0;
  #clock = 0;

  constructor(options: SnapshotStoreOptions = {}) {
    this.#options = {
      maxPaths: options.maxPaths ?? DEFAULTS.maxPaths,
      maxVersionsPerPath:
        options.maxVersionsPerPath ?? DEFAULTS.maxVersionsPerPath,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      maxSnapshotBytes: options.maxSnapshotBytes ?? DEFAULTS.maxSnapshotBytes,
      maxIssuedTags: options.maxIssuedTags ?? DEFAULTS.maxIssuedTags,
      maxAliasesPerPath:
        options.maxAliasesPerPath ?? DEFAULTS.maxAliasesPerPath,
      maxSeenLinesPerSnapshot:
        options.maxSeenLinesPerSnapshot ?? DEFAULTS.maxSeenLinesPerSnapshot,
      tagger: options.tagger ?? computeTag,
    };
  }

  clear() {
    this.#paths.clear();
    this.#aliases.clear();
    this.#aliasesByCanonical.clear();
    this.#issued.clear();
    this.#bytes = 0;
    this.#seenRows = 0;
    this.#clock = 0;
  }

  validateRecord(input: SnapshotInput) {
    const bytes = Buffer.byteLength(input.text, "utf8");
    if (bytes > this.#options.maxSnapshotBytes) {
      throw new Error("Snapshot exceeds the safe per-file size limit");
    }
    if (bytes > this.#options.maxBytes) {
      throw new Error("Snapshot exceeds the bounded store capacity");
    }
    const seenLines = new Set(input.seenLines ?? []);
    if (seenLines.size > this.#options.maxSeenLinesPerSnapshot) {
      throw new Error(
        "Snapshot displayed rows exceed the safe provenance limit",
      );
    }
    const tag = this.#options.tagger(input.text);
    if (!/^[0-9A-F]{16}$/.test(tag)) {
      throw new Error(
        "Snapshot tagger must return 16 uppercase hexadecimal characters",
      );
    }
    const resolvedPath = input.resolvedPath ?? input.canonicalPath;
    const byteIdentity = input.byteIdentity ?? fallbackByteIdentity(input.text);
    const identity = fullIdentity({
      canonicalPath: input.canonicalPath,
      byteIdentity,
      text: input.text,
    });
    const issuanceKey = `${input.displayPath}\0${tag}`;
    const issuedIdentity = this.#issued.get(issuanceKey);
    if (issuedIdentity && issuedIdentity !== identity) {
      throw new SnapshotCollisionError(
        `Hashline tag collision for ${input.displayPath}#${tag}; no tag was issued`,
      );
    }
    const existing = this.#paths.get(input.canonicalPath)?.get(tag);
    if (
      existing &&
      (existing.text !== input.text || existing.byteIdentity !== byteIdentity)
    ) {
      throw new SnapshotCollisionError(
        `Hashline tag collision for ${input.displayPath}#${tag}; no tag was issued`,
      );
    }
    if (!issuedIdentity) {
      if (this.#issued.size >= this.#options.maxIssuedTags) {
        throw new Error(
          "Hashline issued-tag ledger capacity is exhausted; start a new session",
        );
      }
      // Reserve before a write so post-write bookkeeping cannot lose capacity.
      this.#issued.set(issuanceKey, identity);
    }
    return { tag, bytes, seenLines, resolvedPath, byteIdentity };
  }

  recordRead(input: SnapshotInput & { seenLines: Iterable<number> }) {
    return this.#record(input, false);
  }

  recordEdit(input: SnapshotInput & { seenLines: Iterable<number> }) {
    return this.#record(input, true);
  }

  getForEdit(displayPath: string, tag: string) {
    const canonicalPath = this.#aliases.get(displayPath);
    const snapshot = canonicalPath
      ? this.#paths.get(canonicalPath)?.get(tag)
      : undefined;
    if (!snapshot) {
      throw new UnknownSnapshotError(
        `Unrecognized snapshot tag for this path: #${tag}. Re-read the file and retry.`,
      );
    }
    return this.#copy(snapshot);
  }

  getForPreview(displayPath: string, tag: string) {
    const canonicalPath = this.#aliases.get(displayPath);
    if (!canonicalPath) return undefined;
    const snapshot = this.#paths.get(canonicalPath)?.get(tag);
    return snapshot ? this.#copy(snapshot) : undefined;
  }

  get size() {
    let versions = 0;
    for (const entry of this.#paths.values()) versions += entry.size;
    return versions;
  }

  get seenRowCount() {
    return this.#seenRows;
  }

  #record(
    input: SnapshotInput & { seenLines: Iterable<number> },
    replaceSeen: boolean,
  ) {
    const prepared = this.validateRecord(input);
    const versions = this.#paths.get(input.canonicalPath) ?? new Map();
    const existing = versions.get(prepared.tag);

    if (existing) {
      const union = new Set([...existing.seenLines, ...prepared.seenLines]);
      const nextSeen =
        replaceSeen || union.size > this.#options.maxSeenLinesPerSnapshot
          ? prepared.seenLines
          : union;
      this.#seenRows += nextSeen.size - existing.seenLines.size;
      existing.seenLines = nextSeen;
      existing.resolvedPath = prepared.resolvedPath;
      existing.touched = ++this.#clock;
      versions.delete(prepared.tag);
      versions.set(prepared.tag, existing);
    } else {
      versions.set(prepared.tag, {
        canonicalPath: input.canonicalPath,
        resolvedPath: prepared.resolvedPath,
        byteIdentity: prepared.byteIdentity,
        tag: prepared.tag,
        text: input.text,
        seenLines: prepared.seenLines,
        bytes: prepared.bytes,
        touched: ++this.#clock,
      });
      this.#bytes += prepared.bytes;
      this.#seenRows += prepared.seenLines.size;
    }

    this.#paths.delete(input.canonicalPath);
    this.#paths.set(input.canonicalPath, versions);
    this.#recordAlias(input.displayPath, input.canonicalPath);
    this.#evict();

    const retained = this.#paths.get(input.canonicalPath)?.get(prepared.tag);
    if (!retained) {
      throw new Error("Snapshot could not be retained within store bounds");
    }
    return this.#copy(retained);
  }

  #recordAlias(displayPath: string, canonicalPath: string) {
    const oldCanonical = this.#aliases.get(displayPath);
    if (oldCanonical && oldCanonical !== canonicalPath) {
      this.#aliasesByCanonical.get(oldCanonical)?.delete(displayPath);
    }
    this.#aliases.set(displayPath, canonicalPath);
    const aliases = this.#aliasesByCanonical.get(canonicalPath) ?? new Map();
    aliases.delete(displayPath);
    aliases.set(displayPath, ++this.#clock);
    this.#aliasesByCanonical.set(canonicalPath, aliases);
    while (aliases.size > this.#options.maxAliasesPerPath) {
      const oldest = aliases.keys().next().value as string | undefined;
      if (!oldest) break;
      aliases.delete(oldest);
      if (this.#aliases.get(oldest) === canonicalPath) {
        this.#aliases.delete(oldest);
      }
    }
  }

  #copy(snapshot: StoredSnapshot): Snapshot {
    return {
      canonicalPath: snapshot.canonicalPath,
      resolvedPath: snapshot.resolvedPath,
      byteIdentity: snapshot.byteIdentity,
      tag: snapshot.tag,
      text: snapshot.text,
      seenLines: new Set(snapshot.seenLines),
    };
  }

  #remove(canonicalPath: string, tag: string) {
    const versions = this.#paths.get(canonicalPath);
    const snapshot = versions?.get(tag);
    if (!versions || !snapshot) return;
    versions.delete(tag);
    this.#bytes -= snapshot.bytes;
    this.#seenRows -= snapshot.seenLines.size;
    if (versions.size === 0) {
      this.#paths.delete(canonicalPath);
      for (const alias of this.#aliasesByCanonical.get(canonicalPath)?.keys() ??
        []) {
        if (this.#aliases.get(alias) === canonicalPath)
          this.#aliases.delete(alias);
      }
      this.#aliasesByCanonical.delete(canonicalPath);
    }
  }

  #evict() {
    for (const [canonicalPath, versions] of this.#paths) {
      while (versions.size > this.#options.maxVersionsPerPath) {
        const oldestTag = versions.keys().next().value as string | undefined;
        if (!oldestTag) break;
        this.#remove(canonicalPath, oldestTag);
      }
    }

    while (this.#paths.size > this.#options.maxPaths) {
      const oldestPath = this.#paths.keys().next().value as string | undefined;
      if (!oldestPath) break;
      for (const tag of [...(this.#paths.get(oldestPath)?.keys() ?? [])]) {
        this.#remove(oldestPath, tag);
      }
    }

    while (this.#bytes > this.#options.maxBytes) {
      let oldest: StoredSnapshot | undefined;
      for (const versions of this.#paths.values()) {
        for (const snapshot of versions.values()) {
          if (!oldest || snapshot.touched < oldest.touched) oldest = snapshot;
        }
      }
      if (!oldest) break;
      this.#remove(oldest.canonicalPath, oldest.tag);
    }
  }
}
