import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createContextMemory,
  projectMemoryScope,
  type ContextMemoryOptions,
} from "./src/core.ts";
import { createFileMemoryPersistence } from "./src/persistence.ts";
import {
  createOneTurnRecallGate,
  formatMemorySearchResult,
} from "./src/recall.ts";
import {
  MEMORY_CATEGORIES,
  MEMORY_SOURCE_KINDS,
  type ConsolidateMemoryInput,
  type ContextMemory,
  type MemoryCategory,
  type MemorySearchScope,
  type MemorySourceKind,
  type RememberMemoryInput,
  type SearchMemoryInput,
} from "./src/types.ts";

const SEARCH_SCOPES = ["global", "project", "all"] as const;

export interface ContextMemoryExtensionOptions {
  readonly memory?: ContextMemory;
  readonly filePath?: string;
  readonly memoryOptions?: Omit<ContextMemoryOptions, "persistence">;
  readonly maximumOneTurnRecallBytes?: number;
}

export function contextMemoryPath(): string {
  return join(getAgentDir(), "context-memory", "memory.v1.json");
}

function projectFor(scope: MemorySearchScope, cwd: string): string | undefined {
  return scope === "global" ? undefined : cwd;
}

function commandObject(raw: string, usage: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`Expected a JSON object. Usage: ${usage}`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`${name} must be a number`);
  return value;
}

function category(value: unknown): MemoryCategory {
  if (
    typeof value !== "string" ||
    !(MEMORY_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new Error(`category must be one of: ${MEMORY_CATEGORIES.join(", ")}`);
  }
  return value as MemoryCategory;
}

function sourceKind(value: unknown): MemorySourceKind {
  if (
    typeof value !== "string" ||
    !(MEMORY_SOURCE_KINDS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `source_kind must be one of: ${MEMORY_SOURCE_KINDS.join(", ")}`,
    );
  }
  return value as MemorySourceKind;
}

function searchScope(value: unknown): MemorySearchScope {
  if (value === undefined) return "all";
  if (
    typeof value !== "string" ||
    !(SEARCH_SCOPES as readonly string[]).includes(value)
  ) {
    throw new Error(`scope must be one of: ${SEARCH_SCOPES.join(", ")}`);
  }
  return value as MemorySearchScope;
}

function rememberInput(
  value: Record<string, unknown>,
  cwd: string,
): RememberMemoryInput {
  const selectedScope =
    value.scope === "global"
      ? "global"
      : value.scope === "project"
        ? "project"
        : undefined;
  if (selectedScope === undefined)
    throw new Error("scope must be global or project");
  return {
    category: category(value.category),
    scope:
      selectedScope === "global" ? { kind: "global" } : projectMemoryScope(cwd),
    fact: requiredString(value.fact, "fact"),
    source: {
      kind: sourceKind(value.source_kind),
      reference: requiredString(value.reference, "reference"),
    },
    confidence: optionalNumber(value.confidence, "confidence"),
    retentionDays: optionalNumber(value.retention_days, "retention_days"),
  };
}

function searchInput(
  value: Record<string, unknown>,
  cwd: string,
): SearchMemoryInput {
  const scope = searchScope(value.scope);
  const selectedCategory =
    value.category === undefined ? undefined : category(value.category);
  return {
    scope,
    project: projectFor(scope, cwd),
    query:
      value.query === undefined
        ? undefined
        : requiredString(value.query, "query"),
    category: selectedCategory,
    limit: optionalNumber(value.limit, "limit"),
    maxBytes: optionalNumber(value.max_bytes, "max_bytes"),
  };
}

function consolidateInput(
  value: Record<string, unknown>,
  cwd: string,
): ConsolidateMemoryInput {
  const scope = searchScope(value.scope);
  return { scope, project: projectFor(scope, cwd) };
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(
    error instanceof Error ? error.message : String(error),
    "error",
  );
}

export function createContextMemoryExtension(
  options: ContextMemoryExtensionOptions = {},
) {
  return function contextMemoryExtension(pi: ExtensionAPI) {
    const memory =
      options.memory ??
      createContextMemory({
        persistence: createFileMemoryPersistence(
          options.filePath ?? contextMemoryPath(),
        ),
        ...options.memoryOptions,
      });
    const recallGate = createOneTurnRecallGate(
      options.maximumOneTurnRecallBytes,
    );

    pi.on("session_start", () => recallGate.reset());
    pi.on("session_tree", () => recallGate.reset());
    pi.on("session_compact", () => recallGate.reset());
    pi.on("context", (event) => ({
      messages: [...recallGate.transform(event.messages)],
    }));

    pi.registerTool({
      name: "memory_search",
      label: "Search stable memory",
      description:
        "Recall bounded stable cross-session facts for the current project/global scope. Results enter provider context for one turn only.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        scope: Type.Optional(StringEnum(SEARCH_SCOPES)),
        category: Type.Optional(StringEnum(MEMORY_CATEGORIES)),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        max_bytes: Type.Optional(Type.Integer({ minimum: 128, maximum: 8192 })),
      }),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const scope = params.scope ?? "all";
        const result = await memory.search({
          query: params.query,
          scope,
          project: projectFor(scope, ctx.cwd),
          category: params.category,
          limit: params.limit,
          maxBytes: params.max_bytes,
        });
        const text = formatMemorySearchResult(
          result,
          params.max_bytes ?? result.maximumBytes,
        );
        recallGate.arm(toolCallId);
        return {
          content: [{ type: "text", text }],
          details: {
            returned: result.matches.length,
            matched: result.matched,
            limited: result.limited,
            ids: result.matches.map((match) => match.record.id),
          },
        };
      },
    });

    pi.registerCommand("memory-remember", {
      description: "Explicitly store one stable fact from a JSON object",
      handler: async (raw, ctx) => {
        try {
          const value = commandObject(
            raw,
            '/memory-remember {"category":"user-preference","scope":"global","fact":"...","source_kind":"user-statement","reference":"..."}',
          );
          const result = await memory.remember(rememberInput(value, ctx.cwd));
          ctx.ui.notify(
            `${result.created ? "Remembered" : "Deduplicated"} ${result.record.id}.`,
            "info",
          );
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.registerCommand("memory-search", {
      description: "Search bounded stable memory with an optional JSON object",
      handler: async (raw, ctx) => {
        try {
          const value = commandObject(
            raw,
            '/memory-search {"query":"typescript","scope":"all"}',
          );
          const result = await memory.search(searchInput(value, ctx.cwd));
          ctx.ui.notify(formatMemorySearchResult(result), "info");
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.registerCommand("memory-forget", {
      description: "Explicitly delete a memory by ID",
      handler: async (raw, ctx) => {
        try {
          const value = raw.trim().startsWith("{")
            ? requiredString(
                commandObject(raw, "/memory-forget mem_id").id,
                "id",
              )
            : requiredString(raw.trim(), "id");
          const result = await memory.forget({ id: value, project: ctx.cwd });
          ctx.ui.notify(
            result.forgotten
              ? `Forgot ${result.id}.`
              : `${result.id} not found in global/current-project scope.`,
            "info",
          );
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.registerCommand("memory-consolidate", {
      description:
        "Explicitly deduplicate and apply retention with an optional JSON scope",
      handler: async (raw, ctx) => {
        try {
          const result = await memory.consolidate(
            consolidateInput(
              commandObject(raw, '/memory-consolidate {"scope":"all"}'),
              ctx.cwd,
            ),
          );
          ctx.ui.notify(
            `Merged ${result.duplicatesMerged}; expired ${result.expiredRemoved}; ${result.after} remain.`,
            "info",
          );
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });
  };
}

export default createContextMemoryExtension();

export * from "./src/core.ts";
export * from "./src/persistence.ts";
export * from "./src/recall.ts";
export * from "./src/secrets.ts";
export * from "./src/types.ts";
