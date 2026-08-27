import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsExecWorkerModule = {
  _resetJsExecWorkerForTests?: () => void;
};

let loadReset: Promise<() => void> | undefined;

async function resolveReset() {
  const justBashEntry = fileURLToPath(import.meta.resolve("just-bash"));
  const chunksDirectory = join(dirname(justBashEntry), "chunks");
  const candidates = (await readdir(chunksDirectory)).filter((name) =>
    /^js-exec-[A-Z0-9]+\.js$/.test(name),
  );
  if (candidates.length !== 1) {
    throw new Error(
      "Unable to locate the pinned just-bash js-exec lifecycle module",
    );
  }

  const module = (await import(
    pathToFileURL(join(chunksDirectory, candidates[0]!)).href
  )) as JsExecWorkerModule;
  if (typeof module._resetJsExecWorkerForTests !== "function") {
    throw new Error("Pinned just-bash does not expose js-exec worker cleanup");
  }
  return module._resetJsExecWorkerForTests;
}

/**
 * just-bash 3.2.0 keeps its singleton js-exec Worker referenced after an
 * execution. Its only cleanup hook is currently internal, so the pinned bundle
 * is resolved defensively and reset after every Code Mode sandbox lifecycle.
 */
export async function resetJsExecWorker() {
  loadReset ??= resolveReset();
  const reset = await loadReset;
  reset();
}
