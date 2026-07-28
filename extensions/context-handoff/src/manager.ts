import {
  checkpointCore,
  formatCheckpointIssues,
  type ContextCheckpoint,
} from "../../context-checkpoints/src/index.ts";
import { prepareDeterministicCheckpoint } from "./evidence.ts";
import { durablyPersistSessionSetup } from "./persistence.ts";
import type {
  AtomicCheckpointStore,
  CheckpointRecord,
  HandoffPreflight,
  HandoffRuntime,
  SessionEvidence,
  SetupSessionManager,
} from "./types.ts";
import {
  HANDOFF_BOOTSTRAP_MESSAGE_TYPE,
  HANDOFF_SEED_ENTRY_TYPE,
} from "./types.ts";

const BOOTSTRAP_MAX_BYTES = 12 * 1024;
const MAX_ITEMS = 8;

function lines(title: string, values: readonly string[]) {
  return values.length === 0
    ? []
    : [
        `## ${title}`,
        ...values.slice(0, MAX_ITEMS).map((value) => `- ${value}`),
        "",
      ];
}

export function validateContinuationCheckpoint(
  checkpoint: unknown,
): ContextCheckpoint {
  const validation = checkpointCore.validate(checkpoint);
  if (!validation.ok)
    throw new Error(
      `Checkpoint validation failed:\n${formatCheckpointIssues(validation.issues)}`,
    );
  if (validation.checkpoint.nextActions.length === 0)
    throw new Error("Checkpoint omits an exact next action.");
  if (!validation.checkpoint.originalSession?.sessionId)
    throw new Error("Checkpoint omits the original session pointer.");
  return validation.checkpoint;
}

export function buildBootstrap(
  record: CheckpointRecord,
  exactNextAction: string,
): string {
  const checkpoint = validateContinuationCheckpoint(record.checkpoint);
  const refs = checkpoint.criticalReferences.map(
    (ref) => `${ref.kind}:${ref.id}${ref.uri ? ` (${ref.uri})` : ""}`,
  );
  const output = [
    "# Controlled handoff bootstrap",
    "",
    `Original session: ${checkpoint.originalSession?.transcriptPath ?? checkpoint.originalSession?.sessionId}`,
    `Checkpoint artifact: ${record.artifactPath}`,
    "",
    "## Goal",
    checkpoint.goal,
    "",
    ...lines("Constraints", checkpoint.constraintsAndPreferences),
    ...lines("Completed", checkpoint.completedWork),
    ...lines("Selected working set", checkpoint.workingSet),
    ...lines(
      "Changed files",
      checkpoint.changedFiles.map(
        (file) =>
          `${file.path} [${file.status}]${file.summary ? ` — ${file.summary}` : ""}`,
      ),
    ),
    ...lines(
      "Decisions",
      checkpoint.decisions.map(
        (item) => `${item.decision} — ${item.rationale}`,
      ),
    ),
    ...lines(
      "Blockers",
      checkpoint.blockers.length ? checkpoint.blockers : ["None recorded."],
    ),
    ...lines("Artifact and entry references", refs),
    "## Exact next action",
    exactNextAction,
    "",
    "Use the checkpoint artifact for omitted detail. Do not infer facts absent from this bootstrap or checkpoint.",
  ].join("\n");
  if (Buffer.byteLength(output, "utf8") > BOOTSTRAP_MAX_BYTES) {
    throw new Error(
      `Fresh-session bootstrap exceeds ${BOOTSTRAP_MAX_BYTES} bytes; reduce checkpoint working material.`,
    );
  }
  return output;
}

function sameEvidence(left: SessionEvidence, right: SessionEvidence) {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.leafId === right.leafId
  );
}

export class CheckpointManager {
  readonly #store: AtomicCheckpointStore;
  readonly #persistSetup: (
    sessionManager: SetupSessionManager,
  ) => Promise<void>;
  constructor(
    store: AtomicCheckpointStore,
    persistSetup: (
      sessionManager: SetupSessionManager,
    ) => Promise<void> = durablyPersistSessionSetup,
  ) {
    this.#store = store;
    this.#persistSetup = persistSetup;
  }

  async create(
    runtime: HandoffRuntime,
    options: {
      goal?: string;
      exactNextAction?: string;
      governorState?: Parameters<
        typeof prepareDeterministicCheckpoint
      >[0]["governorState"];
    } = {},
  ) {
    await runtime.waitForIdle();
    const evidence = runtime.captureEvidence();
    const prepared = prepareDeterministicCheckpoint({ evidence, ...options });
    const { artifactPath: _artifactPath, ...record } = prepared.record;
    const persisted = await this.#store.writeCheckpoint(record);
    if (!sameEvidence(evidence, runtime.captureEvidence()))
      throw new Error(
        "Session changed while checkpoint persistence was in progress; external artifact was preserved but no session entry was appended.",
      );
    runtime.appendOriginalCheckpoint(persisted.record);
    return persisted;
  }

  async preflight(
    runtime: HandoffRuntime,
    exactNextAction: string,
    governorState?: Parameters<
      typeof prepareDeterministicCheckpoint
    >[0]["governorState"],
  ): Promise<HandoffPreflight | undefined> {
    await runtime.waitForIdle();
    const evidence = runtime.captureEvidence();
    if (!evidence.sessionFile)
      throw new Error("Handoff requires a persisted original session file.");
    const next = exactNextAction.trim();
    if (!next) throw new Error("Usage: /handoff <exact next action>");
    const active = runtime.activeTasks();
    if (active.length > 0)
      throw new Error(
        `Handoff blocked: active or uncertain child/background work: ${active.map((task) => `${task.kind}:${task.id}`).join(", ")}. Settle or cancel it, then retry.`,
      );
    if (
      runtime.hasUI &&
      !(await runtime.confirm(
        "Create controlled handoff?",
        `Next: ${next}\nOriginal remains browsable at ${evidence.sessionFile}`,
      ))
    )
      return undefined;

    const prepared = prepareDeterministicCheckpoint({
      evidence,
      exactNextAction: next,
      governorState,
    });
    const { artifactPath: _artifactPath, ...record } = prepared.record;
    const checkpoint = await this.#store.writeCheckpoint(record);
    const bootstrap = buildBootstrap(checkpoint.record, next);
    const manifestPath = await this.#store.writeManifest({
      checkpoint: checkpoint.record,
      originalSessionFile: evidence.sessionFile,
      exactNextAction: next,
      bootstrap,
    });
    if (!sameEvidence(evidence, runtime.captureEvidence()))
      throw new Error(
        `Session changed during handoff preflight. No switch occurred. Recover from ${manifestPath}.`,
      );
    runtime.appendOriginalCheckpoint(checkpoint.record);
    return {
      checkpoint,
      bootstrap,
      manifestPath,
      originalSessionFile: evidence.sessionFile,
      sourceSessionId: evidence.sessionId,
      sourceLeafId: evidence.leafId,
      exactNextAction: next,
    };
  }

  async handoff(
    runtime: HandoffRuntime,
    exactNextAction: string,
    governorState?: Parameters<
      typeof prepareDeterministicCheckpoint
    >[0]["governorState"],
  ) {
    const preflight = await this.preflight(
      runtime,
      exactNextAction,
      governorState,
    );
    if (!preflight) return { status: "cancelled-before-prewrite" as const };
    const seed = async (sm: SetupSessionManager) => {
      sm.appendCustomEntry(HANDOFF_SEED_ENTRY_TYPE, {
        version: 1,
        checkpointId: preflight.checkpoint.record.checkpointId,
        checkpointPath: preflight.checkpoint.record.artifactPath,
        manifestPath: preflight.manifestPath,
        originalSessionFile: preflight.originalSessionFile,
      });
      sm.appendCustomMessageEntry(
        HANDOFF_BOOTSTRAP_MESSAGE_TYPE,
        preflight.bootstrap,
        true,
        {
          checkpointId: preflight.checkpoint.record.checkpointId,
          checkpointPath: preflight.checkpoint.record.artifactPath,
        },
      );
      await this.#persistSetup(sm);
    };
    const result = await runtime.newSession({
      parentSession: preflight.originalSessionFile,
      setup: seed,
    });
    return result.cancelled
      ? { status: "cancelled-by-session-gate" as const, preflight }
      : { status: "handed-off" as const, preflight };
  }
}
