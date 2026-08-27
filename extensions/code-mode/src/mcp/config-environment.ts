import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function configuredEnvironmentValue(name: string) {
  const inherited = process.env[name];
  if (inherited !== undefined) return inherited;
  let contents: string;
  try {
    contents = readFileSync(join(getAgentDir(), ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;
    const raw = match[2]?.trim() ?? "";
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }
    return raw.replace(/\s+#.*$/, "");
  }
  return undefined;
}

export function resolveTemplate(value: string, label: string) {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      const resolved = configuredEnvironmentValue(name);
      if (resolved === undefined) {
        throw new Error(`Missing environment variable ${name} for ${label}`);
      }
      return resolved;
    },
  );
}
