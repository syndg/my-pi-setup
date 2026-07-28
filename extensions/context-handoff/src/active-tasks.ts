import type { ActiveTask } from "./types.ts";

const MAX_TRACKED = 64;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ActiveTaskTracker {
  readonly #tasks = new Map<string, ActiveTask>();
  readonly #tools = new Map<string, ActiveTask>();
  #clock: () => number;
  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  toolStarted(toolCallId: string, toolName: string) {
    if (!/^(?:bg_|subagent_)/.test(toolName)) return;
    this.#tools.set(toolCallId, {
      id: toolCallId,
      kind: "tool",
      label: toolName,
      status: "running",
      observedAtMs: this.#clock(),
    });
  }
  toolEnded(toolCallId: string) {
    this.#tools.delete(toolCallId);
  }

  observeResult(toolName: string, details: unknown) {
    const data = record(details);
    if (!data) return;
    const kind = toolName.startsWith("bg_")
      ? "background"
      : toolName.startsWith("subagent_")
        ? "subagent"
        : undefined;
    if (!kind) return;
    const collections = [data.terminals, data.subagents, data.results];
    const values = collections.flatMap((value) =>
      Array.isArray(value) ? value : [],
    );
    if (typeof data.id === "string") values.push(data);
    for (const item of values.slice(0, MAX_TRACKED)) {
      const value = record(item);
      if (!value || typeof value.id !== "string") continue;
      const status = value.status;
      if (status === "running" || status === undefined) {
        this.#tasks.set(value.id, {
          id: value.id,
          kind,
          label: typeof value.title === "string" ? value.title : toolName,
          status: status === "running" ? "running" : "uncertain",
          observedAtMs: this.#clock(),
        });
      } else {
        this.#tasks.delete(value.id);
      }
    }
  }

  list(): readonly ActiveTask[] {
    const cutoff = this.#clock() - MAX_AGE_MS;
    for (const [id, task] of this.#tasks)
      if (task.observedAtMs < cutoff) this.#tasks.delete(id);
    return [...this.#tools.values(), ...this.#tasks.values()].slice(
      0,
      MAX_TRACKED,
    );
  }
  reset() {
    this.#tasks.clear();
    this.#tools.clear();
  }
}
