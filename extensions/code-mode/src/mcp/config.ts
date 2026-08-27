import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_CODE_MODE_TIMEOUT_MS } from "../limits.ts";
import type {
  CodeModeConfig,
  ConfigScope,
  HttpServerConfig,
  PermissionDecision,
  ServerConfig,
  ServerRecord,
  StdioServerConfig,
} from "./types.ts";

export const CODE_MODE_CONFIG_FILE_NAME = "code-mode.json";
export const SERVER_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
export const IDENTIFIER_SAFE_SERVER_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SERVERS = 256;
const MAX_PERMISSIONS = 10_000;
const MAX_CONFIG_NAME_LENGTH = 256;

const CONFIG_FIELDS = new Set([
  "servers",
  "permissions",
  "defaultPermission",
  "executionTimeoutMs",
]);
const COMMON_SERVER_FIELDS = new Set([
  "transport",
  "enabled",
  "requestTimeoutMs",
]);
const STDIO_SERVER_FIELDS = new Set([
  ...COMMON_SERVER_FIELDS,
  "command",
  "args",
  "env",
  "cwd",
  "oauth",
]);
const HTTP_SERVER_FIELDS = new Set([
  ...COMMON_SERVER_FIELDS,
  "url",
  "headers",
  "oauth",
]);
const RESERVED_GUEST_SERVER_NAMES = new Set([
  "call",
  "constructor",
  "describe",
  "prototype",
  "search",
  "then",
  "__proto__",
]);

export type CodeModeConfigPaths = {
  global: string;
  project: string;
};

export type CodeModeConfigPathOptions = {
  cwd?: string;
  paths?: Partial<CodeModeConfigPaths>;
};

export type LoadCodeModeConfigOptions = CodeModeConfigPathOptions & {
  projectTrusted?: boolean | (() => boolean);
};

export type LoadedCodeModeConfig = {
  paths: CodeModeConfigPaths;
  projectTrusted: boolean;
  global: CodeModeConfig;
  project?: CodeModeConfig;
  config: CodeModeConfig;
  records: ServerRecord[];
};

export class CodeModeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeModeConfigError";
  }
}

function fail(path: string, message: string): never {
  throw new CodeModeConfigError(`${path} ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string) {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(`${path}.${field}`, "is not allowed");
  }
}

function expectNonEmptyString(value: unknown, path: string) {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function optionalBoolean(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function optionalTimeout(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CODE_MODE_TIMEOUT_MS
  ) {
    fail(
      path,
      `must be an integer from 1 to ${MAX_CODE_MODE_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function parseStringMap(value: unknown, path: string) {
  if (value === undefined) return undefined;
  const input = expectRecord(value, path);
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(input)) {
    if (key.length === 0) fail(path, "must not contain an empty key");
    if (typeof entry !== "string") fail(`${path}.${key}`, "must be a string");
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function parseStringArray(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, "must be an array of strings");
  return value.map((entry, index) => {
    if (typeof entry !== "string")
      fail(`${path}[${index}]`, "must be a string");
    return entry;
  });
}

function parsePermission(value: unknown, path: string) {
  if (value !== "allow" && value !== "ask" && value !== "deny") {
    fail(path, 'must be one of "allow", "ask", or "deny"');
  }
  return value;
}

const SENSITIVE_CONFIG_NAME =
  /(?:authorization|api[-_]?key|token|secret|password|passwd|cookie|credential)/i;

function hasEnvironmentPlaceholder(value: string) {
  return /\$\{[A-Z_][A-Z0-9_]*\}/.test(value);
}

function parseStdioServer(
  input: Record<string, unknown>,
  path: string,
): StdioServerConfig {
  rejectUnknownFields(input, STDIO_SERVER_FIELDS, path);
  const oauth = input.oauth;
  if (oauth !== undefined && oauth !== false)
    fail(`${path}.oauth`, "must be false");

  const config: StdioServerConfig = {
    transport: "stdio",
    command: expectNonEmptyString(input.command, `${path}.command`),
  };
  const args = parseStringArray(input.args, `${path}.args`);
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const argument = args?.[index] ?? "";
    if (
      /^--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential)=/i.test(
        argument,
      ) ||
      (/^--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential)$/i.test(
        argument,
      ) &&
        args?.[index + 1] !== undefined)
    ) {
      fail(
        `${path}.args.${index}`,
        "must not carry a plaintext credential; pass credentials through env",
      );
    }
  }
  const env = parseStringMap(input.env, `${path}.env`);
  for (const [name, value] of Object.entries(env ?? {})) {
    if (SENSITIVE_CONFIG_NAME.test(name) && !hasEnvironmentPlaceholder(value)) {
      fail(
        `${path}.env.${name}`,
        "must reference an environment placeholder instead of a plaintext credential",
      );
    }
  }
  const cwd = input.cwd;
  const enabled = optionalBoolean(input.enabled, `${path}.enabled`);
  const requestTimeoutMs = optionalTimeout(
    input.requestTimeoutMs,
    `${path}.requestTimeoutMs`,
  );
  if (cwd !== undefined) {
    config.cwd = expectNonEmptyString(cwd, `${path}.cwd`);
  }
  if (args !== undefined) config.args = args;
  if (env !== undefined) config.env = env;
  if (enabled !== undefined) config.enabled = enabled;
  if (requestTimeoutMs !== undefined) {
    config.requestTimeoutMs = requestTimeoutMs;
  }
  if (oauth === false) config.oauth = false;
  return config;
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return Boolean(
    match &&
    match.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255),
  );
}

function parseHttpServer(
  input: Record<string, unknown>,
  path: string,
): HttpServerConfig {
  rejectUnknownFields(input, HTTP_SERVER_FIELDS, path);
  const url = expectNonEmptyString(input.url, `${path}.url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`${path}.url`, "must be a valid HTTP(S) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    fail(`${path}.url`, "must use http: or https:");
  }
  if (parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
    fail(`${path}.url`, "must use https: unless the host is loopback");
  }
  if (parsedUrl.username || parsedUrl.password) {
    fail(`${path}.url`, "must not contain embedded credentials");
  }
  for (const name of parsedUrl.searchParams.keys()) {
    if (SENSITIVE_CONFIG_NAME.test(name)) {
      fail(
        `${path}.url`,
        "must not contain credential query parameters; use an environment-backed header",
      );
    }
  }

  const config: HttpServerConfig = { transport: "http", url };
  const headers = parseStringMap(input.headers, `${path}.headers`);
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (SENSITIVE_CONFIG_NAME.test(name) && !hasEnvironmentPlaceholder(value)) {
      fail(
        `${path}.headers.${name}`,
        "must reference an environment placeholder instead of a plaintext credential",
      );
    }
  }
  const enabled = optionalBoolean(input.enabled, `${path}.enabled`);
  const oauth = optionalBoolean(input.oauth, `${path}.oauth`);
  const requestTimeoutMs = optionalTimeout(
    input.requestTimeoutMs,
    `${path}.requestTimeoutMs`,
  );
  if (headers !== undefined) config.headers = headers;
  if (enabled !== undefined) config.enabled = enabled;
  if (oauth !== undefined) config.oauth = oauth;
  if (requestTimeoutMs !== undefined) {
    config.requestTimeoutMs = requestTimeoutMs;
  }
  return config;
}

function parseServer(value: unknown, path: string): ServerConfig {
  const input = expectRecord(value, path);
  if (input.transport === "stdio") return parseStdioServer(input, path);
  if (input.transport === "http") return parseHttpServer(input, path);
  fail(`${path}.transport`, 'must be either "stdio" or "http"');
}

function parseServers(value: unknown, path: string) {
  if (value === undefined) return {};
  const input = expectRecord(value, path);
  if (Object.keys(input).length > MAX_SERVERS) {
    fail(path, `must not contain more than ${MAX_SERVERS} servers`);
  }
  const entries: Array<[string, ServerConfig]> = [];
  for (const [name, server] of Object.entries(input)) {
    if (!SERVER_NAME_PATTERN.test(name) || name.length > 64) {
      fail(
        path,
        "contains an invalid namespace; expected at most 64 characters matching /^[A-Za-z_$][A-Za-z0-9_$-]*$/",
      );
    }
    if (RESERVED_GUEST_SERVER_NAMES.has(name)) {
      fail(`${path}.${name}`, "collides with a reserved guest property");
    }
    entries.push([name, parseServer(server, `${path}.${name}`)]);
  }
  return Object.fromEntries(entries);
}

function parsePermissions(value: unknown, path: string) {
  if (value === undefined) return undefined;
  const input = expectRecord(value, path);
  if (Object.keys(input).length > MAX_PERMISSIONS) {
    fail(path, `must not contain more than ${MAX_PERMISSIONS} rules`);
  }
  const entries: Array<[string, PermissionDecision]> = [];
  for (const [rule, decision] of Object.entries(input)) {
    if (rule.length === 0 || rule.length > MAX_CONFIG_NAME_LENGTH) {
      fail(
        path,
        `rules must contain 1 to ${MAX_CONFIG_NAME_LENGTH} characters`,
      );
    }
    entries.push([rule, parsePermission(decision, `${path}.${rule}`)]);
  }
  return Object.fromEntries(entries);
}

export function parseCodeModeConfig(value: unknown, source = "config") {
  let parsed = value;
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > MAX_CONFIG_BYTES
  ) {
    fail(source, `exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  }
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CodeModeConfigError(`${source} is not valid JSON: ${message}`);
    }
  }

  const input = expectRecord(parsed, source);
  rejectUnknownFields(input, CONFIG_FIELDS, source);
  const config: CodeModeConfig = {
    servers: parseServers(input.servers, `${source}.servers`),
  };
  const permissions = parsePermissions(
    input.permissions,
    `${source}.permissions`,
  );
  if (permissions !== undefined) config.permissions = permissions;
  if (input.defaultPermission !== undefined) {
    config.defaultPermission = parsePermission(
      input.defaultPermission,
      `${source}.defaultPermission`,
    );
  }
  const executionTimeoutMs = optionalTimeout(
    input.executionTimeoutMs,
    `${source}.executionTimeoutMs`,
  );
  if (executionTimeoutMs !== undefined) {
    config.executionTimeoutMs = executionTimeoutMs;
  }
  return config;
}

export function resolveCodeModeConfigPaths(
  options: CodeModeConfigPathOptions = {},
) {
  const cwd = options.cwd ?? process.cwd();
  return {
    global:
      options.paths?.global ?? join(getAgentDir(), CODE_MODE_CONFIG_FILE_NAME),
    project:
      options.paths?.project ??
      join(cwd, CONFIG_DIR_NAME, CODE_MODE_CONFIG_FILE_NAME),
  } satisfies CodeModeConfigPaths;
}

function isMissingFile(error: unknown) {
  return isRecord(error) && "code" in error && error.code === "ENOENT";
}

export async function readCodeModeConfig(path: string) {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissingFile(error)) return { servers: {} } satisfies CodeModeConfig;
    throw error;
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > MAX_CONFIG_BYTES) {
      fail(path, `exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
    }
    return parseCodeModeConfig(
      buffer.subarray(0, bytesRead).toString("utf8"),
      path,
    );
  } finally {
    await handle.close();
  }
}

export function mergeCodeModeConfigs(
  globalConfig: CodeModeConfig,
  projectConfig?: CodeModeConfig,
) {
  if (!projectConfig) return cloneConfig(globalConfig);
  const permissions = {
    ...(globalConfig.permissions ?? {}),
    ...(projectConfig.permissions ?? {}),
  };
  const config: CodeModeConfig = {
    // A server is the credential boundary. Replacing the whole definition keeps
    // headers/env from a global server out of a project server with a new URL
    // or transport.
    servers: {
      ...cloneServers(globalConfig.servers),
      ...cloneServers(projectConfig.servers),
    },
  };
  if (Object.keys(permissions).length > 0) config.permissions = permissions;
  const defaultPermission =
    projectConfig.defaultPermission ?? globalConfig.defaultPermission;
  if (defaultPermission !== undefined)
    config.defaultPermission = defaultPermission;
  const executionTimeoutMs =
    projectConfig.executionTimeoutMs ?? globalConfig.executionTimeoutMs;
  if (executionTimeoutMs !== undefined) {
    config.executionTimeoutMs = executionTimeoutMs;
  }
  return config;
}

export async function loadCodeModeConfig(
  options: LoadCodeModeConfigOptions = {},
) {
  const paths = resolveCodeModeConfigPaths(options);
  const projectTrusted =
    typeof options.projectTrusted === "function"
      ? options.projectTrusted()
      : (options.projectTrusted ?? false);
  const global = await readCodeModeConfig(paths.global);
  const project = projectTrusted
    ? await readCodeModeConfig(paths.project)
    : undefined;
  const config = mergeCodeModeConfigs(global, project);
  const records: ServerRecord[] = [];
  for (const [name, server] of Object.entries(global.servers)) {
    if (project?.servers[name] !== undefined) continue;
    records.push(toServerRecord(name, "global", server));
  }
  if (project) {
    for (const [name, server] of Object.entries(project.servers)) {
      records.push(toServerRecord(name, "project", server));
    }
  }
  records.sort((left, right) => left.name.localeCompare(right.name));
  return {
    paths,
    projectTrusted,
    global,
    project,
    config,
    records,
  } satisfies LoadedCodeModeConfig;
}

export async function writeCodeModeConfig(path: string, value: CodeModeConfig) {
  const config = parseCodeModeConfig(value);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    fail(path, `exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${CODE_MODE_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    closed = true;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function toServerRecord(
  name: string,
  scope: ConfigScope,
  config: ServerConfig,
): ServerRecord {
  return {
    name,
    scope,
    config: cloneServer(config),
    enabled: config.enabled !== false,
  };
}

export function cloneServer(config: ServerConfig): ServerConfig {
  if (config.transport === "stdio") {
    const cloned = { ...config };
    if (config.args) cloned.args = [...config.args];
    if (config.env) cloned.env = { ...config.env };
    return cloned;
  }
  const cloned = { ...config };
  if (config.headers) cloned.headers = { ...config.headers };
  return cloned;
}

function cloneServers(servers: Record<string, ServerConfig>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      cloneServer(config),
    ]),
  );
}

export function cloneConfig(config: CodeModeConfig): CodeModeConfig {
  const cloned: CodeModeConfig = {
    servers: cloneServers(config.servers),
  };
  if (config.permissions) cloned.permissions = { ...config.permissions };
  if (config.defaultPermission !== undefined) {
    cloned.defaultPermission = config.defaultPermission;
  }
  if (config.executionTimeoutMs !== undefined) {
    cloned.executionTimeoutMs = config.executionTimeoutMs;
  }
  return cloned;
}
