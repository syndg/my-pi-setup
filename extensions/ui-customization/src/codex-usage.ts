import { Buffer } from "node:buffer";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

export interface CodexWeeklyUsage {
  usedPercent: number;
  remainingPercent: number;
  resetsAtMs?: number;
  fetchedAtMs: number;
}

interface ParsedWindow {
  usedPercent: number;
  durationSeconds?: number;
  resetsAtMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseResetAt(
  resetAt: unknown,
  resetAfterSeconds: unknown,
  nowMs: number,
): number | undefined {
  const absolute = finiteNumber(resetAt);
  if (absolute !== undefined) {
    return absolute > 1_000_000_000_000 ? absolute : absolute * 1_000;
  }

  const relative = finiteNumber(resetAfterSeconds);
  return relative === undefined ? undefined : nowMs + relative * 1_000;
}

function parseWindow(value: unknown, nowMs: number): ParsedWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === undefined) return undefined;

  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    durationSeconds: finiteNumber(value.limit_window_seconds),
    resetsAtMs: parseResetAt(value.reset_at, value.reset_after_seconds, nowMs),
  };
}

function selectWeeklyWindow(
  primary: ParsedWindow | undefined,
  secondary: ParsedWindow | undefined,
): ParsedWindow | undefined {
  const windows = [primary, secondary].filter(
    (window): window is ParsedWindow => window !== undefined,
  );
  const weekly = windows
    .filter(
      (window) =>
        window.durationSeconds !== undefined &&
        window.durationSeconds >= 6 * DAY_SECONDS,
    )
    .sort(
      (left, right) =>
        Math.abs((left.durationSeconds ?? 0) - WEEK_SECONDS) -
        Math.abs((right.durationSeconds ?? 0) - WEEK_SECONDS),
    );

  if (weekly[0]) return weekly[0];

  // Older response snapshots sometimes omit the duration. In those, the
  // secondary window is the long-running quota window.
  if (secondary?.durationSeconds === undefined) return secondary;
  return undefined;
}

function toUsage(
  window: ParsedWindow | undefined,
  fetchedAtMs: number,
): CodexWeeklyUsage | undefined {
  if (!window) return undefined;
  return {
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    resetsAtMs: window.resetsAtMs,
    fetchedAtMs,
  };
}

export function parseCodexWeeklyUsagePayload(
  payload: unknown,
  fetchedAtMs = Date.now(),
): CodexWeeklyUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return undefined;
  const rateLimit = payload.rate_limit;
  return toUsage(
    selectWeeklyWindow(
      parseWindow(rateLimit.primary_window, fetchedAtMs),
      parseWindow(rateLimit.secondary_window, fetchedAtMs),
    ),
    fetchedAtMs,
  );
}

export function parseCodexWeeklyUsageHeaders(
  headers: Record<string, string>,
  fetchedAtMs = Date.now(),
): CodexWeeklyUsage | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const parseHeaderWindow = (
    name: "primary" | "secondary",
  ): ParsedWindow | undefined => {
    const usedPercent = finiteNumber(
      normalized[`x-codex-${name}-used-percent`],
    );
    if (usedPercent === undefined) return undefined;
    const windowMinutes = finiteNumber(
      normalized[`x-codex-${name}-window-minutes`],
    );
    return {
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      durationSeconds:
        windowMinutes === undefined ? undefined : windowMinutes * 60,
      resetsAtMs: parseResetAt(
        normalized[`x-codex-${name}-reset-at`],
        undefined,
        fetchedAtMs,
      ),
    };
  };

  return toUsage(
    selectWeeklyWindow(
      parseHeaderWindow("primary"),
      parseHeaderWindow("secondary"),
    ),
    fetchedAtMs,
  );
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    return typeof auth.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexWeeklyUsage(
  accessToken: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<CodexWeeklyUsage | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "Pi-Codex-Usage/1.0",
  };
  const accountId = extractAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const response = await (options.fetch ?? globalThis.fetch)(CODEX_USAGE_URL, {
    headers,
    signal: options.signal,
  });
  if (!response.ok) return undefined;
  return parseCodexWeeklyUsagePayload(await response.json());
}

function formatRemainingTime(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatCodexWeeklyUsage(
  usage: CodexWeeklyUsage,
  nowMs = Date.now(),
): string {
  const remaining = Math.round(usage.remainingPercent);
  const reset =
    usage.resetsAtMs !== undefined && usage.resetsAtMs > nowMs
      ? ` · resets ${formatRemainingTime(usage.resetsAtMs - nowMs)}`
      : "";
  return `Codex week ${remaining}% left${reset}`;
}
