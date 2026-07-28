import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkpointCore } from "../../context-checkpoints/src/index.ts";
import type {
  AtomicCheckpointStore,
  CheckpointRecord,
  SetupSessionManager,
} from "./types.ts";

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Materialize setup entries immediately; Pi may otherwise defer a new JSONL until an assistant reply. */
export async function durablyPersistSessionSetup(
  sessionManager: SetupSessionManager,
): Promise<void> {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile)
    throw new Error("Cannot durably seed an in-memory handoff session.");
  const records = [sessionManager.getHeader(), ...sessionManager.getEntries()];
  await atomicWrite(
    sessionFile,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

export function createAtomicCheckpointStore(
  rootDirectory: string,
): AtomicCheckpointStore {
  const root = resolve(rootDirectory);
  return {
    async writeCheckpoint(prepared) {
      const artifactPath = join(
        root,
        "checkpoints",
        prepared.sourceSessionId,
        `${prepared.checkpointId}.json`,
      );
      const record: CheckpointRecord = { ...prepared, artifactPath };
      const serialized = checkpointCore.serialize(record.checkpoint);
      await atomicWrite(artifactPath, serialized);
      return { record, serialized };
    },
    async writeManifest(input) {
      const manifestPath = join(
        root,
        "handoffs",
        input.checkpoint.sourceSessionId,
        `${input.checkpoint.checkpointId}.prepared.json`,
      );
      await atomicWrite(
        manifestPath,
        `${JSON.stringify(
          {
            version: 1,
            status: "prepared",
            checkpointId: input.checkpoint.checkpointId,
            checkpointPath: input.checkpoint.artifactPath,
            originalSessionFile: input.originalSessionFile,
            exactNextAction: input.exactNextAction,
            bootstrap: input.bootstrap,
          },
          null,
          2,
        )}\n`,
      );
      return manifestPath;
    },
  };
}
