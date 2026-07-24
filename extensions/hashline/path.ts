import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Adapted from Pi 0.82.0's MIT-licensed path normalization semantics.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizePathArgument(input: string) {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

export function resolveToolPath(input: string, cwd: string) {
  const normalized = normalizePathArgument(input);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
}

export function displayPath(input: string) {
  return input.replace(UNICODE_SPACES, " ").replace(/^@/, "");
}
