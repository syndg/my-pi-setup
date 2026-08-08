import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHashlineEditTool } from "./edit-tool.ts";
import { createHashlineReadTool } from "./read-tool.ts";
import { createHashlineRenderer } from "./renderer.ts";
import { SnapshotStore } from "./snapshot-store.ts";

const HASHLINE_EXTENSION_PATH = canonicalSourcePath(
  fileURLToPath(import.meta.url),
);

function canonicalSourcePath(path: string) {
  if (path.startsWith("<")) return path;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function diagnoseOwnership(pi: ExtensionAPI, context: ExtensionContext) {
  const all = pi.getAllTools();
  const read = all.find((tool) => tool.name === "read");
  const edit = all.find((tool) => tool.name === "edit");
  const owns = (tool: typeof read) =>
    tool !== undefined &&
    canonicalSourcePath(tool.sourceInfo.path) === HASHLINE_EXTENSION_PATH;
  const ownsPair = owns(read) && owns(edit);
  const active = new Set(pi.getActiveTools());
  const readActive = active.has("read");
  const editActive = active.has("edit");
  const pairActive = readActive === editActive;

  // Read-only child profiles intentionally omit edit from their inventory.
  // Tagged reads remain safe when the active read is ours and no edit exists.
  const intentionalReadOnly =
    owns(read) && edit === undefined && readActive && !editActive;
  if (
    (ownsPair && pairActive) ||
    intentionalReadOnly ||
    (!readActive && !editActive)
  )
    return;

  // A half-active or split-owner protocol is unsafe: neither tool may remain
  // active until extension ordering/configuration is repaired.
  pi.setActiveTools(
    [...active].filter((name) => name !== "read" && name !== "edit"),
  );
  const issue = !ownsPair
    ? "Hashline does not own both read and edit; both tools were disabled. Check extension load order."
    : "Hashline read/edit activation differed; both tools were disabled.";
  console.error(`[hashline] ${issue}`);
  if (context.hasUI) context.ui.notify(issue, "error");
}

export function createHashlineExtension(pi: ExtensionAPI) {
  const snapshots = new SnapshotStore();
  const read = createHashlineReadTool(process.cwd(), snapshots);
  const edit = createHashlineEditTool({ cwd: process.cwd(), snapshots });
  const renderer = createHashlineRenderer(snapshots);

  pi.registerTool(read);
  pi.registerTool({ ...edit, ...renderer });

  pi.on("session_start", (_event, context) => {
    snapshots.clear();
    diagnoseOwnership(pi, context);
  });
  pi.on("session_shutdown", () => {
    snapshots.clear();
  });
}

export default createHashlineExtension;
