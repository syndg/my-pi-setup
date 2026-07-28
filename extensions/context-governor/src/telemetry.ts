import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovernorState } from "../../shared/context-governor-state.ts";
import type { ComparisonAudit } from "./governor.ts";

const MAX_ID_CHARACTERS = 120;
const MAX_LABEL_CHARACTERS = 160;
const MAX_TOOL_NAMES = 64;

export interface TelemetryOptions {
  readonly enabled: boolean;
  readonly directory: string;
  readonly sessionId: string;
  readonly writerId?: string;
  readonly maxRecords: number;
  readonly maxBytes: number;
}

export interface TelemetryWriter {
  append(
    state: Readonly<GovernorState>,
    audit: Readonly<ComparisonAudit>,
  ): void;
  flush(): Promise<void>;
  readonly path: string;
}

interface TelemetryRecord {
  readonly timestampMs: number;
  readonly eventKind: ComparisonAudit["eventKind"];
  readonly comparisonGeneration: number;
  readonly comparisonResetReason: ComparisonAudit["comparisonResetReason"];
  readonly runStartBaselineTokens: number | null;
  readonly baselineSource: ComparisonAudit["baselineSource"];
  readonly peakTokens: number | null;
  readonly endpointTokens: number | null;
  readonly growthSampleAccepted: boolean;
  readonly sessionId: string;
  readonly branchLeafId: string | null;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
  } | null;
  readonly measurement: GovernorState["measurement"];
  readonly budget: GovernorState["budget"];
  readonly headroomTokens: number | null;
  readonly safeLimitRatio: number | null;
  readonly growth: GovernorState["growth"];
  readonly runwayRuns: number | null;
  readonly pressure: GovernorState["pressure"];
  readonly toolResultBytesByTool: Readonly<Record<string, number>>;
}

function truncateLabel(value: string, maximum = MAX_LABEL_CHARACTERS) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function fileSafeId(value: string, fallback: string) {
  const safe = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, MAX_ID_CHARACTERS);
  return safe || fallback;
}

export function telemetryFilePath(
  directory: string,
  sessionId: string,
  writerId = String(process.pid),
) {
  const sessionPart = fileSafeId(sessionId, "session");
  const writerPart = fileSafeId(writerId, "writer");
  return join(directory, `${sessionPart}.${writerPart}.jsonl`);
}

function boundedToolBytes(values: Readonly<Record<string, number>>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry) => Number.isFinite(entry[1]) && entry[1] >= 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_TOOL_NAMES)
      .map(([name, bytes]) => [truncateLabel(name, 80), bytes]),
  );
}

export function telemetryRecord(
  state: Readonly<GovernorState>,
  audit: Readonly<ComparisonAudit>,
  sessionId = state.sessionId,
): TelemetryRecord {
  return {
    timestampMs: state.capturedAtMs,
    eventKind: audit.eventKind,
    comparisonGeneration: audit.comparisonGeneration,
    comparisonResetReason: audit.comparisonResetReason,
    runStartBaselineTokens: audit.runStartBaselineTokens,
    baselineSource: audit.baselineSource,
    peakTokens: audit.peakTokens,
    endpointTokens: audit.endpointTokens,
    growthSampleAccepted: audit.growthSampleAccepted,
    sessionId: truncateLabel(sessionId, MAX_ID_CHARACTERS),
    branchLeafId:
      state.branchLeafId === null
        ? null
        : truncateLabel(state.branchLeafId, MAX_ID_CHARACTERS),
    model:
      state.model === null
        ? null
        : {
            provider: truncateLabel(state.model.provider),
            id: truncateLabel(state.model.id),
            contextWindow: state.model.contextWindow,
          },
    measurement: { ...state.measurement },
    budget: { ...state.budget },
    headroomTokens: state.headroomTokens,
    safeLimitRatio: state.safeLimitRatio,
    growth: { ...state.growth },
    runwayRuns: state.runwayRuns,
    pressure: {
      level: state.pressure.level,
      reasons: state.pressure.reasons
        .slice(0, 16)
        .map((reason) => truncateLabel(reason)),
    },
    toolResultBytesByTool: boundedToolBytes(state.toolResultBytesByTool),
  };
}

function retainBoundedLines(
  existing: string,
  nextLine: string,
  maxRecords: number,
  maxBytes: number,
) {
  const candidates = [
    ...existing.split("\n").filter((line) => line.length > 0),
    nextLine,
  ].slice(-Math.max(1, maxRecords));
  const retained: string[] = [];
  let retainedBytes = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = candidates[index];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (lineBytes > maxBytes || retainedBytes + lineBytes > maxBytes) continue;
    retained.unshift(line);
    retainedBytes += lineBytes;
  }

  return retained.length > 0 ? `${retained.join("\n")}\n` : "";
}

async function rewriteBounded(
  path: string,
  line: string,
  maxRecords: number,
  maxBytes: number,
) {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }

  const content = retainBoundedLines(
    existing,
    line,
    Math.max(1, Math.floor(maxRecords)),
    Math.max(1, Math.floor(maxBytes)),
  );
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export function createTelemetryWriter(
  options: TelemetryOptions,
): TelemetryWriter {
  const path = telemetryFilePath(
    options.directory,
    options.sessionId,
    options.writerId,
  );
  const queue: string[] = [];
  const queueLimit = Math.max(1, Math.floor(options.maxRecords));
  let draining: Promise<void> | undefined;

  const drain = async () => {
    while (queue.length > 0) {
      const line = queue.shift();
      if (line === undefined) continue;
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        await rewriteBounded(path, line, options.maxRecords, options.maxBytes);
      } catch {
        // Telemetry is observational. Drop failed records without affecting Pi.
      }
    }
  };

  const startDrain = () => {
    if (draining !== undefined || queue.length === 0) return;
    draining = drain().finally(() => {
      draining = undefined;
      startDrain();
    });
  };

  return {
    path,
    append(state, audit) {
      if (!options.enabled) return;
      queue.push(
        JSON.stringify(telemetryRecord(state, audit, options.sessionId)),
      );
      if (queue.length > queueLimit) {
        queue.splice(0, queue.length - queueLimit);
      }
      startDrain();
    },
    async flush() {
      while (draining !== undefined || queue.length > 0) {
        startDrain();
        await draining;
      }
    },
  };
}
