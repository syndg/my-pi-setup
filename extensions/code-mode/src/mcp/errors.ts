import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { redactSecretTokens } from "./permissions.ts";
import { truncateUtf8 } from "./search.ts";
import { redactExactSecrets } from "./secrets.ts";

export const MAX_DIAGNOSTIC_LOG_BYTES = 5 * 1024 * 1024;

function safeErrorText(error: unknown, exactSecrets: readonly string[]) {
  const raw =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  const redacted = redactSecretTokens(redactExactSecrets(raw, exactSecrets))
    .replace(
      /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
      "",
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  return truncateUtf8(redacted, 64 * 1024);
}

export function getCodeModeDiagnosticPath() {
  return join(getAgentDir(), "code-mode-diagnostics.log");
}

function persistDiagnostic(diagnostic: string) {
  const path = getCodeModeDiagnosticPath();
  const diagnosticBytes = Buffer.byteLength(diagnostic, "utf8");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existingBytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (
      existingBytes > 0 &&
      existingBytes + diagnosticBytes > MAX_DIAGNOSTIC_LOG_BYTES
    ) {
      const previousPath = `${path}.old`;
      rmSync(previousPath, { force: true });
      renameSync(path, previousPath);
    }
    appendFileSync(path, diagnostic, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Direct terminal writes corrupt Pi's active TUI, so logging stays best-effort.
  }
}

export function logDiagnostic(
  scope: string,
  error: unknown,
  exactSecrets: readonly string[] = [],
) {
  const diagnosticId = randomUUID();
  const diagnostic = `[${new Date().toISOString()}] [code-mode:${diagnosticId}] ${scope}\n${safeErrorText(error, exactSecrets)}\n\n`;
  persistDiagnostic(diagnostic);
  return diagnosticId;
}
