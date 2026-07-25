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
import { parseCompleteOperations } from "./operations.ts";
import { displayPath } from "./path.ts";
import { MAX_OPERATIONS } from "./schema.ts";
import {
  SNAPSHOT_TEXT_LIMIT_BYTES,
  type SnapshotStore,
} from "./snapshot-store.ts";
import { createStreamingPreview } from "./streaming-preview.ts";

const PREVIEW_DELAY_MS = 40;
const MAX_PREVIEW_ARGUMENT_BYTES = SNAPSHOT_TEXT_LIMIT_BYTES;

interface PreviewJob {
  work: {
    candidate: NonNullable<ReturnType<typeof previewCandidate>>;
    generation: number;
  };
  component: HashlineEditComponent;
  invalidate: () => void;
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
  computePreview?: typeof createStreamingPreview;
}

type Phase = "pending" | "success" | "error";

const TAB_SPACES = "    ";

function skipControlString(text: string, start: number) {
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index;
    if (code === 0x1b && text[index + 1] === "\\") return index + 1;
  }
  return text.length - 1;
}

function skipCsi(text: string, start: number) {
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return text.length - 1;
}

/** Makes untrusted text inert before renderer-owned ANSI styling is applied. */
export function sanitizeTerminalText(text: string) {
  let sanitized = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x09) {
      sanitized += TAB_SPACES;
      continue;
    }
    if (code === 0x1b) {
      const next = text[index + 1];
      if (next === "[") index = skipCsi(text, index + 2);
      else if (
        next === "]" ||
        next === "P" ||
        next === "_" ||
        next === "^" ||
        next === "X"
      ) {
        index = skipControlString(text, index + 2);
      } else if (next !== undefined) index++;
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(text, index + 1);
      continue;
    }
    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = skipControlString(text, index + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    sanitized += text[index];
  }
  return sanitized;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewTargetKey(args: unknown) {
  if (
    !record(args) ||
    typeof args.path !== "string" ||
    typeof args.tag !== "string" ||
    !/^[0-9A-F]{16}$/.test(args.tag)
  ) {
    return undefined;
  }
  return JSON.stringify({ path: displayPath(args.path), tag: args.tag });
}

function operationsAreTransientlyIncomplete(args: unknown) {
  if (!record(args)) return false;
  if (
    Array.isArray(args.operations) &&
    args.operations.length > MAX_OPERATIONS
  ) {
    return false;
  }
  return parseCompleteOperations(args.operations).length === 0;
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
  if (
    Array.isArray(args.operations) &&
    args.operations.length > MAX_OPERATIONS
  ) {
    return undefined;
  }
  const operations = parseCompleteOperations(args.operations);
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) {
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
    Buffer.byteLength(snapshot.text, "utf8") > SNAPSHOT_TEXT_LIMIT_BYTES
  ) {
    return undefined;
  }
  return {
    key: JSON.stringify({ path, tag: args.tag, operations }),
    targetKey: JSON.stringify({ path, tag: args.tag }),
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
  previewTargetKey: string | undefined;
  generation = 0;

  constructor(theme: Theme) {
    this.#theme = theme;
  }

  updateArgs(args: unknown, expanded: boolean, theme = this.#theme) {
    this.#theme = theme;
    this.#expanded = expanded;
    this.#path =
      record(args) && typeof args.path === "string" && args.path.length > 0
        ? sanitizeTerminalText(displayPath(args.path))
        : "";
    this.invalidate();
  }

  beginPreview(key: string, targetKey: string) {
    const targetChanged = this.previewTargetKey !== targetKey;
    this.previewKey = key;
    this.previewTargetKey = targetKey;
    this.#phase = "pending";
    if (targetChanged) {
      this.#diff = undefined;
      this.#firstChangedLine = undefined;
    }
    this.#previewPending = true;
    this.#error = undefined;
    this.invalidate();
    return ++this.generation;
  }

  retainPreview(targetKey: string) {
    if (this.previewTargetKey !== targetKey) return false;
    this.#phase = "pending";
    this.#previewPending = true;
    this.#error = undefined;
    this.invalidate();
    return true;
  }

  clearPreview() {
    this.previewKey = undefined;
    this.previewTargetKey = undefined;
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
    this.previewTargetKey = undefined;
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
    this.previewTargetKey = undefined;
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
      this.#diff
        ?.split("\n")
        .filter((line) => line.length > 0)
        .map(sanitizeTerminalText) ?? [];
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
    const shownTitle = truncateToWidth(title, Math.max(0, width - 5), "…");
    const topLabel = width >= 5 ? `╭─ ${shownTitle} ` : "╭─ ";
    const top = border(
      `${topLabel}${"─".repeat(Math.max(0, width - visibleWidth(topLabel) - 1))}╮`,
    );
    const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);

    const maxBody = this.#expanded ? 40 : 8;
    let body: string[];
    if (this.#phase === "error") {
      const errorLines = (this.#error ?? "Hashline edit failed")
        .split("\n")
        .map(sanitizeTerminalText);
      body =
        errorLines.length > maxBody
          ? [
              ...errorLines.slice(0, maxBody - 1),
              `… ${errorLines.length - maxBody + 1} more lines`,
            ]
          : errorLines;
    } else {
      const diffCapacity = maxBody - (this.#previewPending ? 1 : 0);
      if (diffLines.length > diffCapacity) {
        const visibleDiffs = Math.max(0, diffCapacity - 1);
        const hidden = diffLines.length - visibleDiffs;
        body = [
          `… ${hidden} diff lines above`,
          ...(visibleDiffs > 0 ? diffLines.slice(-visibleDiffs) : []),
        ];
      } else {
        body = [...diffLines];
      }
      if (this.#previewPending) body.push("(previewing…)");
      if (body.length === 0) body.push("No preview available");
    }

    const renderedBody = body.map((line) => {
      let styled = line;
      if (line.startsWith("+")) styled = theme.fg("toolDiffAdded", line);
      else if (line.startsWith("-")) styled = theme.fg("toolDiffRemoved", line);
      else if (line === "(previewing…)" || line === "No preview available")
        styled = theme.fg("dim", line);
      else if (this.#phase === "error") styled = theme.fg("error", line);
      else styled = theme.fg("toolDiffContext", line);
      const innerWidth = Math.max(0, width - 4);
      const truncated = truncateToWidth(styled, innerWidth, "…");
      const inner =
        truncated +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return paint(`│ ${inner} │`);
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
  const computePreview = options.computePreview ?? createStreamingPreview;

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
        const targetKey = previewTargetKey(args);
        if (
          targetKey &&
          operationsAreTransientlyIncomplete(args) &&
          component.retainPreview(targetKey)
        ) {
          return component;
        }
        cancelPreview(context.state);
        component.clearPreview();
        return component;
      }
      if (component.previewKey === candidate.key) return component;

      const generation = component.beginPreview(
        candidate.key,
        candidate.targetKey,
      );
      const work = { candidate, generation };
      const scheduled = context.state.previewJob;
      if (scheduled) {
        scheduled.work = work;
        scheduled.invalidate = context.invalidate;
        return component;
      }

      const job: PreviewJob = {
        work,
        component,
        invalidate: context.invalidate,
        cancel: () => {},
      };
      context.state.previewJob = job;
      job.cancel = schedulePreview(() => {
        if (context.state.previewJob !== job) return;
        context.state.previewJob = undefined;
        const latest = job.work;
        if (
          !job.component.isCurrentPreview(
            latest.candidate.key,
            latest.generation,
          )
        ) {
          return;
        }
        try {
          const diff = computePreview(
            latest.candidate.snapshot.text,
            latest.candidate.operations,
            latest.candidate.snapshot.seenLines,
          );
          if (
            !job.component.isCurrentPreview(
              latest.candidate.key,
              latest.generation,
            )
          ) {
            return;
          }
          if (
            job.component.setPreview(
              latest.candidate.key,
              latest.generation,
              diff,
            )
          ) {
            job.invalidate();
          }
        } catch {
          // Partial semantic errors are intentionally hidden. Execution reports final errors.
        }
      });
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
