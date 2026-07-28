import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  isGovernorState,
} from "../shared/context-governor-state.ts";
import {
  CONTEXT_WIRE_STATE_CHANNEL,
  contextWireFingerprint,
  createContextWireState,
  type ContextWireMode,
} from "../shared/context-wire-state.ts";
import {
  CONTEXT_DECAY_SHADOW_CHANNEL,
  createAutomaticDecayController,
  createContextDecayShadowController,
  createShadowReport,
  formatShadowReport,
  mapMessagesToSessionEntries,
  type ContextDecayShadowReport,
} from "./src/adapter.ts";
import {
  CONTEXT_DECAY_CONTROL_CHANNEL,
  isContextDecayControlEvent,
} from "./src/control.ts";
import {
  DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG,
  loadContextDecayConfig,
  type ContextDecayPrivateConfig,
} from "./src/config.ts";
import {
  cacheAdvisorySignalFromAudit,
  type AutomaticCacheAdvisorySignal,
  type AutomaticDecayIdentity,
  type AutomaticGovernorSignal,
} from "./src/automatic-policy.ts";
import type { DecayedContext, DecayContext, DecayPlan } from "./src/types.ts";

const CONFIG_FILE_NAME = "config.private.json";
const CONTEXT_CACHE_AUDIT_CHANNEL = "context-cache:audit";
const MAX_FUTURE_SIGNAL_SKEW_MS = 5_000;

export function contextDecayPaths() {
  return { config: join(getAgentDir(), "context-decay", CONFIG_FILE_NAME) };
}

function modelKey(ctx: ExtensionContext): string {
  return ctx.model === undefined
    ? "no-model"
    : `${ctx.model.provider}/${ctx.model.id}/${ctx.model.contextWindow}`;
}

function generation(entries: readonly SessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return `compaction:${entry.id}`;
  }
  return "uncompacted";
}

function decayContext(
  ctx: ExtensionContext,
  messages?: readonly AgentMessage[],
): DecayContext {
  const entries = ctx.sessionManager.buildContextEntries();
  const sourceMessages =
    messages ?? entries.flatMap(sessionEntryToContextMessages);
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    modelKey: modelKey(ctx),
    contextGeneration: generation(entries),
    messages: mapMessagesToSessionEntries(
      sourceMessages,
      entries,
      ctx.sessionManager.getBranch(),
    ),
  };
}

function automaticIdentity(
  ctx: ExtensionContext,
  context: DecayContext,
): AutomaticDecayIdentity {
  return {
    sessionId: context.sessionId,
    branchLeafId: ctx.sessionManager.getLeafId(),
    modelKey: context.modelKey,
    contextGeneration: context.contextGeneration,
  };
}

export default function contextDecayExtension(pi: ExtensionAPI) {
  let config: ContextDecayPrivateConfig = DEFAULT_CONTEXT_DECAY_PRIVATE_CONFIG;
  let controller = createContextDecayShadowController(config);
  let automatic = createAutomaticDecayController(config);
  let governorSignal: AutomaticGovernorSignal | null = null;
  let cacheAdvisory: AutomaticCacheAdvisorySignal | null = null;
  let cacheSequence = 0;
  let latestReport: ContextDecayShadowReport | null = null;
  let sequence = 0;
  let activeContext: ExtensionContext | undefined;

  const stopGovernor = pi.events.on(CONTEXT_GOVERNOR_CHANNEL, (value) => {
    if (
      !isGovernorState(value) ||
      !activeContext ||
      value.pressure.level === null
    ) {
      governorSignal = null;
      return;
    }
    const context = decayContext(activeContext);
    const identity = automaticIdentity(activeContext, context);
    const sourceModelKey =
      value.model === null
        ? "no-model"
        : `${value.model.provider}/${value.model.id}/${value.model.contextWindow}`;
    if (
      value.sessionId !== identity.sessionId ||
      value.branchLeafId !== identity.branchLeafId ||
      sourceModelKey !== identity.modelKey ||
      value.capturedAtMs < (automatic.policyState()?.resetAtMs ?? 0)
    ) {
      governorSignal = null;
      return;
    }
    governorSignal = Object.freeze({
      ...identity,
      capturedAtMs: value.capturedAtMs,
      pressure: value.pressure.level,
    });
  });

  const stopCacheAudit = pi.events.on(CONTEXT_CACHE_AUDIT_CHANNEL, (value) => {
    if (!activeContext) return;
    const context = decayContext(activeContext);
    cacheSequence += 1;
    const candidate = cacheAdvisorySignalFromAudit(
      value,
      automaticIdentity(activeContext, context),
      cacheSequence,
      Date.now(),
    );
    if (candidate !== null) cacheAdvisory = candidate;
  });

  const emitAccounting = (
    ctx: ExtensionContext,
    context: DecayContext,
    plan: DecayPlan,
    report: ContextDecayShadowReport,
    output: readonly AgentMessage[],
    mode: ContextWireMode,
  ) => {
    sequence += 1;
    const applied = mode === "applied";
    pi.events.emit(
      CONTEXT_WIRE_STATE_CHANNEL,
      createContextWireState({
        sequence,
        mode,
        stable: applied && report.sequenceValid,
        sessionId: report.sessionId,
        branchLeafId: ctx.sessionManager.getLeafId(),
        modelKey: report.modelKey,
        contextGeneration: report.contextGeneration,
        inputFingerprint: contextWireFingerprint(
          context.messages.map((item) => item.message),
        ),
        outputFingerprint: contextWireFingerprint(output),
        residentTokens: report.residentTokens,
        effectiveWireTokens: report.effectiveWireTokens,
        tokensSaved: report.proposedTokensSaved,
        epochId: report.epochId,
        cacheEpochId: plan.epoch.id,
        provenance: applied
          ? "explicit-apply-transform"
          : mode === "armed"
            ? "explicit-apply-plan"
            : "shadow-plan",
        candidateCount: report.candidateCount,
        actionCount: report.replacementCount,
        sequenceValid: report.sequenceValid,
        inputMessageCount: context.messages.length,
        outputMessageCount: output.length,
      }),
    );
  };

  const currentPressure = (
    ctx: ExtensionContext,
    context: DecayContext,
    nowMs = Date.now(),
  ): string | null => {
    const signal = governorSignal;
    const identity = automaticIdentity(ctx, context);
    if (
      signal === null ||
      signal.sessionId !== identity.sessionId ||
      signal.branchLeafId !== identity.branchLeafId ||
      signal.modelKey !== identity.modelKey ||
      signal.contextGeneration !== identity.contextGeneration ||
      signal.capturedAtMs <= 0 ||
      nowMs - signal.capturedAtMs > config.automaticSignalMaximumAgeMs ||
      signal.capturedAtMs - nowMs > MAX_FUTURE_SIGNAL_SKEW_MS
    )
      return null;
    return signal.pressure;
  };

  const publishPlan = (
    ctx: ExtensionContext,
    context: DecayContext,
    mode: "shadow" | "explicit-apply-armed" = "shadow",
  ) => {
    const plan = controller.preview(context);
    latestReport = createShadowReport(
      plan,
      config.maximumReportedCandidates,
      mode,
      currentPressure(ctx, context),
    );
    pi.events.emit(CONTEXT_DECAY_SHADOW_CHANNEL, latestReport);
    emitAccounting(
      ctx,
      context,
      plan,
      latestReport,
      context.messages.map((item) => item.message),
      mode === "shadow" ? "shadow" : "armed",
    );
    return { plan, report: latestReport };
  };

  const stopControl = pi.events.on(CONTEXT_DECAY_CONTROL_CHANNEL, (value) => {
    if (!isContextDecayControlEvent(value)) return;
    if (
      !activeContext ||
      value.sessionId !== activeContext.sessionManager.getSessionId()
    ) {
      value.respond({
        schemaVersion: 1,
        sessionId: value.sessionId,
        action: value.action,
        status: "denied",
        reason: "session-mismatch",
      });
      return;
    }
    const context = decayContext(activeContext);
    if (value.action === "clear") {
      controller.reset();
      publishPlan(activeContext, context);
      value.respond({
        schemaVersion: 1,
        sessionId: value.sessionId,
        action: value.action,
        status: "cleared",
        reason: "enabled",
      });
      return;
    }
    const result = controller.requestExplicitApply(context);
    const mode = result.applied ? "explicit-apply-armed" : "shadow";
    const report = createShadowReport(
      result.plan,
      config.maximumReportedCandidates,
      mode,
      currentPressure(activeContext, context),
    );
    latestReport = report;
    pi.events.emit(CONTEXT_DECAY_SHADOW_CHANNEL, report);
    emitAccounting(
      activeContext,
      context,
      result.plan,
      report,
      context.messages.map((item) => item.message),
      result.applied ? "armed" : "shadow",
    );
    value.respond({
      schemaVersion: 1,
      sessionId: value.sessionId,
      action: value.action,
      status: result.applied ? "applied" : "denied",
      reason: result.reason,
      report,
    });
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadContextDecayConfig(contextDecayPaths().config);
    controller = createContextDecayShadowController(config);
    automatic = createAutomaticDecayController(config);
    governorSignal = null;
    cacheAdvisory = null;
    cacheSequence = 0;
    latestReport = null;
    sequence = 0;
    activeContext = ctx;
    const context = decayContext(ctx);
    automatic.reset(automaticIdentity(ctx, context), Date.now());
    publishPlan(ctx, context);
  });

  pi.on("context", (event, ctx) => {
    activeContext = ctx;
    const context = decayContext(ctx, event.messages);
    const identity = automaticIdentity(ctx, context);
    const explicitPlan = controller.activePlan();
    const explicitTransform = controller.transform(context);
    if (
      explicitPlan !== null &&
      explicitTransform !== null &&
      explicitTransform.validation.valid
    ) {
      latestReport = createShadowReport(
        explicitPlan,
        config.maximumReportedCandidates,
        "explicit-apply",
        currentPressure(ctx, context),
        explicitTransform,
      );
      pi.events.emit(CONTEXT_DECAY_SHADOW_CHANNEL, latestReport);
      emitAccounting(
        ctx,
        context,
        explicitPlan,
        latestReport,
        explicitTransform.messages,
        "applied",
      );
      return { messages: [...explicitTransform.messages] };
    }

    const automaticResult = automatic.consider({
      context,
      identity,
      governor: governorSignal,
      cacheAdvisory,
      nowMs: Date.now(),
    });
    const automaticPlan = automatic.activePlan();
    if (
      automaticPlan !== null &&
      automaticResult.transformed?.validation.valid === true
    ) {
      const acceptedPressure = automaticResult.decision.governorAccepted
        ? (governorSignal?.pressure ?? null)
        : null;
      latestReport = createShadowReport(
        automaticPlan,
        config.maximumReportedCandidates,
        "automatic-apply",
        acceptedPressure,
        automaticResult.transformed,
      );
      pi.events.emit(CONTEXT_DECAY_SHADOW_CHANNEL, latestReport);
      // The shared wire schema's normal stable applied state is reused for both
      // explicit and automatic in-memory epochs.
      emitAccounting(
        ctx,
        context,
        automaticPlan,
        latestReport,
        automaticResult.transformed.messages,
        "applied",
      );
      return { messages: [...automaticResult.transformed.messages] };
    }
    if (automaticPlan !== null) automatic.reset(identity, Date.now());
    publishPlan(ctx, context);
    return undefined;
  });

  const resetAndPublish = (ctx: ExtensionContext) => {
    controller.reset();
    governorSignal = null;
    cacheAdvisory = null;
    const context = decayContext(ctx);
    automatic.reset(automaticIdentity(ctx, context), Date.now());
    publishPlan(ctx, context);
  };
  pi.on("agent_settled", () => automatic.recordSettledRun());
  pi.on("session_compact", (_event, ctx) => resetAndPublish(ctx));
  pi.on("session_tree", (_event, ctx) => resetAndPublish(ctx));
  pi.on("model_select", (_event, ctx) => resetAndPublish(ctx));
  pi.on("session_shutdown", () => {
    controller.reset();
    automatic = createAutomaticDecayController(config);
    governorSignal = null;
    cacheAdvisory = null;
    latestReport = null;
    stopGovernor();
    stopCacheAudit();
    activeContext = undefined;
    stopControl();
  });

  pi.registerCommand("context-decay", {
    description:
      "Preview or explicitly apply reversible request-time context decay",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "preview";
      const context = decayContext(ctx);
      if (action === "clear") {
        controller.reset();
        publishPlan(ctx, context);
        ctx.ui.notify(
          "Context decay explicit epoch cleared; transcript was not changed.",
          "info",
        );
        return;
      }
      if (action === "apply") {
        const result = controller.requestExplicitApply(context);
        const mode = result.applied ? "explicit-apply-armed" : "shadow";
        const report = createShadowReport(
          result.plan,
          config.maximumReportedCandidates,
          mode,
          currentPressure(ctx, context),
        );
        latestReport = report;
        pi.events.emit(CONTEXT_DECAY_SHADOW_CHANNEL, report);
        emitAccounting(
          ctx,
          context,
          result.plan,
          report,
          context.messages.map((item) => item.message),
          result.applied ? "armed" : "shadow",
        );
        const prefix = result.applied
          ? "Explicit in-memory decay epoch armed for future provider requests. Durable transcript unchanged.\n"
          : `Apply denied: allowExplicitApply=false in ${contextDecayPaths().config}. Preview only.\n`;
        ctx.ui.notify(
          prefix +
            formatShadowReport(
              report,
              config.maximumReportCharacters - prefix.length,
            ),
          result.applied ? "warning" : "info",
        );
        return;
      }
      const { report } = publishPlan(ctx, context);
      ctx.ui.notify(
        formatShadowReport(report, config.maximumReportCharacters),
        "info",
      );
    },
  });
}

export * from "./src/adapter.ts";
export * from "./src/config.ts";
export * from "./src/engine.ts";
export * from "./src/types.ts";
export * from "./src/control.ts";
export * from "./src/automatic-policy.ts";
