import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheRunRecord } from "./types.ts";

const MAX_LABEL = 120;

export interface CacheTelemetryOptions {
  readonly enabled: boolean;
  readonly directory: string;
  readonly sessionId: string;
  readonly writerId?: string;
  readonly maxRecords: number;
  readonly maxBytes: number;
}

export interface CacheTelemetryWriter {
  readonly path: string;
  append(record: Readonly<CacheRunRecord>): void;
  flush(): Promise<void>;
}

function safeLabel(value: string, fallback: string) {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_LABEL);
  return safe || fallback;
}

export function cacheTelemetryPath(
  directory: string,
  sessionId: string,
  writerId = String(process.pid),
) {
  return join(
    directory,
    `${safeLabel(sessionId, "session")}.${safeLabel(writerId, "writer")}.jsonl`,
  );
}

function label(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_LABEL);
}

export function cacheTelemetryRecord(record: Readonly<CacheRunRecord>) {
  return {
    schemaVersion: 1,
    timestampMs: record.timestampMs,
    sessionId: label(record.sessionId),
    runId: label(record.runId),
    boundary: record.boundary,
    providers: record.providers.slice(0, 8).map((provider) => ({
      provider: label(provider.provider),
      api: label(provider.api),
      model: label(provider.model),
      requests: provider.requests,
      input: provider.input,
      output: provider.output,
      cacheRead: provider.cacheRead,
      cacheWrite: provider.cacheWrite,
      cacheReadAvailability: provider.cacheReadAvailability,
      cacheWriteAvailability: provider.cacheWriteAvailability,
    })),
    cacheRatio: record.cacheRatio,
    prefix: { ...record.prefix },
    additiveActivations: record.additiveActivations.slice(-32).map((event) => ({
      sequence: event.sequence,
      source: event.source,
      addedToolNames: event.addedToolNames.slice(0, 32).map(label),
    })),
    decayEpochs: record.decayEpochs.slice(-32).map((event) => ({
      sequence: event.sequence,
      mode: event.mode,
      stable: event.stable,
      cacheEpochId: label(event.cacheEpochId),
    })),
  };
}

function retain(
  existing: string,
  next: string,
  maxRecords: number,
  maxBytes: number,
) {
  const lines = [...existing.split("\n").filter(Boolean), next].slice(
    -Math.max(1, maxRecords),
  );
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (size > maxBytes || bytes + size > maxBytes) continue;
    kept.unshift(line);
    bytes += size;
  }
  return kept.length ? `${kept.join("\n")}\n` : "";
}

export function createCacheTelemetryWriter(
  options: CacheTelemetryOptions,
): CacheTelemetryWriter {
  const path = cacheTelemetryPath(
    options.directory,
    options.sessionId,
    options.writerId,
  );
  const queue: string[] = [];
  const queueLimit = Math.max(1, Math.floor(options.maxRecords));
  let draining: Promise<void> | undefined;
  let temporarySequence = 0;

  const drain = async () => {
    while (queue.length) {
      const line = queue.shift();
      if (line === undefined) continue;
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        await chmod(options.directory, 0o700);
        let existing = "";
        try {
          existing = await readFile(path, "utf8");
        } catch {
          /* new file */
        }
        const content = retain(
          existing,
          line,
          options.maxRecords,
          options.maxBytes,
        );
        temporarySequence += 1;
        const temporary = `${path}.${process.pid}.${temporarySequence}.tmp`;
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
      } catch {
        // Observation is fail-open: telemetry loss must never affect the agent.
      }
    }
  };
  const start = () => {
    if (draining || queue.length === 0) return;
    draining = drain().finally(() => {
      draining = undefined;
      start();
    });
  };

  return {
    path,
    append(record) {
      if (!options.enabled) return;
      try {
        queue.push(JSON.stringify(cacheTelemetryRecord(record)));
      } catch {
        return;
      }
      if (queue.length > queueLimit) queue.splice(0, queue.length - queueLimit);
      start();
    },
    async flush() {
      while (draining || queue.length) {
        start();
        if (draining) await draining;
      }
    },
  };
}
