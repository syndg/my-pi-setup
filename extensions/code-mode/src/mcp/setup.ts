import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AddServerInput, ConfigScope, ServerConfig } from "./types.ts";

function tokenize(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) throw new Error("Unterminated quote in /mcp arguments");
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function parseCommandArguments(input: string) {
  return tokenize(input);
}

function scopeValue(value: string | undefined): ConfigScope | undefined {
  return value === "global" || value === "project" ? value : undefined;
}

export function parseNonInteractiveAdd(tokens: string[]): AddServerInput {
  const scope = scopeValue(tokens[0]);
  const name = tokens[1];
  const transport = tokens[2];
  if (!scope || !name || (transport !== "stdio" && transport !== "http")) {
    throw new Error(
      "Usage: /mcp add <global|project> <name> <stdio|http> <command-or-url> [args...]",
    );
  }
  const target = tokens[3];
  if (!target) throw new Error("A stdio command or HTTP URL is required");
  const config: ServerConfig =
    transport === "stdio"
      ? { transport, command: target, args: tokens.slice(4) }
      : { transport, url: target, oauth: false };
  return { scope, name, config };
}

async function optionalKeyValue(
  ctx: ExtensionCommandContext,
  kind: "header" | "environment variable",
) {
  const add = await ctx.ui.confirm(
    `Add ${kind}?`,
    `Add one ${kind} now? Additional values can be added by editing code-mode.json.`,
  );
  if (!add) return undefined;
  const name = await ctx.ui.input(
    `${kind} name`,
    kind === "header" ? "Authorization" : "TOKEN",
  );
  if (!name?.trim()) return undefined;
  const value = await ctx.ui.input(
    `${kind} value`,
    kind === "header" ? "Bearer ${TOKEN}" : "${TOKEN}",
  );
  if (value === undefined) return undefined;
  return { [name.trim()]: value };
}

export async function promptForServer(ctx: ExtensionCommandContext) {
  if (!ctx.hasUI) {
    throw new Error(
      "/mcp add requires complete arguments in non-interactive mode",
    );
  }
  const selectedScope = await ctx.ui.select("MCP configuration scope", [
    "global",
    "project",
  ]);
  const scope = scopeValue(selectedScope);
  if (!scope) return undefined;
  if (scope === "project" && !ctx.isProjectTrusted()) {
    throw new Error("Project MCP configuration requires a trusted project");
  }
  const name = (await ctx.ui.input("MCP server name", "context7"))?.trim();
  if (!name) return undefined;
  const transport = await ctx.ui.select("MCP transport", ["http", "stdio"]);
  if (transport === "http") {
    const url = (
      await ctx.ui.input("Streamable HTTP URL", "https://example.com/mcp")
    )?.trim();
    if (!url) return undefined;
    const oauth = await ctx.ui.confirm(
      "OAuth",
      "Use MCP OAuth for this server?",
    );
    const headers = oauth ? undefined : await optionalKeyValue(ctx, "header");
    return {
      scope,
      name,
      config: {
        transport: "http" as const,
        url,
        ...(headers ? { headers } : {}),
        oauth,
      },
    };
  }
  if (transport !== "stdio") return undefined;
  const command = (await ctx.ui.input("Executable", "npx"))?.trim();
  if (!command) return undefined;
  const rawArgs = await ctx.ui.input("Arguments", "-y package-name");
  const env = await optionalKeyValue(ctx, "environment variable");
  return {
    scope,
    name,
    config: {
      transport: "stdio" as const,
      command,
      args: rawArgs ? tokenize(rawArgs) : [],
      ...(env ? { env } : {}),
    },
  };
}
