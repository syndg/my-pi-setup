import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { MemoryPersistence, MemoryPersistenceUpdate } from "./types.ts";

const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 10;

export interface FileMemoryPersistenceOptions {
  readonly lockWaitMs?: number;
  readonly staleLockMs?: number;
  readonly retryDelayMs?: number;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
  readonly createdAtMs: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadSnapshot(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(ownerPath, 0o600);
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    return Number.isSafeInteger(value.pid) &&
      typeof value.token === "string" &&
      Number.isSafeInteger(value.createdAtMs)
      ? (value as LockOwner)
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleLockMs: number,
): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (!lockStat.isDirectory() || Date.now() - lockStat.mtimeMs < staleLockMs)
    return false;
  const owner = await readOwner(lockPath);
  if (owner !== null && processIsAlive(owner.pid)) return false;

  const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function acquireLock(
  lockPath: string,
  lockWaitMs: number,
  staleLockMs: number,
  retryDelayMs: number,
  owner: LockOwner,
): Promise<void> {
  const deadline = performance.now() + lockWaitMs;
  while (true) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (created) {
      try {
        await chmod(lockPath, 0o700);
        await writeOwner(lockPath, owner);
        return;
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    }

    if (await recoverStaleLock(lockPath, staleLockMs)) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out after ${lockWaitMs}ms waiting for memory lock: ${lockPath}`,
      );
    }
    await delay(Math.min(retryDelayMs, remaining));
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function atomicWrite(
  directory: string,
  target: string,
  targetName: string,
  serializedDocument: string,
): Promise<void> {
  const temporaryPath = join(
    directory,
    `.${targetName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(serializedDocument, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, target);
    temporaryCreated = false;
    await chmod(target, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (temporaryCreated)
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createFileMemoryPersistence(
  filePath: string,
  options: FileMemoryPersistenceOptions = {},
): MemoryPersistence {
  if (!isAbsolute(filePath))
    throw new TypeError("memory file path must be absolute");
  const target = resolve(filePath);
  const directory = dirname(target);
  const targetName = basename(target);
  const lockPath = `${target}.lock`;
  const lockWaitMs = positiveDuration(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS);
  const staleLockMs = positiveDuration(
    options.staleLockMs,
    DEFAULT_STALE_LOCK_MS,
  );
  const retryDelayMs = positiveDuration(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
  );

  return Object.freeze({
    async load() {
      return loadSnapshot(target);
    },

    async update<T>(
      operation: (
        serializedDocument: string | null,
      ) => MemoryPersistenceUpdate<T> | Promise<MemoryPersistenceUpdate<T>>,
    ): Promise<T> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const owner = Object.freeze({
        pid: process.pid,
        token: randomBytes(16).toString("hex"),
        createdAtMs: Date.now(),
      });
      await acquireLock(lockPath, lockWaitMs, staleLockMs, retryDelayMs, owner);
      try {
        const update = await operation(await loadSnapshot(target));
        if (update.serializedDocument !== undefined) {
          await atomicWrite(
            directory,
            target,
            targetName,
            update.serializedDocument,
          );
        }
        return update.result;
      } finally {
        await releaseLock(lockPath, owner.token).catch(() => undefined);
      }
    },
  });
}
