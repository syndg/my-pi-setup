import type { BashOptions } from "just-bash";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export const DEFAULT_CODE_MODE_TIMEOUT_MS = 30_000;
export const MAX_CODE_MODE_TIMEOUT_MS = 10 * 60_000;

export const CODE_MODE_LIMITS = {
  executionTimeMs: DEFAULT_CODE_MODE_TIMEOUT_MS,
  maxCalls: 25,
  maxSourceBytes: MEBIBYTE,
  maxOperationOutputBytes: 256 * KIBIBYTE,
  maxMcpArgumentBytes: MEBIBYTE,
  maxMcpResultBytes: 5 * MEBIBYTE,
  maxIntermediateBytes: 16 * MEBIBYTE,
  maxStdoutBytes: 50 * KIBIBYTE,
  maxStderrBytes: 50 * KIBIBYTE,
  maxReturnBytes: MEBIBYTE,
  maxFileSystemBytes: 32 * MEBIBYTE,
  maxStatusBytes: 512,
} as const;

/**
 * Start from just-bash's hardened profile and override only the resources fixed
 * by the Code Mode plan. QuickJS keeps just-bash's 64 MiB memory default.
 */
export function codeModeExecutionLimits(
  executionTimeMs: number = CODE_MODE_LIMITS.executionTimeMs,
) {
  return {
    ...CODE_MODE_EXECUTION_LIMITS,
    maxExecutionTimeMs: executionTimeMs,
    maxJsTimeoutMs: executionTimeMs,
  } satisfies NonNullable<BashOptions["executionLimits"]>;
}

export const CODE_MODE_EXECUTION_LIMITS = {
  maxSourceBytes: CODE_MODE_LIMITS.maxSourceBytes,
  maxFileSystemBytes: CODE_MODE_LIMITS.maxFileSystemBytes,
  maxExecutionTimeMs: CODE_MODE_LIMITS.executionTimeMs,
  maxJsTimeoutMs: CODE_MODE_LIMITS.executionTimeMs,
  maxWorkerMessageBytes: 6 * MEBIBYTE,
  maxStringLength: CODE_MODE_LIMITS.maxIntermediateBytes,
  maxOutputSize:
    CODE_MODE_LIMITS.maxReturnBytes +
    CODE_MODE_LIMITS.maxStdoutBytes +
    CODE_MODE_LIMITS.maxStderrBytes +
    4 * KIBIBYTE,
} satisfies NonNullable<BashOptions["executionLimits"]>;
