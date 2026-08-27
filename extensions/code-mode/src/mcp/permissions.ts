import type { CodeModeConfig, PermissionDecision } from "./types.ts";

export const REDACTED_VALUE = "[REDACTED]";
export const DEFAULT_APPROVAL_ARGUMENT_BYTES = 4 * 1024;

const SECRET_KEY_PARTS = new Set([
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "session",
  "token",
]);

export type RedactionOptions = {
  maxDepth?: number;
  maxProperties?: number;
  maxStringBytes?: number;
  limitBehavior?: "truncate" | "throw";
};

export function resolvePermission(
  path: string,
  rules: Readonly<Record<string, PermissionDecision>> = {},
  defaultPermission: PermissionDecision = "ask",
) {
  const exact = ownDecision(rules, path);
  if (exact) return exact;

  const separator = path.indexOf(".");
  if (separator > 0) {
    const wildcard = ownDecision(rules, `${path.slice(0, separator)}.*`);
    if (wildcard) return wildcard;
  }

  return isPermissionDecision(defaultPermission) ? defaultPermission : "ask";
}

export const resolvePermissionDecision = resolvePermission;

export function resolveConfiguredPermission(
  config: Pick<CodeModeConfig, "permissions" | "defaultPermission">,
  path: string,
) {
  return resolvePermission(
    path,
    config.permissions,
    config.defaultPermission ?? "ask",
  );
}

export function redactSecrets(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const maxDepth = positiveInteger(options.maxDepth) ?? 10;
  const maxProperties = positiveInteger(options.maxProperties) ?? 200;
  const maxStringBytes = positiveInteger(options.maxStringBytes) ?? 2 * 1024;
  const throwOnLimit = options.limitBehavior === "throw";
  const seen = new WeakSet<object>();
  let properties = 0;

  const limitExceeded = (limit: "depth" | "properties" | "string") => {
    if (throwOnLimit) {
      throw new RangeError(`Secret redaction exceeded maximum ${limit}`);
    }
  };

  const redact = (
    current: unknown,
    depth: number,
    secretKey: boolean,
  ): unknown => {
    if (secretKey) return REDACTED_VALUE;
    if (typeof current === "string") {
      const redacted = redactSecretTokens(current);
      if (Buffer.byteLength(redacted, "utf8") > maxStringBytes) {
        limitExceeded("string");
      }
      return truncateUtf8(redacted, maxStringBytes);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (current === undefined) return undefined;
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[Circular]";
    if (depth >= maxDepth) {
      limitExceeded("depth");
      return "[Truncated: maximum depth]";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      const output: unknown[] = [];
      for (const item of current) {
        if (properties++ >= maxProperties) {
          limitExceeded("properties");
          output.push("[Truncated: maximum properties]");
          break;
        }
        output.push(redact(item, depth + 1, false));
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(current)) {
      if (properties++ >= maxProperties) {
        limitExceeded("properties");
        output["[Truncated]"] = "maximum properties";
        break;
      }
      let property: unknown;
      try {
        property = current[key as keyof typeof current];
      } catch {
        property = "[Unreadable]";
      }
      output[key] = redact(property, depth + 1, isSecretKey(key));
    }
    return output;
  };

  return redact(value, 0, false);
}

export function redactSecretTokens(value: string) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
    return REDACTED_VALUE;
  }

  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${REDACTED_VALUE}`)
    .replace(
      /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      REDACTED_VALUE,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED_VALUE,
    )
    .replace(
      /([?&](?:access_token|api_?key|client_secret|password|secret|token)=)[^&\s]+/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
      `$1${REDACTED_VALUE}`,
    );
}

export function formatRedactedArguments(
  value: unknown,
  maxBytes = DEFAULT_APPROVAL_ARGUMENT_BYTES,
) {
  const safeLimit =
    positiveInteger(maxBytes) ?? DEFAULT_APPROVAL_ARGUMENT_BYTES;
  let serialized: string;
  try {
    serialized = JSON.stringify(redactSecrets(value), null, 2) ?? "null";
  } catch {
    serialized = "[Unable to serialize arguments]";
  }
  return truncateUtf8(serialized, safeLimit);
}

export function isSecretKey(key: string) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const compact = normalized.replaceAll("_", "");
  const parts = normalized.split("_").filter(Boolean);
  if (SECRET_KEY_PARTS.has(compact)) return true;
  if (parts.some((part) => part !== "token" && SECRET_KEY_PARTS.has(part))) {
    return true;
  }
  if (
    (normalized === "token" ||
      normalized.endsWith("_token") ||
      normalized.startsWith("token_")) &&
    !/^(?:token_)?(?:count|index|limit|name|type)s?$/.test(normalized)
  ) {
    return true;
  }
  return (
    normalized.endsWith("_key") &&
    ["api_key", "access_key", "private_key", "secret_key"].some((suffix) =>
      normalized.endsWith(suffix),
    )
  );
}

function ownDecision(
  rules: Readonly<Record<string, PermissionDecision>>,
  key: string,
) {
  if (!Object.hasOwn(rules, key)) return undefined;
  const value: unknown = rules[key];
  return isPermissionDecision(value) ? value : undefined;
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === "allow" || value === "ask" || value === "deny";
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n…[truncated]";
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > target) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}
