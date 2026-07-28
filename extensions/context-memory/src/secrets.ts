import type {
  MemorySecretPolicy,
  MemorySource,
  SecretPolicyDecision,
  SecretPolicyInput,
} from "./types.ts";

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|access[_-]?token|password|passwd|client[_-]?secret|secret|token)\s*[:=]\s*)(["']?)[^\s,"']+\2/gi,
];

function redactText(value: string): {
  readonly value: string;
  readonly count: number;
} {
  let output = value;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match: string, prefix?: string) => {
      count += 1;
      return typeof prefix === "string" && prefix.length > 0
        ? `${prefix}${REDACTED}`
        : REDACTED;
    });
  }
  return Object.freeze({ value: output, count });
}

function redactedDecision(input: SecretPolicyInput): SecretPolicyDecision {
  const fact = redactText(input.fact);
  const reference = redactText(input.source.reference);
  return Object.freeze({
    action: fact.count + reference.count > 0 ? "redact" : "accept",
    fact: fact.value,
    source: Object.freeze({
      kind: input.source.kind,
      reference: reference.value,
    }) satisfies MemorySource,
    redactionCount: fact.count + reference.count,
  });
}

/** Default fail-closed policy: memory is not an appropriate secret store. */
export const rejectCommonSecrets: MemorySecretPolicy = (input) => {
  const decision = redactedDecision(input);
  if (decision.action === "redact") {
    return Object.freeze({
      action: "reject",
      reason: "Potential secret detected; long-term memory rejected the write.",
    });
  }
  return decision;
};

/** Optional conservative adapter for deployments that explicitly prefer redaction. */
export const redactCommonSecrets: MemorySecretPolicy = redactedDecision;

export const acceptSecretsForTestingOnly: MemorySecretPolicy = (input) =>
  Object.freeze({
    action: "accept",
    fact: input.fact,
    source: Object.freeze({ ...input.source }),
    redactionCount: 0,
  });
