import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

export const CHILD_TOOL_PROFILE_NAMES = [
  "research",
  "coding",
  "review",
  "minimal",
] as const;

export type ChildToolProfile = (typeof CHILD_TOOL_PROFILE_NAMES)[number];

/** Defense-in-depth: child profiles can never opt into recursive orchestration or user interaction. */
export const CHILD_FORBIDDEN_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_send",
  "subagent_inbox",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "bg_start",
  "bg_status",
  "bg_list",
  "bg_kill",
  "workflow",
  "ask_user",
] as const;

const CHILD_PROFILE_TOOLS: Record<ChildToolProfile, readonly string[]> = {
  research: ["read", "bash", "grep", "find", "ls", "rg", "fd", "mcp"],
  coding: [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "rg",
    "fd",
    "mcp",
  ],
  review: ["read", "bash", "grep", "find", "ls", "rg", "fd"],
  minimal: ["read"],
};

/**
 * Explicit schema allowlists for headless children. Required one-shot/bridge
 * tools are additive, while the safety denylist remains a final backstop.
 */
export function childToolPolicy(
  profile: ChildToolProfile = "coding",
  requiredTools: readonly string[] = [],
) {
  const forbidden = new Set<string>(CHILD_FORBIDDEN_TOOL_NAMES);
  const tools = [
    ...new Set(
      [...CHILD_PROFILE_TOOLS[profile], ...requiredTools].filter(
        (name) => !forbidden.has(name),
      ),
    ),
  ];
  return {
    tools,
    excludeTools: [...CHILD_FORBIDDEN_TOOL_NAMES],
  };
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await session.bindExtensions({ mode: "print" });
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
