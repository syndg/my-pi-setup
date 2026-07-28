export const SUBAGENT_CONTROL_TOOL_NAMES = [
  "subagent_wait",
  "subagent_send",
  "subagent_inbox",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
] as const;

interface ToolActivationAPI {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data: unknown): void;
}

export const SUBAGENT_ACTIVATION_ENTRY = "subagent-tools-activated";

export function branchHasActivation(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as {
      type?: string;
      customType?: string;
      message?: { role?: string; toolName?: string };
    };
    return (
      (value.type === "custom" &&
        value.customType === SUBAGENT_ACTIVATION_ENTRY) ||
      (value.type === "message" &&
        value.message?.role === "toolResult" &&
        value.message.toolName === "subagent_spawn")
    );
  });
}

export function initializeSubagentTools(
  api: ToolActivationAPI,
  activated: boolean,
) {
  const active = api.getActiveTools();
  if (activated) {
    api.setActiveTools([
      ...new Set([...active, ...SUBAGENT_CONTROL_TOOL_NAMES]),
    ]);
  } else {
    api.setActiveTools(
      active.filter(
        (name) =>
          !(SUBAGENT_CONTROL_TOOL_NAMES as readonly string[]).includes(name),
      ),
    );
  }
}

export function activateSubagentTools(api: ToolActivationAPI, persist = true) {
  const active = api.getActiveTools();
  const next = [...new Set([...active, ...SUBAGENT_CONTROL_TOOL_NAMES])];
  if (next.length === active.length) return false;
  api.setActiveTools(next);
  if (persist)
    api.appendEntry(SUBAGENT_ACTIVATION_ENTRY, {
      tools: [...SUBAGENT_CONTROL_TOOL_NAMES],
    });
  return true;
}
