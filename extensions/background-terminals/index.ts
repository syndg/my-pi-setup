/**
 * Background terminals — start long-running shell processes the model can
 * inspect and stop, but never write to (stdin is ignored at the OS level).
 *
 * Tools (for the LLM):
 * - bg_start: fire-and-forget spawn (command, title, working_dir). Max 8
 *   running at once. The model is notified exactly once when a process exits.
 * - bg_status: peek at one terminal's status + tail-truncated output.
 * - bg_list: list all tracked terminals (running and settled).
 * - bg_kill: SIGTERM→SIGKILL the whole process tree; returns final state.
 *
 * While ≥1 process runs, a one-line widget above the editor shows
 * "N background terminal(s) running • /ps to view". `/ps` opens a two-stage
 * full-screen overlay (list → read-only detail with stdout/stderr toggle).
 *
 * Architecture: Effect v4 core (manager service behind one ManagedRuntime);
 * this file is the async boundary where tool handlers run effects via
 * runTool. Node stream plumbing inside the manager is plain callbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TerminalSnapshot } from "./src/domain.ts";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import {
  BG_KILL_PARAMETER_DESCRIPTIONS,
  BG_KILL_TOOL_DESCRIPTION,
  BG_LIST_TOOL_DESCRIPTION,
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_PROMPT_GUIDELINES,
  BG_START_PROMPT_SNIPPET,
  BG_START_TOOL_DESCRIPTION,
  BG_STATUS_PARAMETER_DESCRIPTIONS,
  BG_STATUS_TOOL_DESCRIPTION,
  buildKillReport,
  buildStartResult,
  buildStatusResult,
  buildTerminalResultMessage,
  describeTerminal,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createTerminalRuntime,
  runTool,
  type TerminalRuntime,
} from "./src/runtime.ts";
import { sanitizeText } from "./src/ui/output-view.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";
import {
  activateBgTools,
  branchHasBgActivation,
  initializeBgTools,
} from "./src/tool-activation.ts";
import { offerCompletion } from "../context-output/src/completion.ts";

const WIDGET_KEY = "background-terminals";

export default function (pi: ExtensionAPI) {
  let runtime: TerminalRuntime | undefined;
  let managerPromise: Promise<TerminalManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();
  let toolsActivated = false;

  const getRuntime = () => (runtime ??= createTerminalRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(TerminalManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateWidget(manager));
        updateWidget(manager);
        return manager;
      });
    return managerPromise;
  };

  /** One-line widget directly above the editor, only while ≥1 is running.
   * Called on every manager notification (including per-output-chunk), so it
   * only touches setWidget when the running count actually changes —
   * replacing the widget factory hundreds of times a second would churn
   * component creation for no visible difference. */
  let widgetRunning = 0;
  const updateWidget = (manager: TerminalManagerShape) => {
    if (!ui) return;
    try {
      const running = manager.view
        .list()
        .filter((snap) => snap.status === "running").length;
      if (running === widgetRunning) return;
      widgetRunning = running;
      if (running === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("warning", "■ ") +
          theme.fg(
            "text",
            `${running} background terminal${running === 1 ? "" : "s"} running`,
          ) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/ps") +
          theme.fg("dim", " to view");
        return { render: () => [line], invalidate: () => {} };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  };

  const deliverResult = (snap: TerminalSnapshot) => {
    try {
      const output = buildTerminalResultMessage(snap);
      const references = [snap.stdout.spillPath, snap.stderr.spillPath].filter(
        (value): value is string => value !== undefined,
      );
      const delivery = offerCompletion(pi.events, {
        kind: "background-terminal",
        id: snap.id,
        title: snap.title,
        status:
          snap.status === "failed"
            ? "failure"
            : snap.status === "killed"
              ? "killed"
              : "success",
        output,
        toolName: "background_terminal_completion",
        outputClass: "background-completion",
        customType: "background-terminal-result",
        details: {
          id: snap.id,
          title: snap.title,
          status: snap.status,
          exitCode: snap.exitCode ?? null,
          signal: snap.signal ?? null,
        },
        externalArtifactReferences: references,
      });
      if (delivery) {
        void delivery.then((outcome) => {
          if (!outcome.delivered && sessionContext) resultDelivery.defer(snap);
        });
        return true;
      }
      pi.sendMessage(
        {
          customType: "background-terminal-result",
          content: output,
          display: true,
          details: {
            id: snap.id,
            title: snap.title,
            status: snap.status,
            exitCode: snap.exitCode,
            signal: snap.signal,
          },
        },
        snap.status === "failed"
          ? { deliverAs: "followUp", triggerTurn: true }
          : { deliverAs: "nextTurn", triggerTurn: false },
      );
      return true;
    } catch (error) {
      console.error("background-terminals: failed to deliver result", error);
      return false;
    }
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) {
      if (!deliverResult(snap)) resultDelivery.defer(snap);
    }
  };

  const onSettled = (snap: TerminalSnapshot, consumed: boolean) => {
    if (consumed) {
      // An in-flight bg_kill is returning this settlement itself.
      resultDelivery.consume([snap.id]);
      return;
    }
    // Defer a deep-enough copy: the live snapshot's output views keep
    // mutating (late flushes) after settle.
    resultDelivery.defer({
      ...snap,
      stdout: { ...snap.stdout },
      stderr: { ...snap.stderr },
    });
    if (sessionContext?.isIdle()) flushResults();
  };

  const initializeSessionToolActivation = (ctx: ExtensionContext) => {
    toolsActivated = branchHasBgActivation(ctx.sessionManager.getEntries());
    initializeBgTools(pi, toolsActivated);
  };

  const syncTreeToolActivation = (ctx: ExtensionContext) => {
    toolsActivated ||= branchHasBgActivation(ctx.sessionManager.getEntries());
    initializeBgTools(pi, toolsActivated);
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    initializeSessionToolActivation(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    syncTreeToolActivation(ctx);
  });

  // Drain deferred results when the agent settles: together with the
  // isIdle() fast path above and the Map-keyed delivery (drain clears),
  // double delivery is structurally impossible — whoever drains first wins.
  pi.on("agent_settled", flushResults);

  // Session transitions can reuse this extension instance. Processes still
  // never survive a transition: session_shutdown disposes the runtime, whose
  // manager finalizer runs disposeAll → every entry scope → SIGTERM→SIGKILL
  // tree kill, with each close bounded so a wedged process cannot hang
  // shutdown.
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    widgetRunning = 0;
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "bg_start",
    label: "Start Background Terminal",
    description: BG_START_TOOL_DESCRIPTION,
    promptSnippet: BG_START_PROMPT_SNIPPET,
    promptGuidelines: BG_START_PROMPT_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.command,
      }),
      title: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.title,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: BG_START_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();

      const command = params.command.trim();
      if (!command) throw new Error("command must not be empty.");

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // Collapse whitespace (a newline inside a one-line UI row desyncs the
      // TUI renderer) before bounding the length.
      const title =
        params.title.replace(/\s+/g, " ").trim().slice(0, 80) || "terminal";
      const snap = await runTool(
        getRuntime(),
        manager.start({ command, title, cwd }),
      );
      toolsActivated = true;
      activateBgTools(pi);

      return {
        content: [{ type: "text", text: buildStartResult(snap) }],
        details: { id: snap.id, title: snap.title, cwd, pid: snap.pid },
      };
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Check Background Terminal",
    description: BG_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: BG_STATUS_PARAMETER_DESCRIPTIONS.id }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(
          `Unknown terminal id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      // This status is returning the settlement itself; a pending automatic
      // follow-up for the same settle would be a duplicate.
      if (snap.status !== "running") resultDelivery.consume([snap.id]);

      return {
        content: [{ type: "text", text: buildStatusResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          pid: snap.pid,
          exitCode: snap.exitCode,
          signal: snap.signal,
        },
      };
    },
  });

  pi.registerTool({
    name: "bg_list",
    label: "List Background Terminals",
    description: BG_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const terminals = manager.view.list();
      const text =
        terminals.length === 0
          ? "No background terminals."
          : terminals.map((snap) => describeTerminal(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          terminals: terminals.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            pid: snap.pid,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Kill Background Terminals",
    description: BG_KILL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: BG_KILL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one terminal id.");

      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown terminal id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.kill(ids), {
        signal,
        interruptMessage:
          "Kill wait aborted; termination continues in the background.",
      });

      // Settlement may have happened before this kill began (or during it,
      // via the killInterest consumed flag). Remove any deferred automatic
      // delivery now that this tool returns the final state itself.
      resultDelivery.consume(ids);

      return {
        content: [{ type: "text", text: buildKillReport(report) }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
            killed: entry.killed,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
        exitCode?: number;
        signal?: string;
      };
      const failed = details.status === "failed";
      const killed = details.status === "killed";
      const icon = failed
        ? theme.fg("error", "x")
        : killed
          ? theme.fg("muted", "■")
          : theme.fg("success", "■");
      const how = killed
        ? "killed"
        : (details.signal ?? `exit ${details.exitCode ?? "?"}`);
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`terminal ${details.id ?? "?"}`)) +
        theme.fg("muted", ` · ${details.title ?? ""} · ${how}`);

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line; the Error line (when present) is part
      // of the actual result and must remain visible. The body carries raw
      // process output — sanitize ANSI/control chars or the transcript smears.
      const body = sanitizeText(content.split("\n").slice(1).join("\n").trim());

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------

  pi.registerCommand("ps", {
    description: "List and inspect background terminals",
    handler: async (_args, ctx) => {
      const manager = await getManager();
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          const terminals = manager.view.list();
          ctx.ui.notify(
            terminals.length === 0
              ? "No background terminals."
              : terminals.map((snap) => describeTerminal(snap)).join("\n"),
            "info",
          );
        }
        return;
      }
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No background terminals yet. The agent starts them with bg_start.",
          "info",
        );
        return;
      }
      await openTerminalPicker(ctx, manager.view);
    },
  });
}
