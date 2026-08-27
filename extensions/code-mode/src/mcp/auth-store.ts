/**
 * OAuth credential persistence for Code Mode.
 *
 * Substantially adapted from pi-mcp-adapter@2.21.1 (MIT),
 * mcp-auth.ts, commit represented by the 2.21.1 upstream audit fixture.
 * Copyright (c) Nico Bailon and contributors.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConfigScope, ServerRecord } from "./types.ts";

const require = createRequire(import.meta.url);
const KEYRING_SERVICE = "pi-code-mode.oauth";
const KEYRING_CHUNK_SIZE = 1_800;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_STALE_MS = 30_000;
const FALLBACK_TOMBSTONE = "__PI_CODE_MODE_DELETED__";

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
};

type KeyringEntryConstructor = new (
  service: string,
  account: string,
) => KeyringEntry;
type KeyringRequire = ((id: string) => unknown) & {
  resolve(id: string): string;
};

type ChunkManifest = {
  chunked: 1;
  count: number;
  digest: string;
};

export type AuthIdentity = {
  scope: ConfigScope;
  serverName: string;
  serverUrl: string;
  issuer?: string;
};

export type PersistedOAuthTokens = StoredOAuthTokens & {
  /** Absolute expiry avoids extending expires_in after a process restart. */
  expiresAt?: number;
};

export type AuthEntry = {
  identity: AuthIdentity;
  tokens?: PersistedOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  /** Identifies a configured client stub that must not be reused dynamically. */
  configuredClientId?: string;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
};

export interface AuthSecretStore {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
}

export type OAuthCredentialStoreOptions = {
  secretStore?: AuthSecretStore;
  fallbackDirectory?: string;
  /** Override or disable migration from pi-mcp-adapter's legacy plaintext store. */
  legacyDirectory?: string | false;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeServerUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("MCP server URL must not contain credentials");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeIssuer(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error("OAuth issuer must not contain credentials or a fragment");
  }
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function identityForRecord(
  record: ServerRecord,
  issuer?: string,
): AuthIdentity {
  if (record.config.transport !== "http") {
    throw new Error(
      `OAuth is only supported for HTTP MCP servers: ${record.name}`,
    );
  }
  return {
    scope: record.scope,
    serverName: record.name,
    serverUrl: normalizeServerUrl(record.config.url),
    ...(issuer ? { issuer: normalizeIssuer(issuer) } : {}),
  };
}

function baseIdentity(identity: AuthIdentity) {
  return {
    scope: identity.scope,
    serverName: identity.serverName,
    serverUrl: normalizeServerUrl(identity.serverUrl),
  };
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function baseAccount(identity: AuthIdentity) {
  return `sha256-${digest(baseIdentity(identity))}`;
}

function entryAccount(identity: AuthIdentity) {
  const issuer = identity.issuer ? normalizeIssuer(identity.issuer) : "unbound";
  return `${baseAccount(identity)}.issuer-${digest(issuer)}`;
}

function activeAccount(identity: AuthIdentity) {
  return `${baseAccount(identity)}.active`;
}

function ownerAccount(identity: AuthIdentity) {
  return `sha256-${digest({
    scope: identity.scope,
    serverName: identity.serverName,
  })}.server-url`;
}

function parseJson<T>(payload: string, label: string) {
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}`, { cause: error });
  }
}

function parseManifest(payload: string) {
  try {
    const value = JSON.parse(payload) as Partial<ChunkManifest>;
    if (
      value.chunked === 1 &&
      Number.isInteger(value.count) &&
      (value.count ?? 0) > 0 &&
      typeof value.digest === "string"
    ) {
      return value as ChunkManifest;
    }
  } catch {
    // A normal credential payload is not a chunk manifest.
  }
  return undefined;
}

function nativeSuffixes(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  if (platform === "darwin") {
    if (arch === "arm64") return ["darwin-arm64"];
    if (arch === "x64") return ["darwin-x64"];
  }
  if (platform === "win32") {
    if (arch === "arm64") return ["win32-arm64-msvc"];
    if (arch === "x64") return ["win32-x64-msvc"];
    if (arch === "ia32") return ["win32-ia32-msvc"];
  }
  if (platform === "linux") {
    if (arch === "arm64") return ["linux-arm64-gnu", "linux-arm64-musl"];
    if (arch === "arm") return ["linux-arm-gnueabihf"];
    if (arch === "riscv64") return ["linux-riscv64-gnu"];
    if (arch === "x64") return ["linux-x64-gnu", "linux-x64-musl"];
  }
  if (platform === "freebsd" && arch === "x64") return ["freebsd-x64"];
  return [];
}

export function loadKeyringEntryClass(
  keyringRequire: KeyringRequire = require,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
) {
  try {
    const module = keyringRequire("@napi-rs/keyring") as {
      Entry: KeyringEntryConstructor;
    };
    return module.Entry;
  } catch (loaderError) {
    let lastError: unknown;
    for (const suffix of nativeSuffixes(platform, arch)) {
      try {
        const packagePath = keyringRequire.resolve(
          `@napi-rs/keyring-${suffix}/package.json`,
        );
        const module = keyringRequire(
          join(dirname(packagePath), `keyring.${suffix}.node`),
        ) as { Entry: KeyringEntryConstructor };
        return module.Entry;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Failed to load @napi-rs/keyring: ${errorMessage(lastError ?? loaderError)}`,
      { cause: loaderError },
    );
  }
}

export class MemoryAuthSecretStore implements AuthSecretStore {
  readonly entries = new Map<string, string>();

  read(account: string) {
    return this.entries.get(account);
  }

  write(account: string, payload: string) {
    this.entries.set(account, payload);
  }

  remove(account: string) {
    this.entries.delete(account);
  }
}

export class KeyringAuthSecretStore implements AuthSecretStore {
  private Entry: KeyringEntryConstructor | undefined;

  private entry(account: string) {
    this.Entry ??= loadKeyringEntryClass();
    return new this.Entry(KEYRING_SERVICE, account);
  }

  private chunkAccount(
    account: string,
    manifest: ChunkManifest,
    index: number,
  ) {
    return `${account}.chunk.${manifest.digest}.${index}`;
  }

  read(account: string) {
    const payload = this.entry(account).getPassword() ?? undefined;
    if (!payload) return payload;
    const manifest = parseManifest(payload);
    if (!manifest) return payload;
    let result = "";
    for (let index = 0; index < manifest.count; index += 1) {
      const chunk = this.entry(
        this.chunkAccount(account, manifest, index),
      ).getPassword();
      if (chunk === null)
        throw new Error(`Missing keyring credential chunk ${index}`);
      result += chunk;
    }
    return result;
  }

  write(account: string, payload: string) {
    const previous = this.entry(account).getPassword();
    const previousManifest = previous ? parseManifest(previous) : undefined;
    let nextManifest: ChunkManifest | undefined;
    if (payload.length <= KEYRING_CHUNK_SIZE) {
      this.entry(account).setPassword(payload);
    } else {
      nextManifest = {
        chunked: 1,
        count: Math.ceil(payload.length / KEYRING_CHUNK_SIZE),
        digest: digest(payload).slice(0, 16),
      };
      for (let index = 0; index < nextManifest.count; index += 1) {
        this.entry(this.chunkAccount(account, nextManifest, index)).setPassword(
          payload.slice(
            index * KEYRING_CHUNK_SIZE,
            (index + 1) * KEYRING_CHUNK_SIZE,
          ),
        );
      }
      this.entry(account).setPassword(JSON.stringify(nextManifest));
    }
    if (previousManifest && previousManifest.digest !== nextManifest?.digest) {
      this.removeChunks(account, previousManifest);
    }
  }

  private removeChunks(account: string, manifest: ChunkManifest) {
    for (let index = 0; index < manifest.count; index += 1) {
      this.entry(
        this.chunkAccount(account, manifest, index),
      ).deleteCredential();
    }
  }

  remove(account: string) {
    const payload = this.entry(account).getPassword();
    const manifest = payload ? parseManifest(payload) : undefined;
    if (manifest) this.removeChunks(account, manifest);
    this.entry(account).deleteCredential();
  }
}

/**
 * Locked-file fallback for hosts without a usable OS credential service.
 * This is intentionally a fallback, not the preferred store. Each secret is
 * protected by a 0700 directory, a 0600 lock file, and an atomic fsync+rename
 * of a 0600 temporary file. Atomic rename means readers never observe a partial
 * JSON credential after a crash.
 */
export class LockedFileAuthSecretStore implements AuthSecretStore {
  readonly directory: string;

  constructor(directory = join(getAgentDir(), "code-mode", "oauth-fallback")) {
    this.directory = directory;
  }

  private ensureDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private path(account: string) {
    return join(this.directory, `${account}.json`);
  }

  private withLock<T>(account: string, operation: () => T) {
    this.ensureDirectory();
    const lockPath = join(this.directory, `${account}.lock`);
    const started = Date.now();
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - started >= FILE_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for OAuth credential lock: ${account}`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
  }

  read(account: string) {
    this.ensureDirectory();
    const path = this.path(account);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }

  write(account: string, payload: string) {
    this.withLock(account, () => {
      const path = this.path(account);
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, payload, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      const directoryDescriptor = openSync(this.directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    });
  }

  remove(account: string) {
    this.withLock(account, () => rmSync(this.path(account), { force: true }));
  }
}

class PreferredKeyringStore implements AuthSecretStore {
  private readonly keyring: AuthSecretStore;
  private readonly fallback: AuthSecretStore;

  constructor(
    keyring: AuthSecretStore = new KeyringAuthSecretStore(),
    fallback: AuthSecretStore = new LockedFileAuthSecretStore(),
  ) {
    this.keyring = keyring;
    this.fallback = fallback;
  }

  read(account: string) {
    const fallbackPayload = this.fallback.read(account);
    try {
      const keyringPayload = this.keyring.read(account);
      if (fallbackPayload === FALLBACK_TOMBSTONE) {
        this.keyring.remove(account);
        this.fallback.remove(account);
        return undefined;
      }
      if (keyringPayload !== undefined) {
        if (fallbackPayload !== undefined) this.fallback.remove(account);
        return keyringPayload;
      }
      if (fallbackPayload !== undefined) {
        this.keyring.write(account, fallbackPayload);
        this.fallback.remove(account);
      }
      return fallbackPayload;
    } catch {
      return fallbackPayload === FALLBACK_TOMBSTONE
        ? undefined
        : fallbackPayload;
    }
  }

  write(account: string, payload: string) {
    try {
      this.keyring.write(account, payload);
      this.fallback.remove(account);
    } catch {
      this.fallback.write(account, payload);
    }
  }

  remove(account: string) {
    this.fallback.write(account, FALLBACK_TOMBSTONE);
    try {
      this.keyring.remove(account);
      this.fallback.remove(account);
    } catch {
      // The tombstone prevents an inaccessible keyring value being resurrected.
    }
  }
}

let defaultStore: AuthSecretStore | undefined;

function secretStore(options: OAuthCredentialStoreOptions) {
  if (options.secretStore) return options.secretStore;
  defaultStore ??= new PreferredKeyringStore(
    new KeyringAuthSecretStore(),
    new LockedFileAuthSecretStore(options.fallbackDirectory),
  );
  return defaultStore;
}

type ActiveIdentity = { issuer?: string };
type ServerUrlBinding = { serverUrl: string };

type LegacyMigration = {
  identity: AuthIdentity;
  entry: AuthEntry;
  file: string;
  directory: string;
};

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function legacyMigration(
  identity: AuthIdentity,
  legacyRoot: string | undefined,
) {
  if (!legacyRoot) return undefined;
  const account = `sha256-${createHash("sha256")
    .update(identity.serverName, "utf8")
    .digest("hex")}`;
  const directory = join(legacyRoot, account);
  const file = join(directory, "tokens.json");
  if (!existsSync(file)) return undefined;

  let raw: Record<string, unknown>;
  try {
    raw = recordValue(JSON.parse(readFileSync(file, "utf8"))) ?? {};
  } catch {
    return undefined;
  }
  if (typeof raw.serverUrl !== "string") return undefined;
  if (
    normalizeServerUrl(raw.serverUrl) !== normalizeServerUrl(identity.serverUrl)
  ) {
    return undefined;
  }

  const legacyTokens = recordValue(raw.tokens);
  const legacyClient = recordValue(raw.clientInfo);
  const issuer =
    (typeof legacyTokens?.issuer === "string"
      ? legacyTokens.issuer
      : undefined) ??
    (typeof legacyClient?.issuer === "string"
      ? legacyClient.issuer
      : undefined);
  if (
    identity.issuer &&
    issuer &&
    normalizeIssuer(identity.issuer) !== normalizeIssuer(issuer)
  ) {
    return undefined;
  }
  const boundIdentity = {
    ...baseIdentity(identity),
    ...(issuer ? { issuer: normalizeIssuer(issuer) } : {}),
  };
  const entry: AuthEntry = { identity: boundIdentity };

  if (legacyTokens && typeof legacyTokens.accessToken === "string") {
    entry.tokens = {
      access_token: legacyTokens.accessToken,
      token_type: "Bearer",
      ...(typeof legacyTokens.refreshToken === "string"
        ? { refresh_token: legacyTokens.refreshToken }
        : {}),
      ...(typeof legacyTokens.scope === "string"
        ? { scope: legacyTokens.scope }
        : {}),
      ...(typeof legacyTokens.expiresAt === "number"
        ? { expiresAt: legacyTokens.expiresAt }
        : {}),
      ...(issuer ? { issuer: normalizeIssuer(issuer) } : {}),
    };
  }
  if (legacyClient && typeof legacyClient.clientId === "string") {
    entry.clientInformation = {
      client_id: legacyClient.clientId,
      ...(typeof legacyClient.clientSecret === "string"
        ? { client_secret: legacyClient.clientSecret }
        : {}),
      ...(typeof legacyClient.clientIdIssuedAt === "number"
        ? { client_id_issued_at: legacyClient.clientIdIssuedAt }
        : {}),
      ...(typeof legacyClient.clientSecretExpiresAt === "number"
        ? { client_secret_expires_at: legacyClient.clientSecretExpiresAt }
        : {}),
      ...(Array.isArray(legacyClient.redirectUris) &&
      legacyClient.redirectUris.every((value) => typeof value === "string")
        ? { redirect_uris: legacyClient.redirectUris }
        : {}),
      ...(issuer ? { issuer: normalizeIssuer(issuer) } : {}),
    };
  }
  if (typeof raw.codeVerifier === "string")
    entry.codeVerifier = raw.codeVerifier;
  if (typeof raw.oauthState === "string") entry.state = raw.oauthState;
  if (
    !entry.tokens &&
    !entry.clientInformation &&
    !entry.codeVerifier &&
    !entry.state
  ) {
    return undefined;
  }
  return {
    identity: boundIdentity,
    entry,
    file,
    directory,
  } satisfies LegacyMigration;
}

export class OAuthCredentialStore {
  private readonly secretStore: AuthSecretStore;
  private readonly legacyDirectory: string | undefined;

  constructor(options: OAuthCredentialStoreOptions = {}) {
    this.secretStore = secretStore(options);
    this.legacyDirectory =
      options.legacyDirectory === false
        ? undefined
        : (options.legacyDirectory ??
          (options.secretStore ? undefined : join(getAgentDir(), "mcp-oauth")));
  }

  private active(identity: AuthIdentity) {
    const payload = this.secretStore.read(activeAccount(identity));
    return payload
      ? parseJson<ActiveIdentity>(payload, "OAuth identity index")
      : undefined;
  }

  private setActive(identity: AuthIdentity) {
    this.secretStore.write(
      activeAccount(identity),
      JSON.stringify(
        identity.issuer ? { issuer: normalizeIssuer(identity.issuer) } : {},
      ),
    );
  }

  private invalidateIdentity(identity: AuthIdentity) {
    const active = this.active(identity);
    if (active?.issuer) {
      this.secretStore.remove(
        entryAccount({ ...baseIdentity(identity), issuer: active.issuer }),
      );
    }
    this.secretStore.remove(entryAccount(baseIdentity(identity)));
    this.secretStore.remove(activeAccount(identity));
  }

  private checkUrlBinding(identity: AuthIdentity, establish: boolean) {
    const account = ownerAccount(identity);
    const payload = this.secretStore.read(account);
    const normalizedUrl = normalizeServerUrl(identity.serverUrl);
    let matches = true;
    if (payload) {
      const binding = parseJson<ServerUrlBinding>(
        payload,
        "OAuth server URL binding",
      );
      const previousUrl = normalizeServerUrl(binding.serverUrl);
      matches = previousUrl === normalizedUrl;
      if (!matches) {
        this.invalidateIdentity({ ...identity, serverUrl: previousUrl });
        this.secretStore.remove(account);
      }
    }
    if (establish) {
      this.secretStore.write(
        account,
        JSON.stringify({ serverUrl: normalizedUrl }),
      );
    }
    return matches;
  }

  private migrateLegacy(identity: AuthIdentity) {
    const migration = legacyMigration(identity, this.legacyDirectory);
    if (!migration) return undefined;
    this.checkUrlBinding(migration.identity, true);
    this.secretStore.write(
      entryAccount(migration.identity),
      JSON.stringify(migration.entry),
    );
    this.setActive(migration.identity);
    // Remove plaintext only after the secure/fallback write completed.
    rmSync(migration.directory, { recursive: true, force: true });
    return structuredClone(migration.entry);
  }

  read(identity: AuthIdentity) {
    const normalized = {
      ...baseIdentity(identity),
      ...(identity.issuer ? { issuer: normalizeIssuer(identity.issuer) } : {}),
    };
    if (!this.checkUrlBinding(normalized, false)) return undefined;
    const active = this.active(normalized);
    if (
      normalized.issuer &&
      active?.issuer &&
      normalizeIssuer(active.issuer) !== normalized.issuer
    ) {
      this.remove(normalized);
      return undefined;
    }
    const selected = normalized.issuer
      ? normalized
      : { ...normalized, ...(active?.issuer ? { issuer: active.issuer } : {}) };
    const payload = this.secretStore.read(entryAccount(selected));
    if (!payload) return this.migrateLegacy(selected);
    const entry = parseJson<AuthEntry>(payload, "OAuth credential entry");
    if (
      entry.identity.scope !== selected.scope ||
      entry.identity.serverName !== selected.serverName ||
      normalizeServerUrl(entry.identity.serverUrl) !== selected.serverUrl ||
      (selected.issuer &&
        (!entry.identity.issuer ||
          normalizeIssuer(entry.identity.issuer) !== selected.issuer))
    ) {
      this.remove(selected);
      return undefined;
    }
    return structuredClone(entry);
  }

  write(identity: AuthIdentity, update: (entry: AuthEntry) => AuthEntry) {
    const normalized = {
      ...baseIdentity(identity),
      ...(identity.issuer ? { issuer: normalizeIssuer(identity.issuer) } : {}),
    };
    this.checkUrlBinding(normalized, true);
    const active = this.active(normalized);
    let previous = this.read(normalized);
    if (normalized.issuer && !previous && !active?.issuer) {
      const unboundIdentity = baseIdentity(normalized);
      previous = this.read(unboundIdentity);
      if (previous) this.secretStore.remove(entryAccount(unboundIdentity));
    }
    if (
      normalized.issuer &&
      active?.issuer &&
      normalizeIssuer(active.issuer) !== normalized.issuer
    ) {
      this.secretStore.remove(
        entryAccount({ ...normalized, issuer: active.issuer }),
      );
      previous = undefined;
    }
    const next = update(
      previous ?? {
        identity: normalized,
      },
    );
    next.identity = normalized;
    this.secretStore.write(entryAccount(normalized), JSON.stringify(next));
    this.setActive(normalized);
    return structuredClone(next);
  }

  replace(identity: AuthIdentity, entry: AuthEntry) {
    return this.write(identity, () => entry);
  }

  remove(identity: AuthIdentity) {
    const normalized = {
      ...baseIdentity(identity),
      ...(identity.issuer ? { issuer: normalizeIssuer(identity.issuer) } : {}),
    };
    this.invalidateIdentity(normalized);
    const account = ownerAccount(normalized);
    const payload = this.secretStore.read(account);
    if (!payload) return;
    const binding = parseJson<ServerUrlBinding>(
      payload,
      "OAuth server URL binding",
    );
    if (normalizeServerUrl(binding.serverUrl) === normalized.serverUrl) {
      this.secretStore.remove(account);
    }
  }
}

export function resetDefaultAuthStoreForTests() {
  defaultStore = undefined;
}
