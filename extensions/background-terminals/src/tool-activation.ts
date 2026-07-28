export const BG_CONTROL_TOOL_NAMES = [
  "bg_status",
  "bg_list",
  "bg_kill",
] as const;
export const BG_ACTIVATION_ENTRY = "background-tools-activated";
interface API {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(type: string, data: unknown): void;
}
export function branchHasBgActivation(entries: readonly unknown[]) {
  return entries.some((entry) => {
    const value = entry as {
      type?: string;
      customType?: string;
      message?: { role?: string; toolName?: string };
    };
    return (
      (value?.type === "custom" && value.customType === BG_ACTIVATION_ENTRY) ||
      (value?.type === "message" &&
        value.message?.role === "toolResult" &&
        value.message.toolName === "bg_start")
    );
  });
}
export function initializeBgTools(api: API, activated: boolean) {
  const active = api.getActiveTools();
  api.setActiveTools(
    activated
      ? [...new Set([...active, ...BG_CONTROL_TOOL_NAMES])]
      : active.filter(
          (name) =>
            !(BG_CONTROL_TOOL_NAMES as readonly string[]).includes(name),
        ),
  );
}
export function activateBgTools(api: API) {
  const active = api.getActiveTools();
  const next = [...new Set([...active, ...BG_CONTROL_TOOL_NAMES])];
  if (next.length === active.length) return false;
  api.setActiveTools(next);
  api.appendEntry(BG_ACTIVATION_ENTRY, { tools: [...BG_CONTROL_TOOL_NAMES] });
  return true;
}
