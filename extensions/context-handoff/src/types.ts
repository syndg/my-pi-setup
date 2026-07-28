import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  CheckpointContextPolicyState,
  ContextCheckpoint,
} from "../../context-checkpoints/src/index.ts";

export const CHECKPOINT_ENTRY_TYPE = "context-handoff/checkpoint-v1";
export const HANDOFF_SEED_ENTRY_TYPE = "context-handoff/seed-v1";
export const HANDOFF_BOOTSTRAP_MESSAGE_TYPE = "context-handoff/bootstrap-v1";

export interface SessionEvidence {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly leafId: string | null;
  readonly cwd: string;
  readonly entries: readonly SessionEntry[];
  readonly capturedAtMs: number;
}

export interface CheckpointRecord {
  readonly version: 1;
  readonly checkpointId: string;
  readonly createdAtMs: number;
  readonly sourceSessionId: string;
  readonly sourceLeafId: string | null;
  readonly artifactPath: string;
  readonly checkpoint: ContextCheckpoint;
}

export interface PreparedCheckpoint {
  readonly record: CheckpointRecord;
  readonly serialized: string;
}

export interface CheckpointRequest {
  readonly evidence: SessionEvidence;
  readonly goal?: string;
  readonly exactNextAction?: string;
  readonly governorState?: CheckpointContextPolicyState;
}

export interface ActiveTask {
  readonly id: string;
  readonly kind: "tool" | "background" | "subagent";
  readonly label: string;
  readonly status: "running" | "uncertain";
  readonly observedAtMs: number;
}

export interface HandoffPreflight {
  readonly checkpoint: PreparedCheckpoint;
  readonly bootstrap: string;
  readonly manifestPath: string;
  readonly originalSessionFile: string;
  readonly sourceSessionId: string;
  readonly sourceLeafId: string | null;
  readonly exactNextAction: string;
}

export interface SetupSessionManager extends Pick<
  SessionManager,
  | "appendCustomEntry"
  | "appendCustomMessageEntry"
  | "getHeader"
  | "getEntries"
  | "getSessionFile"
> {}

export interface HandoffRuntime {
  readonly hasUI: boolean;
  waitForIdle(): Promise<void>;
  captureEvidence(): SessionEvidence;
  appendOriginalCheckpoint(record: CheckpointRecord): void;
  activeTasks(): readonly ActiveTask[];
  confirm(title: string, message: string): Promise<boolean>;
  newSession(options: {
    readonly parentSession: string;
    readonly setup: (sessionManager: SetupSessionManager) => Promise<void>;
    readonly withSession?: (ctx: unknown) => Promise<void>;
  }): Promise<{ readonly cancelled: boolean }>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface AtomicCheckpointStore {
  writeCheckpoint(prepared: Omit<CheckpointRecord, "artifactPath">): Promise<{
    readonly record: CheckpointRecord;
    readonly serialized: string;
  }>;
  writeManifest(input: {
    readonly checkpoint: CheckpointRecord;
    readonly originalSessionFile: string;
    readonly exactNextAction: string;
    readonly bootstrap: string;
  }): Promise<string>;
}
