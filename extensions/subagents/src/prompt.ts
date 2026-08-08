/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless Pi agent with its own context window and this environment's tools and config. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can be running at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background Pi subagent (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Pi is the only available subagent harness.",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "At Yellow+ context pressure, prefer narrowly scoped delegation and choose the least-privilege research, coding, review, or minimal profile; delegation remains optional and is never automatic.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness: 'Harness to run the subagent on. Only "pi" is available.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Pi model hint: "provider/model-id" or a bare, unambiguous model id. Omit to inherit the current model.',
  reasoningEffort:
    "Pi thinking level. Omit to inherit the current thinking level.",
  profile:
    'Execution profile: "coding" (default), "research", "review", or "minimal". Pi enforces the matching tool-schema allowlist. Every profile selects an explicit pressure-aware final-report budget.',
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a message from the parent orchestrator to one running subagent. Pi children receive it as steering input at the next safe turn boundary. This never contacts sibling agents and never restarts a settled child.";

export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Running subagent id, e.g. "sa-1"',
  message: "Concise new context, direction, or answer for the child",
  replyTo: "Optional child message id being answered, such as cm-1",
};

export const SUBAGENT_INBOX_TOOL_DESCRIPTION =
  "Read and clear the bounded session-local inbox of child messages whose live delivery was unavailable. Successfully delivered live messages are acknowledged and omitted to prevent duplicate transcript entries.";

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
