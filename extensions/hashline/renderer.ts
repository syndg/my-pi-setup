import type {
  AgentToolResult,
  EditToolDetails,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { createEditDetails } from "./diff.ts";
import { applyLineOperations, parseCompleteOperations } from "./operations.ts";
import { displayPath } from "./path.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

const PREVIEW_DELAY_MS = 40;
const MAX_PREVIEW_SNAPSHOT_BYTES = 512 * 1024;
const MAX_PREVIEW_OPERATIONS = 25;
const MAX_PREVIEW_ARGUMENT_BYTES = 256 * 1024;

interface PreviewJob {
  generation: number;
  cancel: () => void;
}

interface HashlineRendererState {
  callComponent?: HashlineEditComponent;
  previewJob?: PreviewJob;
}

interface RenderContext {
  args: unknown;
  state: HashlineRendererState;
  lastComponent: Component | undefined;
  invalidate: () => void;
  cwd: string;
  argsComplete: boolean;
  executionStarted: boolean;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
}

interface RendererOptions {
  schedulePreview?: (callback: () => void) => () => void;
  computeDetails?: typeof createEditDetails;
}

type Phase = "pending" | "success" | "error";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewCandidate(args: unknown, snapshots: SnapshotStore) {
  if (
    !record(args) ||
    typeof args.path !== "string" ||
    typeof args.tag !== "string"
  ) {
    return undefined;
  }
  if (!/^[0-9A-F]{16}$/.test(args.tag)) return undefined;
  const operations = parseCompleteOperations(args.operations);
  if (operations.length === 0 || operations.length > MAX_PREVIEW_OPERATIONS) {
    return undefined;
  }
  const serialized = JSON.stringify(operations);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREVIEW_ARGUMENT_BYTES) {
    return undefined;
  }
  const path = displayPath(args.path);
  const snapshot = snapshots.getForPreview(path, args.tag);
  if (
    !snapshot ||
    Buffer.byteLength(snapshot.text, "utf8") > MAX_PREVIEW_SNAPSHOT_BYTES
  ) {
    return undefined;
  }
  return {
    key: JSON.stringify({ path, tag: args.tag, operations }),
    path,
    snapshot,
    operations,
  };
}

export function sanitizeHumanError(text: string) {
  let sanitized = text.replace(/#[0-9A-F]{16}\b/g, "#…");
  const operationJson = sanitized.indexOf('"operations"');
  if (operationJson !== -1) {
    const jsonStart = sanitized.lastIndexOf("{", operationJson);
    sanitized = `${sanitized.slice(0, Math.max(0, jsonStart))}[structured operation details hidden]`;
  }
  return sanitized;
}

function textResult(result: AgentToolResult<EditToolDetails | undefined>) {
  const text = result.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  return sanitizeHumanError(text);
}

export class HashlineEditComponent implements Component {
  #theme: Theme;
  #path = "";
  #phase: Phase = "pending";
  #diff: string | undefined;
  #error: string | undefined;
  #previewPending = false;
  #expanded = false;
  #firstChangedLine: number | undefined;
  #cache: { width: number; lines: string[] } | undefined;
  previewKey: string | undefined;
  generation = 0;

  constructor(theme: Theme) {
    this.#theme = theme;
  }

  updateArgs(args: unknown, expanded: boolean, theme = this.#theme) {
    this.#theme = theme;
    this.#expanded = expanded;
    this.#path =
      record(args) && typeof args.path === "string" && args.path.length > 0
        ? displayPath(args.path)
        : "";
    this.invalidate();
  }

  beginPreview(key: string) {
    this.previewKey = key;
    this.#phase = "pending";
    this.#diff = undefined;
    this.#previewPending = true;
    this.#error = undefined;
    this.#firstChangedLine = undefined;
    this.invalidate();
    return ++this.generation;
  }

  clearPreview() {
    this.previewKey = undefined;
    this.#phase = "pending";
    this.#diff = undefined;
    this.#error = undefined;
    this.#previewPending = false;
    this.#firstChangedLine = undefined;
    this.generation++;
    this.invalidate();
  }

  isCurrentPreview(key: string, generation: number) {
    return this.previewKey === key && this.generation === generation;
  }

  setPreview(key: string, generation: number, diff: string) {
    if (!this.isCurrentPreview(key, generation)) return false;
    this.#diff = diff;
    this.#previewPending = true;
    this.invalidate();
    return true;
  }

  settleSuccess(details: EditToolDetails, expanded: boolean, theme: Theme) {
    this.#theme = theme;
    this.#phase = "success";
    this.#diff = details.diff;
    this.#error = undefined;
    this.#previewPending = false;
    this.#expanded = expanded;
    this.#firstChangedLine = details.firstChangedLine;
    this.previewKey = undefined;
    this.generation++;
    this.invalidate();
  }

  settleError(error: string, expanded: boolean, theme: Theme) {
    this.#theme = theme;
    this.#phase = "error";
    this.#diff = undefined;
    this.#error = error || "Hashline edit failed";
    this.#previewPending = false;
    this.#expanded = expanded;
    this.#firstChangedLine = undefined;
    this.previewKey = undefined;
    this.generation++;
    this.invalidate();
  }

  render(width: number) {
    if (this.#cache?.width === width) return this.#cache.lines;
    if (width < 4) return [truncateToWidth(this.#path || "edit", width, "")];

    const theme = this.#theme;
    const background =
      this.#phase === "success"
        ? "toolSuccessBg"
        : this.#phase === "error"
          ? "toolErrorBg"
          : "toolPendingBg";
    const borderColor =
      this.#phase === "success"
        ? "success"
        : this.#phase === "error"
          ? "error"
          : "borderAccent";
    const icon =
      this.#phase === "success" ? "✓" : this.#phase === "error" ? "✗" : "·";
    const location = this.#firstChangedLine ? `:${this.#firstChangedLine}` : "";
    const diffLines =
      this.#diff?.split("\n").filter((line) => line.length > 0) ?? [];
    const added = diffLines.filter((line) => line.startsWith("+")).length;
    const removed = diffLines.filter((line) => line.startsWith("-")).length;
    const stats =
      this.#phase === "success" && (added || removed)
        ? ` +${added} -${removed}`
        : "";
    const title = `${icon} edit ${this.#path || "…"}${location}${stats}`;

    const paint = (line: string) => {
      const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
      return theme.bg(background, truncateToWidth(padded, width, ""));
    };
    const border = (text: string) => theme.fg(borderColor, text);
    const topLabel = `╭─ ${title} `;
    const top = border(
      `${topLabel}${"─".repeat(Math.max(0, width - visibleWidth(topLabel) - 1))}╮`,
    );
    const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);

    let body: string[];
    if (this.#phase === "error") {
      body = (this.#error ?? "Hashline edit failed").split("\n");
    } else {
      const limit = this.#expanded ? 40 : 8;
      const hidden = Math.max(0, diffLines.length - limit);
      body = diffLines.slice(-limit);
      if (hidden > 0) body.unshift(`… ${hidden} diff lines above`);
      if (this.#previewPending) body.push("(previewing…)");
    }
    if (body.length === 0) {
      body = [this.#previewPending ? "(previewing…)" : "No preview available"];
    }

    const maxBody = this.#expanded ? 40 : 8;
    if (this.#phase === "error" && body.length > maxBody) {
      body = [
        ...body.slice(0, maxBody - 1),
        `… ${body.length - maxBody + 1} more lines`,
      ];
    }

    const renderedBody = body.map((line) => {
      let styled = line;
      if (line.startsWith("+")) styled = theme.fg("toolDiffAdded", line);
      else if (line.startsWith("-")) styled = theme.fg("toolDiffRemoved", line);
      else if (line === "(previewing…)" || line === "No preview available")
        styled = theme.fg("dim", line);
      else if (this.#phase === "error") styled = theme.fg("error", line);
      else styled = theme.fg("toolDiffContext", line);
      return paint(
        `│ ${truncateToWidth(styled, Math.max(0, width - 4), "…")} │`,
      );
    });

    const lines = [paint(top), ...renderedBody, paint(bottom)];
    this.#cache = { width, lines };
    return lines;
  }

  invalidate() {
    this.#cache = undefined;
  }
}

function defaultSchedulePreview(callback: () => void) {
  const timer = setTimeout(callback, PREVIEW_DELAY_MS);
  return () => clearTimeout(timer);
}

function cancelPreview(state: HashlineRendererState) {
  state.previewJob?.cancel();
  state.previewJob = undefined;
}

export function createHashlineRenderer(
  snapshots: SnapshotStore,
  options: RendererOptions = {},
) {
  const schedulePreview = options.schedulePreview ?? defaultSchedulePreview;
  const computeDetails = options.computeDetails ?? createEditDetails;

  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext) {
      const component =
        context.lastComponent instanceof HashlineEditComponent
          ? context.lastComponent
          : (context.state.callComponent ?? new HashlineEditComponent(theme));
      context.state.callComponent = component;
      component.updateArgs(args, context.expanded, theme);

      const candidate = previewCandidate(args, snapshots);
      if (!candidate) {
        cancelPreview(context.state);
        component.clearPreview();
        return component;
      }
      if (component.previewKey === candidate.key) return component;

      cancelPreview(context.state);
      const generation = component.beginPreview(candidate.key);
      const job: PreviewJob = {
        generation,
        cancel: () => {},
      };
      job.cancel = schedulePreview(() => {
        if (
          context.state.previewJob !== job ||
          !component.isCurrentPreview(candidate.key, generation)
        ) {
          return;
        }
        context.state.previewJob = undefined;
        try {
          const next = applyLineOperations(
            candidate.snapshot.text,
            candidate.operations,
            candidate.snapshot.seenLines,
          );
          if (!component.isCurrentPreview(candidate.key, generation)) return;
          const details = computeDetails(
            candidate.path,
            candidate.snapshot.text,
            next,
          );
          if (component.setPreview(candidate.key, generation, details.diff)) {
            context.invalidate();
          }
        } catch {
          // Partial semantic errors are intentionally hidden. Execution reports final errors.
        }
      });
      context.state.previewJob = job;
      return component;
    },

    renderResult(
      result: AgentToolResult<EditToolDetails | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ) {
      cancelPreview(context.state);
      const component = context.state.callComponent;
      if (component) {
        if (context.isError) {
          component.settleError(textResult(result), options.expanded, theme);
        } else if (result.details) {
          component.settleSuccess(result.details, options.expanded, theme);
        } else {
          component.settleError(
            "Hashline edit returned no diff details",
            options.expanded,
            theme,
          );
        }
      }
      const resultComponent =
        context.lastComponent instanceof Container
          ? context.lastComponent
          : new Container();
      resultComponent.clear();
      return resultComponent;
    },
  };
}
