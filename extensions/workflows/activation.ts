export const WORKFLOW_ACTIVATION_ENTRY = "workflow-tool-activated";
const REQUEST_VERBS = "run|start|launch|execute|use|create|build|orchestrate";

export function shouldActivateWorkflow(rawInput: string): boolean {
  if (/\bultracode\b/i.test(rawInput)) return true;
  const text = rawInput.replace(/\s+/g, " ").trim();
  if (!/\bworkflow\b/i.test(text)) return false;
  if (
    /\b(?:do not|don't|dont|without|avoid|no)\b.{0,24}\bworkflow\b/i.test(text)
  )
    return false;
  return (
    new RegExp(`\\b(?:${REQUEST_VERBS})\\b.{0,48}\\bworkflow\\b`, "i").test(
      text,
    ) ||
    new RegExp(`\\bworkflow\\b.{0,32}\\b(?:run|for|to|please)\\b`, "i").test(
      text,
    ) ||
    /\b(?:want|request|need)\b.{0,32}\bworkflow\b/i.test(text)
  );
}

interface API {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(type: string, data: unknown): void;
}
export function branchHasWorkflowActivation(entries: readonly unknown[]) {
  return entries.some((entry) => {
    const value = entry as {
      type?: string;
      customType?: string;
      message?: { role?: string; toolName?: string };
    };
    return (
      (value?.type === "custom" &&
        value.customType === WORKFLOW_ACTIVATION_ENTRY) ||
      (value?.type === "message" &&
        value.message?.role === "toolResult" &&
        value.message.toolName === "workflow")
    );
  });
}
export function initializeWorkflowTool(api: API, activated: boolean) {
  const active = api.getActiveTools();
  api.setActiveTools(
    activated
      ? [...new Set([...active, "workflow"])]
      : active.filter((name) => name !== "workflow"),
  );
}
export function activateWorkflowTool(api: API) {
  if (api.getActiveTools().includes("workflow")) return false;
  api.setActiveTools([...api.getActiveTools(), "workflow"]);
  api.appendEntry(WORKFLOW_ACTIVATION_ENTRY, { tools: ["workflow"] });
  return true;
}
