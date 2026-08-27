import type { AuthEntry } from "./auth-store.ts";
import { configuredEnvironmentValue } from "./config-environment.ts";
import type { ServerConfig } from "./types.ts";

const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const SECRET_NAME =
  /(?:authorization|api[-_]?key|token|secret|password|passwd|cookie|credential)/i;
const MIN_EXACT_SECRET_LENGTH = 4;
const MAX_REDACTION_NODES = 8_500_000;

function addSecret(target: Set<string>, value: string | undefined) {
  if (value && value.length >= MIN_EXACT_SECRET_LENGTH) target.add(value);
}

function resolvedPlaceholders(value: string) {
  const resolved: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER)) {
    const environmentValue = configuredEnvironmentValue(match[1]);
    if (environmentValue) resolved.push(environmentValue);
  }
  return resolved;
}

function resolveConfiguredValue(value: string) {
  return value.replace(
    PLACEHOLDER,
    (_placeholder, name: string) => configuredEnvironmentValue(name) ?? "",
  );
}

export function configuredSecretValues(config: ServerConfig) {
  const secrets = new Set<string>();

  if (config.transport === "http") {
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      for (const secret of resolvedPlaceholders(value))
        addSecret(secrets, secret);
      if (SECRET_NAME.test(name))
        addSecret(secrets, resolveConfiguredValue(value));
    }
    const url = new URL(config.url);
    for (const [name, value] of url.searchParams) {
      if (SECRET_NAME.test(name)) addSecret(secrets, value);
    }
  } else {
    for (const [name, value] of Object.entries(config.env ?? {})) {
      for (const secret of resolvedPlaceholders(value))
        addSecret(secrets, secret);
      if (SECRET_NAME.test(name))
        addSecret(secrets, resolveConfiguredValue(value));
    }
    const arguments_ = config.args ?? [];
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index] ?? "";
      const equals =
        /^(--?[^=]*(?:token|secret|password|api[-_]?key)[^=]*)=(.+)$/i.exec(
          argument,
        );
      if (equals) addSecret(secrets, equals[2]);
      if (SECRET_NAME.test(argument) && !argument.includes("=")) {
        addSecret(secrets, arguments_[index + 1]);
      }
    }
  }

  return [...secrets];
}

export function oauthSecretValues(entry: AuthEntry | undefined) {
  const secrets = new Set<string>();
  if (!entry) return [];
  for (const [name, value] of Object.entries(entry.tokens ?? {})) {
    if (
      name !== "token_type" &&
      name !== "scope" &&
      typeof value === "string"
    ) {
      addSecret(secrets, value);
    }
  }
  const clientInformation = entry.clientInformation as
    Record<string, unknown> | undefined;
  if (clientInformation) {
    for (const [name, value] of Object.entries(clientInformation)) {
      if (SECRET_NAME.test(name) && typeof value === "string") {
        addSecret(secrets, value);
      }
    }
  }
  addSecret(secrets, entry.codeVerifier);
  addSecret(secrets, entry.state);
  return [...secrets];
}

export function redactExactSecrets<T>(
  value: T,
  exactSecrets: readonly string[],
): T {
  const secrets = [...new Set(exactSecrets)]
    .filter((secret) => secret.length >= MIN_EXACT_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length);
  if (secrets.length === 0) return value;

  const seen = new WeakMap<object, unknown>();
  const pending: Array<{
    source: object;
    target: unknown[] | Record<string, unknown>;
  }> = [];
  let nodes = 0;

  const cloneValue = (candidate: unknown): unknown => {
    if (++nodes > MAX_REDACTION_NODES) {
      throw new Error(
        `MCP data exceeded ${MAX_REDACTION_NODES} redaction nodes`,
      );
    }
    if (typeof candidate === "string") {
      let output = candidate;
      for (const secret of secrets) {
        output = output.replaceAll(secret, "[REDACTED]");
      }
      return output;
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    const existing = seen.get(candidate);
    if (existing !== undefined) return existing;
    const target: unknown[] | Record<string, unknown> = Array.isArray(candidate)
      ? []
      : {};
    seen.set(candidate, target);
    pending.push({ source: candidate, target });
    return target;
  };

  const output = cloneValue(value);
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    if (Array.isArray(source) && Array.isArray(target)) {
      for (const item of source) target.push(cloneValue(item));
      continue;
    }
    if (!Array.isArray(target)) {
      for (const [name, item] of Object.entries(source)) {
        target[name] = cloneValue(item);
      }
    }
  }

  return output as T;
}
