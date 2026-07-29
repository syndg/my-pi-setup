import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  isGovernorState,
  type GovernorState,
} from "../shared/context-governor-state.ts";
import { isAppliedContextWireState } from "../shared/context-wire-state.ts";
import type { CheckpointContextPolicyState } from "../context-checkpoints/src/index.ts";
import { ActiveTaskTracker } from "./src/active-tasks.ts";
import { CheckpointManager } from "./src/manager.ts";
import { createAtomicCheckpointStore } from "./src/persistence.ts";
import {
  CHECKPOINT_ENTRY_TYPE,
  type HandoffRuntime,
  type SessionEvidence,
} from "./src/types.ts";

export function policy(
  state: GovernorState | undefined,
  now: number,
): CheckpointContextPolicyState | undefined {
  if (!state) return undefined;
  const wire = isAppliedContextWireState(state.wireAccounting)
    ? state.wireAccounting
    : null;
  return {
    pressure: state.pressure.level ?? "unknown",
    measurementSource: state.measurement.source,
    residentTokens: state.measurement.tokens,
    effectiveWireTokens: wire?.effectiveWireTokens ?? null,
    safeLimitTokens: state.budget.effectiveSafeLimitTokens,
    headroomTokens: state.headroomTokens,
    runwayRuns: state.runwayRuns,
    capturedAtMs: state.capturedAtMs || now,
    notes: [
      ...state.pressure.reasons.slice(0, 8),
      wire
        ? `Applied context decay accounting from ${wire.epochId}.`
        : "Current applied wire accounting was unavailable and was not inferred.",
    ],
  };
}

function evidence(ctx: ExtensionCommandContext): SessionEvidence {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    cwd: ctx.cwd,
    entries: ctx.sessionManager.getBranch(),
    capturedAtMs: Date.now(),
  };
}

export default function contextHandoffExtension(pi: ExtensionAPI) {
  const tracker = new ActiveTaskTracker();
  const manager = new CheckpointManager(
    createAtomicCheckpointStore(join(getAgentDir(), "context-handoff")),
  );
  let governor: GovernorState | undefined;

  const stopGovernor = pi.events.on(CONTEXT_GOVERNOR_CHANNEL, (value) => {
    if (isGovernorState(value)) governor = value;
  });

  pi.on("session_start", (_event, ctx) => {
    tracker.reset();
    governor = undefined;
    for (const entry of ctx.sessionManager.getBranch().slice(-100)) {
      if (entry.type === "message" && entry.message.role === "toolResult")
        tracker.observeResult(entry.message.toolName, entry.message.details);
    }
  });
  pi.on("tool_execution_start", (event) =>
    tracker.toolStarted(event.toolCallId, event.toolName),
  );
  pi.on("tool_execution_end", (event) => tracker.toolEnded(event.toolCallId));
  pi.on("tool_result", (event) =>
    tracker.observeResult(event.toolName, event.details),
  );
  pi.on("session_shutdown", () => {
    stopGovernor();
    tracker.reset();
  });

  const runtime = (ctx: ExtensionCommandContext): HandoffRuntime => ({
    hasUI: ctx.hasUI,
    waitForIdle: () => ctx.waitForIdle(),
    captureEvidence: () => evidence(ctx),
    appendOriginalCheckpoint: (record) =>
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, record),
    activeTasks: () => tracker.list(),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    newSession: (options) =>
      ctx.newSession({
        parentSession: options.parentSession,
        setup: options.setup,
        withSession: async (fresh) => {
          fresh.ui.notify(
            "Handoff ready. Bootstrap is in fresh context; no turn was auto-run.",
            "info",
          );
        },
      }),
    notify: (message, level) => ctx.ui.notify(message, level),
  });

  pi.registerCommand("handoff", {
    description:
      "Preflight and create a controlled child session with an exact next action",
    handler: async (args, ctx) => {
      try {
        const result = await manager.handoff(
          runtime(ctx),
          args,
          policy(governor, Date.now()),
        );
        if (
          result.status === "cancelled-before-prewrite" ||
          result.status === "cancelled-by-session-gate"
        ) {
          ctx.ui.notify(
            "Handoff cancelled; the original session remains active.",
            "info",
          );
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
