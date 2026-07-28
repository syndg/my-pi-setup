import type { GovernorState } from "../../shared/context-governor-state.ts";
import type { GovernorConfig } from "./config.ts";

export interface StatusReportPaths {
  readonly config: string;
  readonly telemetry: string;
  readonly nativeLimitProvenance?: "runtime-resolved" | "settings-file-derived";
  readonly contextUsageProvenance?: string;
}

function tokens(value: number | null) {
  if (value === null) return "unknown";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toLocaleString("en-US");
}

function signedTokens(value: number | null) {
  if (value === null) return "unknown";
  return `${value >= 0 ? "+" : ""}${tokens(value)}`;
}

function decimal(value: number | null, suffix = "") {
  return value === null ? "unknown" : `${value.toFixed(1)}${suffix}`;
}

function readiness(sampleCount: number, minimum: number) {
  return `${sampleCount >= minimum ? "ready" : "warming"} ${sampleCount}/${minimum}`;
}

function measurementLabel(
  state: Readonly<GovernorState>,
  runtimeProvenance?: string,
) {
  const { source, unknownReason } = state.measurement;
  if (source === "message-estimate") return "message-estimate (estimated)";
  if (source === "unknown") {
    return `unknown${unknownReason ? ` (${unknownReason})` : ""}`;
  }
  return runtimeProvenance ? `${source} (${runtimeProvenance})` : source;
}

function nativeLimit(
  state: Readonly<GovernorState>,
  provenance:
    "runtime-resolved" | "settings-file-derived" = "settings-file-derived",
) {
  const native = state.budget;
  const proactive =
    native.nativeProactiveEnabled === null
      ? "unknown"
      : native.nativeProactiveEnabled
        ? "on"
        : "off";
  if (native.nativeSource === "unavailable") {
    return `unavailable (settings unavailable; proactive ${proactive})`;
  }
  const provenanceLabel =
    provenance === "runtime-resolved"
      ? "runtime resolved"
      : "settings-file derived";
  const source = `${provenanceLabel}; ${native.nativeSource}; proactive ${proactive}`;
  if (native.nativeLimitTokens === null) {
    return `none (${source})`;
  }
  return `${tokens(native.nativeLimitTokens)} (${source})`;
}

function toolByteLines(state: Readonly<GovernorState>) {
  const entries = Object.entries(state.toolResultBytesByTool).sort(
    (left, right) => right[1] - left[1],
  );
  if (entries.length === 0) return ["  (none)"];
  return entries.map(
    ([tool, bytes]) => `  ${tool}: ${bytes.toLocaleString("en-US")} bytes`,
  );
}

function wireLine(state: Readonly<GovernorState>) {
  const wire = state.wireAccounting;
  if (wire === null) return "Decay accounting: unavailable or not current";
  const label =
    wire.mode === "applied"
      ? "applied"
      : wire.mode === "armed"
        ? "armed (not yet applied)"
        : "shadow proposal";
  return `Decay accounting: ${label} · resident ${tokens(wire.residentTokens)} · wire ${tokens(wire.effectiveWireTokens)} · saved ${tokens(wire.tokensSaved)} · epoch ${wire.epochId} · candidates ${wire.candidateCount} · actions ${wire.actionCount} · ${wire.provenance}`;
}

export function formatStatusReport(
  state: Readonly<GovernorState>,
  config: Readonly<GovernorConfig>,
  paths: StatusReportPaths,
) {
  const model = state.model
    ? `${state.model.provider}/${state.model.id}`
    : "none";
  const percent = decimal(state.measurement.percent, "%");
  const pressure = state.pressure.level ?? "unknown";
  const reasons =
    state.pressure.reasons.length > 0
      ? state.pressure.reasons.join("; ")
      : "none";

  return [
    "Context Governor (advisory only)",
    `Model: ${model} · window ${tokens(state.measurement.contextWindow)}`,
    `Context: ${tokens(state.measurement.tokens)} · ${percent} · ${measurementLabel(state, paths.contextUsageProvenance)}`,
    wireLine(state),
    `Pressure basis: ${tokens(state.pressureTokens)} (${state.pressureTokenSource})`,
    `Native limit: ${nativeLimit(state, paths.nativeLimitProvenance)}`,
    `Advisory limit: ${tokens(state.budget.advisoryLimitTokens)} (${config.advisorySafePercent}%)`,
    `Effective safe limit: ${tokens(state.budget.effectiveSafeLimitTokens)} (${state.budget.effectiveSource})`,
    `Headroom: ${signedTokens(state.headroomTokens)} · safe ratio ${decimal(state.safeLimitRatio === null ? null : state.safeLimitRatio * 100, "%")}`,
    `Growth: latest ${signedTokens(state.growth.latestTokens)} · EWMA ${tokens(state.growth.ewmaTokens)} · P95 ${tokens(state.growth.p95Tokens)} · conservative ${tokens(state.growth.conservativeTokens)} · n=${state.growth.sampleCount}`,
    `Estimator gates: P95 ${readiness(state.growth.sampleCount, config.minimumP95Samples)} · runway pressure ${readiness(state.growth.sampleCount, config.minimumRunwaySamples)}`,
    `Runway: ${state.runwayRuns === null ? "unknown" : `~${state.runwayRuns.toFixed(1)} similar runs`}`,
    `Pressure: ${pressure} · ${reasons}`,
    "Latest settled run tool-result bytes:",
    ...toolByteLines(state),
    `Notice: ${config.notice.enabled ? "enabled" : "disabled"} · max ${config.notice.maxCharacters} chars`,
    `Telemetry: ${config.telemetry.enabled ? "enabled" : "disabled"} · ${paths.telemetry}`,
    `Config: ${paths.config}`,
  ].join("\n");
}
