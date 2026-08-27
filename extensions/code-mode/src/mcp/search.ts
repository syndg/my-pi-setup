import type {
  CatalogTool,
  SearchInput,
  SearchMatch,
  SearchResult,
} from "./types.ts";
import {
  DEFAULT_SCHEMA_SUMMARY_MAX_BYTES,
  renderSchemaAsTypeScript,
} from "./schema.ts";

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_SEARCH_DESCRIPTION_BYTES = 1_024;

const MAX_QUERY_TOKENS = 32;
const MAX_SCHEMA_SEARCH_DEPTH = 8;
const MAX_SCHEMA_SEARCH_FIELDS = 200;

type RankedCatalogTool = {
  tool: CatalogTool;
  score: number;
};

type SearchCursor = {
  version: 1;
  query: string;
  score: number;
  path: string;
};

export function normalizeSearchText(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenizeSearchText(value: string) {
  return unique(normalizeSearchText(value).split(" ").filter(Boolean)).slice(
    0,
    MAX_QUERY_TOKENS,
  );
}

export function scoreCatalogTool(tool: CatalogTool, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);
  if (!normalizedQuery || queryTokens.length === 0) return null;

  const schemaFields = collectSchemaSearchFields(tool.inputSchema);
  const fields = {
    path: field(tool.path),
    name: field(tool.name),
    server: field(tool.server),
    description: field(tool.description ?? ""),
    inputNames: field(schemaFields.names.join(" ")),
    inputDescriptions: field(schemaFields.descriptions.join(" ")),
  };

  let tier = 0;
  if (fields.path.normalized === normalizedQuery) tier = 6;
  else if (fields.name.normalized === normalizedQuery) tier = 5;
  else if (
    fields.path.normalized.startsWith(normalizedQuery) ||
    fields.name.normalized.startsWith(normalizedQuery)
  ) {
    tier = 4;
  }

  const weights = {
    path: 20_000,
    name: 24_000,
    server: 14_000,
    description: 2_000,
    inputNames: 8_000,
    inputDescriptions: 1_500,
  } as const;
  const matchedTokens = new Set<string>();
  let relevance = 0;

  for (const [fieldName, value] of Object.entries(fields) as Array<
    [keyof typeof weights, ReturnType<typeof field>]
  >) {
    const weight = weights[fieldName];
    if (value.normalized.includes(normalizedQuery)) relevance += weight * 2;
    for (const queryToken of queryTokens) {
      if (value.tokens.has(queryToken)) {
        relevance += weight;
        matchedTokens.add(queryToken);
      } else if (
        [...value.tokens].some(
          (token) =>
            token.startsWith(queryToken) ||
            (token.length >= 4 && queryToken.startsWith(token)),
        )
      ) {
        relevance += Math.floor(weight / 2);
        matchedTokens.add(queryToken);
      }
    }
  }

  if (tier === 0 && matchedTokens.size === 0) return null;
  const coverage = matchedTokens.size / queryTokens.length;
  relevance += Math.round(coverage * 100_000);
  if (coverage === 1) relevance += 100_000;
  return tier * 100_000_000 + relevance;
}

export function rankCatalogTools(tools: Iterable<CatalogTool>, query: string) {
  const matches: RankedCatalogTool[] = [];
  for (const tool of tools) {
    const score = scoreCatalogTool(tool, query);
    if (score !== null) matches.push({ tool, score });
  }
  return matches.sort(compareRankedTools);
}

export function searchCatalogTools(
  tools: Iterable<CatalogTool>,
  input: SearchInput,
): SearchResult {
  const normalizedQuery = normalizeSearchText(input.query);
  if (!normalizedQuery) return { items: [] };

  const limit = normalizeLimit(input.limit);
  const ranked = rankCatalogTools(tools, input.query);
  const cursor = input.cursor
    ? decodeSearchCursor(input.cursor, normalizedQuery)
    : undefined;
  const afterCursor = cursor
    ? ranked.filter((match) => compareWithCursor(match, cursor) > 0)
    : ranked;
  const page = afterCursor.slice(0, limit);
  const items = page.map(({ tool }) => summarizeCatalogTool(tool));
  const last = page.at(-1);
  const nextCursor =
    last && afterCursor.length > page.length
      ? encodeSearchCursor({
          version: 1,
          query: normalizedQuery,
          score: last.score,
          path: last.tool.path,
        })
      : undefined;

  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

export const searchTools = searchCatalogTools;

export function summarizeCatalogTool(tool: CatalogTool): SearchMatch {
  const description = tool.description
    ? truncateUtf8(tool.description, MAX_SEARCH_DESCRIPTION_BYTES)
    : undefined;
  return {
    path: tool.path,
    ...(description ? { description } : {}),
    input: renderSchemaAsTypeScript(tool.inputSchema, {
      maxBytes: DEFAULT_SCHEMA_SUMMARY_MAX_BYTES,
    }),
    freshness: tool.freshness,
  };
}

export function collectSchemaSearchFields(inputSchema: unknown) {
  const names: string[] = [];
  const descriptions: string[] = [];
  const seen = new Set<object>();
  let fields = 0;

  const visit = (value: unknown, depth: number) => {
    if (
      depth > MAX_SCHEMA_SEARCH_DEPTH ||
      fields >= MAX_SCHEMA_SEARCH_FIELDS ||
      typeof value !== "object" ||
      value === null ||
      seen.has(value)
    ) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    if (isRecord(value.properties)) {
      for (const [name, property] of Object.entries(value.properties)) {
        if (fields++ >= MAX_SCHEMA_SEARCH_FIELDS) break;
        names.push(name);
        if (isRecord(property) && typeof property.description === "string") {
          descriptions.push(property.description);
        }
        visit(property, depth + 1);
      }
    }

    for (const key of [
      "items",
      "prefixItems",
      "anyOf",
      "oneOf",
      "$defs",
      "definitions",
      "additionalProperties",
    ]) {
      visit(value[key], depth + 1);
    }
  };

  visit(inputSchema, 0);
  return { names, descriptions };
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const target = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > target) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${ellipsis}`;
}

function field(value: string) {
  const normalized = normalizeSearchText(value);
  return { normalized, tokens: new Set(tokenizeSearchText(value)) };
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(value)));
}

function compareRankedTools(a: RankedCatalogTool, b: RankedCatalogTool) {
  return b.score - a.score || compareStrings(a.tool.path, b.tool.path);
}

function compareWithCursor(match: RankedCatalogTool, cursor: SearchCursor) {
  if (match.score !== cursor.score) return cursor.score - match.score;
  return compareStrings(match.tool.path, cursor.path);
}

function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeSearchCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(value: string, query: string) {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.query !== query ||
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score) ||
      typeof parsed.path !== "string"
    ) {
      throw new Error("invalid");
    }
    return {
      version: 1,
      query: parsed.query,
      score: parsed.score,
      path: parsed.path,
    } satisfies SearchCursor;
  } catch {
    throw new Error("Invalid or mismatched MCP search cursor");
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
