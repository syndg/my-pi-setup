import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { CheckpointContextPolicyState } from "../context-checkpoints/src/index.ts";
import { formatShadowReport } from "../context-decay/src/adapter.ts";
import { requestContextDecayControl } from "../context-decay/src/control.ts";
import {
  ActiveTaskTracker,
  CheckpointManager,
  createAtomicCheckpointStore,
  CHECKPOINT_ENTRY_TYPE,
  type HandoffRuntime,
  type SessionEvidence,
} from "../context-handoff/src/index.ts";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  isGovernorState,
  type GovernorState,
} from "../shared/context-governor-state.ts";
import { isAppliedContextWireState } from "../shared/context-wire-state.ts";
import {
  DEFAULT_CONTEXT_MAINTENANCE_CONFIG,
  loadContextMaintenanceConfig,
  type ContextMaintenanceConfig,
  type MaintenanceChoiceId,
} from "./src/config.ts";
import {
  IGNORE_ENTRY_TYPE,
  MaintenancePressurePolicy,
  parseIgnoreOnceRecord,
  resolveMaintenanceChoices,
} from "./src/policy.ts";

const CONFIG_FILE_NAME = "config.private.json";
const USAGE =
  "Usage: /context-maintain [decay|checkpoint <next action>|handoff <next action>|compact [instructions]|ignore-once]";

export function contextMaintenancePaths() {
  return {
    config: join(getAgentDir(), "context-maintenance", CONFIG_FILE_NAME),
  };
}

export function checkpointPolicy(
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

function captureEvidence(ctx: ExtensionContext): SessionEvidence {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    cwd: ctx.cwd,
    entries: ctx.sessionManager.getBranch(),
    capturedAtMs: Date.now(),
  };
}

function activeTaskError(tracker: ActiveTaskTracker): string | null {
  const active = tracker.list();
  return active.length === 0
    ? null
    : `Maintenance blocked by active or uncertain child/background work: ${active.map((task) => `${task.kind}:${task.id}`).join(", ")}. Settle or cancel it, then retry.`;
}

function parseAction(raw: string): {
  action?: MaintenanceChoiceId;
  argument: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { argument: "" };
  const [token = "", ...rest] = trimmed.split(/\s+/);
  const aliases: Record<string, MaintenanceChoiceId | undefined> = {
    decay: "decay",
    checkpoint: "checkpoint",
    handoff: "handoff",
    compact: "compact",
    compaction: "compact",
    ignore: "ignore-once",
    "ignore-once": "ignore-once",
  };
  return {
    action: aliases[token.toLowerCase()],
    argument: rest.join(" ").trim(),
  };
}

export default function contextMaintenanceExtension(pi: ExtensionAPI) {
  let config: ContextMaintenanceConfig = DEFAULT_CONTEXT_MAINTENANCE_CONFIG;
  let pressurePolicy = new MaintenancePressurePolicy(config);
  let governor: GovernorState | undefined;
  let compactArmedForSession: string | null = null;
  const tracker = new ActiveTaskTracker();
  const checkpointManager = new CheckpointManager(
    createAtomicCheckpointStore(join(getAgentDir(), "context-handoff")),
  );

  const stopGovernor = pi.events.on(CONTEXT_GOVERNOR_CHANNEL, (value) => {
    if (isGovernorState(value)) governor = value;
  });

  const checkpointRuntime = (
    ctx: ExtensionContext,
    waitForIdle: () => Promise<void>,
  ): HandoffRuntime => ({
    hasUI: ctx.hasUI,
    waitForIdle,
    captureEvidence: () => captureEvidence(ctx),
    appendOriginalCheckpoint: (record) =>
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, record),
    activeTasks: () => tracker.list(),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    newSession: async () => {
      throw new Error(
        "Session replacement is unavailable outside an explicit handoff command.",
      );
    },
    notify: (message, level) => ctx.ui.notify(message, level),
  });

  const commandRuntime = (ctx: ExtensionCommandContext): HandoffRuntime => ({
    ...checkpointRuntime(ctx, () => ctx.waitForIdle()),
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
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadContextMaintenanceConfig(contextMaintenancePaths().config);
    pressurePolicy = new MaintenancePressurePolicy(config);
    pressurePolicy.reset(ctx.sessionManager.getSessionId());
    governor = undefined;
    compactArmedForSession = null;
    tracker.reset();
    let restored = null;
    for (const entry of ctx.sessionManager.getBranch().slice(-128)) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        tracker.observeResult(entry.message.toolName, entry.message.details);
      } else if (
        entry.type === "custom" &&
        entry.customType === IGNORE_ENTRY_TYPE
      ) {
        restored = parseIgnoreOnceRecord(entry.data);
      }
    }
    pressurePolicy.restoreIgnore(restored);
  });

  pi.on("tool_execution_start", (event) =>
    tracker.toolStarted(event.toolCallId, event.toolName),
  );
  pi.on("tool_execution_end", (event) => tracker.toolEnded(event.toolCallId));
  pi.on("tool_result", (event) =>
    tracker.observeResult(event.toolName, event.details),
  );

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    const ignoredBefore = pressurePolicy.ignored();
    const decision = pressurePolicy.observeSettled(governor, Date.now());
    if (ignoredBefore && !pressurePolicy.ignored()) {
      pi.appendEntry(IGNORE_ENTRY_TYPE, {
        ...ignoredBefore,
        active: false,
        createdAtMs: Date.now(),
      });
    }

    if (decision.automaticCheckpoint) {
      const blocked = activeTaskError(tracker);
      if (blocked) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Automatic pressure checkpoint skipped: ${blocked}`,
            "warning",
          );
      } else {
        try {
          const result = await checkpointManager.create(
            checkpointRuntime(ctx, async () => {}),
            { governorState: checkpointPolicy(governor, Date.now()) },
          );
          if (ctx.hasUI)
            ctx.ui.notify(
              `Pressure checkpoint ${result.record.checkpointId}: ${result.record.artifactPath}`,
              "info",
            );
        } catch (error) {
          // Fail open: pressure maintenance never blocks the settled lifecycle.
          if (ctx.hasUI)
            ctx.ui.notify(
              `Automatic pressure checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
        }
      }
    }

    if (
      decision.offerMaintenance &&
      (decision.transition === "entered-red" ||
        decision.transition === "entered-emergency") &&
      ctx.hasUI
    ) {
      ctx.ui.notify(
        "Context pressure requires an explicit choice. Run /context-maintain; no compaction or handoff was started.",
        "warning",
      );
    }
  });

  pi.registerCommand("context-maintain", {
    description: "Choose an explicit reversible context-maintenance action",
    getArgumentCompletions: (prefix) => {
      const values = [
        "decay",
        "checkpoint",
        "handoff",
        "compact",
        "ignore-once",
      ];
      const matches = values.filter((value) =>
        value.startsWith(prefix.trim().toLowerCase()),
      );
      return matches.length
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (rawArgs, ctx) => {
      const parsed = parseAction(rawArgs);
      let action = parsed.action;
      let argument = parsed.argument;

      if (!action && rawArgs.trim()) {
        ctx.ui.notify(USAGE, "error");
        return;
      }
      if (!action) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `${USAGE}\nHeadless mode requires an explicit action argument.`,
            "warning",
          );
          return;
        }
        const choices = resolveMaintenanceChoices(
          governor?.pressure.level ?? null,
          config,
        ).filter((choice) => choice.enabled);
        const labels = choices.map(
          (choice) =>
            `${choice.recommended ? "★ " : ""}${choice.label} — ${choice.description}`,
        );
        const selected = await ctx.ui.select(
          "Context maintenance (explicit action)",
          labels,
        );
        if (!selected) return;
        action = choices[labels.indexOf(selected)]?.id;
        if (!action) return;
      }

      const choice = resolveMaintenanceChoices(
        governor?.pressure.level ?? null,
        config,
      ).find((item) => item.id === action);
      if (!choice?.enabled) {
        ctx.ui.notify(
          `Maintenance action '${action}' is unavailable for current pressure/configuration.`,
          "warning",
        );
        return;
      }

      if (choice.requiresNextAction && !argument) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `${USAGE}\n'${action}' requires an exact next action in headless mode.`,
            "error",
          );
          return;
        }
        const entered = await ctx.ui.input(
          "Exact next action",
          "What should continuation do first?",
        );
        if (entered === undefined) return;
        argument = entered.trim();
        if (!argument) {
          ctx.ui.notify(
            "Cancelled: exact next action cannot be empty.",
            "info",
          );
          return;
        }
      }

      try {
        if (action === "decay") {
          const response = requestContextDecayControl(pi.events, {
            sessionId: ctx.sessionManager.getSessionId(),
            action: "apply",
          });
          if (!response)
            throw new Error(
              "The authoritative context-decay controller is unavailable.",
            );
          if (response.status !== "applied" || !response.report) {
            throw new Error(
              "Context decay apply was denied; enable allowExplicitApply in context-decay private configuration.",
            );
          }
          ctx.ui.notify(
            `Explicit in-memory decay epoch enabled; durable transcript unchanged.\n${formatShadowReport(response.report, config.decay.maximumReportCharacters)}`,
            "warning",
          );
          return;
        }

        if (action === "ignore-once") {
          if (!governor)
            throw new Error(
              "Governor pressure is unavailable; ignore-once was not persisted.",
            );
          const record = pressurePolicy.ignoreOnce(governor, Date.now());
          if (!record)
            throw new Error(
              "Ignore-once is only valid during Orange/Red/Emergency pressure.",
            );
          pi.appendEntry(IGNORE_ENTRY_TYPE, record);
          ctx.ui.notify(
            "Current high-pressure episode ignored once. It resets after sustained recovery or escalation.",
            "info",
          );
          return;
        }

        await ctx.waitForIdle();
        const blocked = activeTaskError(tracker);
        if (blocked) throw new Error(blocked);

        if (action === "checkpoint") {
          const result = await checkpointManager.create(commandRuntime(ctx), {
            exactNextAction: argument,
            governorState: checkpointPolicy(governor, Date.now()),
          });
          ctx.ui.notify(
            `Checkpoint ${result.record.checkpointId}: ${result.record.artifactPath}`,
            "info",
          );
          return;
        }
        if (action === "handoff") {
          const result = await checkpointManager.handoff(
            commandRuntime(ctx),
            argument,
            checkpointPolicy(governor, Date.now()),
          );
          if (result.status !== "handed-off")
            ctx.ui.notify(
              "Handoff cancelled; original session remains active.",
              "info",
            );
          return;
        }

        compactArmedForSession = ctx.sessionManager.getSessionId();
        ctx.compact({
          customInstructions:
            argument ||
            "Create a validated checkpoint-shaped summary for explicit maintenance.",
          onComplete: () =>
            ctx.ui.notify("Explicit manual compaction completed.", "info"),
          onError: (error) => {
            compactArmedForSession = null;
            ctx.ui.notify(
              `Explicit manual compaction failed: ${error.message}`,
              "error",
            );
          },
        });
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", () => {
    stopGovernor();
    tracker.reset();
    compactArmedForSession = null;
  });
}

export * from "./src/config.ts";
export * from "./src/policy.ts";
