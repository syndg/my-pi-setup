import type { ApprovalHandler, McpHost } from "./mcp/types.ts";

export type CodeModeContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data?: string }
  | { type: "resource"; uri: string; text?: string };

export type CodeModeMcpResult = {
  ok: boolean;
  content: CodeModeContent[];
  structuredContent?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

export type CodeModeTraceEntry = {
  server: string;
  tool: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error" | "denied" | "cancelled";
  inputBytes: number;
  outputBytes: number;
};

export type CodeModeStatus = {
  message: string;
  calls: number;
  maxCalls: number;
};

export type RuntimeOptions = {
  host: McpHost;
  signal: AbortSignal;
  parentToolCallId: string;
  executionTimeoutMs?: number;
  onStatus?: (status: CodeModeStatus) => void;
  approve?: ApprovalHandler;
};

export type RuntimeResult = {
  value?: unknown;
  stdout: string;
  stderr: string;
  trace: CodeModeTraceEntry[];
  calls: number;
  durationMs: number;
  cancelled: boolean;
};
