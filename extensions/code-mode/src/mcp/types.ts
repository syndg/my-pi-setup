import type { CodeModeMcpResult, CodeModeTraceEntry } from "../types.ts";

export type PermissionDecision = "allow" | "ask" | "deny";
export type ConfigScope = "global" | "project";

export type StdioServerConfig = {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  requestTimeoutMs?: number;
  oauth?: false;
};

export type HttpServerConfig = {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  requestTimeoutMs?: number;
  oauth?: boolean;
};

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export type CodeModeConfig = {
  servers: Record<string, ServerConfig>;
  permissions?: Record<string, PermissionDecision>;
  defaultPermission?: PermissionDecision;
  executionTimeoutMs?: number;
};

export type ServerRecord = {
  name: string;
  scope: ConfigScope;
  config: ServerConfig;
  enabled: boolean;
  status?: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  toolCount?: number;
};

export type CatalogTool = {
  path: string;
  server: string;
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  freshness: "cached" | "live";
};

export type SearchInput = {
  query: string;
  limit?: number;
  cursor?: string;
};

export type SearchMatch = {
  path: string;
  description?: string;
  input: string;
  freshness: "cached" | "live";
};

export type SearchResult = {
  items: SearchMatch[];
  nextCursor?: string;
};

export type ToolDescription = {
  path: string;
  description?: string;
  input: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  freshness: "cached" | "live";
};

export type CallInput = {
  path: string;
  args: unknown;
};

export type HostOptions = {
  signal: AbortSignal;
};

export type ApprovalRequest = {
  path: string;
  description?: string;
  arguments: unknown;
  exactSecrets?: readonly string[];
  parentToolCallId: string;
  callCount: number;
  maxCalls: number;
  signal: AbortSignal;
};

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export type CallStatus = {
  message: string;
  trace?: CodeModeTraceEntry;
};

export type CallOptions = HostOptions & {
  parentToolCallId: string;
  callCount?: number;
  maxCalls?: number;
  onStatus?: (status: CallStatus) => void;
  approve?: ApprovalHandler;
};

export type McpHost = {
  search(input: SearchInput, options: HostOptions): Promise<SearchResult>;
  describe(path: string, options: HostOptions): Promise<ToolDescription>;
  call(input: CallInput, options: CallOptions): Promise<CodeModeMcpResult>;
  close(): Promise<void>;
};

export type RemoveServerOptions = {
  scope?: ConfigScope;
  removeCredentials?: boolean;
};

export type AddServerInput = {
  name: string;
  scope: ConfigScope;
  config: ServerConfig;
};

export type McpRegistry = {
  list(): Promise<ServerRecord[]>;
  add(input: AddServerInput): Promise<ServerRecord>;
  remove(name: string, options?: RemoveServerOptions): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  reload(): Promise<void>;
};
