import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nonSecretServerFingerprint } from "./connection-manager.ts";
import type { CatalogTool, ServerRecord } from "./types.ts";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;

type CachedServer = {
  fingerprint: string;
  updatedAt: number;
  tools: CatalogTool[];
};

type CacheFile = {
  version: 3;
  servers: Record<string, CachedServer>;
};

function emptyCache(): CacheFile {
  return { version: 3, servers: {} };
}

function safeTool(value: unknown): value is CatalogTool {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return (
    typeof tool.path === "string" &&
    typeof tool.server === "string" &&
    typeof tool.name === "string" &&
    (tool.description === undefined || typeof tool.description === "string") &&
    (tool.annotations === undefined ||
      (typeof tool.annotations === "object" &&
        tool.annotations !== null &&
        !Array.isArray(tool.annotations)))
  );
}

function parseCache(text: string) {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyCache();
  const root = value as Record<string, unknown>;
  if (root.version !== 3 || !root.servers || typeof root.servers !== "object") {
    return emptyCache();
  }
  const servers: Record<string, CachedServer> = {};
  for (const [name, candidate] of Object.entries(root.servers)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.fingerprint !== "string" ||
      typeof record.updatedAt !== "number" ||
      !Array.isArray(record.tools) ||
      !record.tools.every(safeTool)
    ) {
      continue;
    }
    servers[name] = {
      fingerprint: record.fingerprint,
      updatedAt: record.updatedAt,
      tools: record.tools.map((tool) => ({ ...tool, freshness: "cached" })),
    };
  }
  return { version: 3, servers } satisfies CacheFile;
}

export class CatalogCache {
  private readonly path: string;
  private file = emptyCache();
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(records: ServerRecord[]) {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const text = await readFile(this.path, "utf8");
        if (Buffer.byteLength(text, "utf8") <= MAX_CACHE_BYTES) {
          this.file = parseCache(text);
        }
      } catch {
        this.file = emptyCache();
      }
    }
    const configured = new Map(records.map((record) => [record.name, record]));
    const result: Array<{ server: string; tools: CatalogTool[] }> = [];
    for (const [server, cached] of Object.entries(this.file.servers)) {
      const record = configured.get(server);
      if (
        !record ||
        !record.enabled ||
        cached.fingerprint !== nonSecretServerFingerprint(record)
      ) {
        continue;
      }
      result.push({
        server,
        tools: cached.tools.map((tool) => ({ ...tool, freshness: "cached" })),
      });
    }
    return result;
  }

  async update(record: ServerRecord, tools: CatalogTool[]) {
    this.file.servers[record.name] = {
      fingerprint: nonSecretServerFingerprint(record),
      updatedAt: Date.now(),
      tools: tools.map((tool) => ({ ...tool, freshness: "cached" })),
    };
    if (
      Buffer.byteLength(JSON.stringify(this.file), "utf8") > MAX_CACHE_BYTES
    ) {
      // Keep runtime discovery usable even when a server advertises more
      // metadata than the private cache is allowed to retain.
      delete this.file.servers[record.name];
    }
    await this.persist();
  }

  async remove(server: string) {
    delete this.file.servers[server];
    await this.persist();
  }

  private async persist() {
    const serialized = `${JSON.stringify(this.file)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_BYTES) {
      throw new Error(`MCP catalog cache exceeds ${MAX_CACHE_BYTES} bytes`);
    }
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    });
    this.writes = operation.catch(() => undefined);
    await operation;
  }
}
