import type {
  GovernorState,
  PressureLevel,
} from "../../shared/context-governor-state.ts";
import { isAppliedContextWireState } from "../../shared/context-wire-state.ts";

export type ContextFooterTone = "muted" | PressureLevel;

export type ContextFooterRole =
  "measurement" | "safe-limit" | "growth" | "runway" | "pressure" | "separator";

/** Plain-text segment that the footer adapter can color without parsing text. */
export interface ContextFooterSegment {
  readonly text: string;
  readonly role: ContextFooterRole;
  readonly tone: ContextFooterTone;
}

type MetricRole = Exclude<ContextFooterRole, "separator">;

interface Metric {
  readonly text: string;
  readonly role: MetricRole;
  readonly tone: ContextFooterTone;
}

const SEPARATOR: ContextFooterSegment = {
  text: " · ",
  role: "separator",
  tone: "muted",
};

function finite(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: number | null) {
  const known = finite(value);
  return known !== undefined && known >= 0 ? known : undefined;
}

function formatCompactTokens(value: number) {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (magnitude < 1_000) return `${sign}${Math.round(magnitude)}`;
  if (magnitude < 10_000) return `${sign}${(magnitude / 1_000).toFixed(1)}k`;
  if (magnitude < 1_000_000) return `${sign}${Math.round(magnitude / 1_000)}k`;
  return `${sign}${(magnitude / 1_000_000).toFixed(1)}m`;
}

function metric(
  role: MetricRole,
  text: string,
  tone: ContextFooterTone = "muted",
): Metric {
  return { text, role, tone };
}

function measurementMetric(state: Readonly<GovernorState>) {
  if (isAppliedContextWireState(state.wireAccounting)) {
    const resident = formatCompactTokens(state.wireAccounting.residentTokens);
    const wire = formatCompactTokens(state.wireAccounting.effectiveWireTokens);
    return metric("measurement", `R${resident} W${wire}`);
  }
  const tokens = nonNegative(state.measurement.tokens);
  const contextWindow = nonNegative(state.measurement.contextWindow);
  const capacity =
    contextWindow !== undefined && contextWindow > 0
      ? formatCompactTokens(contextWindow)
      : "unknown";
  const occupancy =
    tokens === undefined
      ? `unknown/${capacity}`
      : `${formatCompactTokens(tokens)}/${capacity}`;

  if (state.measurement.source === "message-estimate") {
    return metric("measurement", `est ${occupancy}`);
  }
  if (state.measurement.source === "unknown") {
    return metric("measurement", `unknown/${capacity}`);
  }
  return metric("measurement", occupancy);
}

function safeLimitMetric(state: Readonly<GovernorState>) {
  const safeLimit = nonNegative(state.budget.effectiveSafeLimitTokens);
  return metric(
    "safe-limit",
    `safe ${safeLimit === undefined ? "unknown" : formatCompactTokens(safeLimit)}`,
  );
}

function growthMetric(state: Readonly<GovernorState>) {
  const latest = finite(state.growth.latestTokens);
  if (latest === undefined) return undefined;

  const formatted = formatCompactTokens(latest);
  return metric("growth", latest >= 0 ? `+${formatted}` : formatted);
}

function runwayMetric(state: Readonly<GovernorState>, compact: boolean) {
  const runway = finite(state.runwayRuns);
  if (runway === undefined) return undefined;
  if (runway <= 0) return metric("runway", "runway exhausted");
  return metric("runway", `~${runway.toFixed(1)}${compact ? "r" : " runs"}`);
}

function pressureMetric(level: PressureLevel | null, explicitUnknown: boolean) {
  if (level === null) {
    return metric("pressure", explicitUnknown ? "pressure unknown" : "unknown");
  }
  return metric("pressure", level, level);
}

function segmentMetrics(metrics: readonly Metric[]) {
  const segments: ContextFooterSegment[] = [];
  for (const item of metrics) {
    if (segments.length > 0) segments.push(SEPARATOR);
    segments.push(item);
  }
  return segments;
}

export function contextFooterText(segments: readonly ContextFooterSegment[]) {
  return segments.map((segment) => segment.text).join("");
}

function displayWidth(segments: readonly ContextFooterSegment[]) {
  // Formatter output is control-free and uses only single-cell characters.
  return Array.from(contextFooterText(segments)).length;
}

function truncateMetric(metricToFit: Metric, width: number) {
  if (width <= 0) return [];
  const characters = Array.from(metricToFit.text);
  if (characters.length <= width) return [metricToFit];

  const text =
    width === 1 ? "…" : `${characters.slice(0, width - 1).join("")}…`;
  return [{ ...metricToFit, text }];
}

/**
 * Formats one published governor snapshot without deriving pressure or policy.
 * The first candidate that fits wins, making narrow-width degradation stable.
 */
export function formatContextFooter(
  state: Readonly<GovernorState>,
  width: number,
): readonly ContextFooterSegment[] {
  const availableWidth = Number.isFinite(width)
    ? Math.max(0, Math.floor(width))
    : 0;
  if (!state.footerEnabled || availableWidth === 0) return [];

  const measurement = measurementMetric(state);
  const safeLimit = safeLimitMetric(state);
  const growth = growthMetric(state);
  const runway = runwayMetric(state, false);
  const compactRunway = runwayMetric(state, true);
  const pressure = pressureMetric(state.pressure.level, true);
  const compactPressure = pressureMetric(state.pressure.level, false);

  const forecast = [growth, runway].filter(
    (item): item is Metric => item !== undefined,
  );
  const compactForecast = [growth, compactRunway].filter(
    (item): item is Metric => item !== undefined,
  );
  const compactRunwayOnly = compactRunway ? [compactRunway] : [];
  const candidates = [
    [measurement, safeLimit, ...forecast, pressure],
    [measurement, ...forecast, compactPressure],
    [measurement, ...compactForecast, compactPressure],
    [measurement, safeLimit, compactPressure],
    [measurement, ...compactRunwayOnly, compactPressure],
    [measurement, compactPressure],
    [measurement],
    [compactPressure],
  ];

  for (const candidate of candidates) {
    const segments = segmentMetrics(candidate);
    if (displayWidth(segments) <= availableWidth) return segments;
  }

  return truncateMetric(compactPressure, availableWidth);
}
