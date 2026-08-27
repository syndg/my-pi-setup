import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogCollisionError,
  MAX_CATALOG_OPERATION_BYTES,
  McpCatalog,
} from "./src/mcp/catalog.ts";
import {
  MAX_INTERMEDIATE_MCP_BYTES,
  McpOutputBudget,
  McpOutputLimitError,
  normalizeMcpResult,
  serializedByteLength,
} from "./src/mcp/content.ts";
import {
  REDACTED_VALUE,
  formatRedactedArguments,
  redactSecrets,
  resolveConfiguredPermission,
  resolvePermission,
} from "./src/mcp/permissions.ts";
import { renderSchemaAsTypeScript } from "./src/mcp/schema.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_DESCRIPTION_BYTES,
  MAX_SEARCH_LIMIT,
  rankCatalogTools,
  searchCatalogTools,
  scoreCatalogTool,
} from "./src/mcp/search.ts";
import type { CatalogTool } from "./src/mcp/types.ts";

function tool(
  server: string,
  name: string,
  overrides: Partial<CatalogTool> = {},
): CatalogTool {
  return {
    path: `${server}.${name}`,
    server,
    name,
    inputSchema: { type: "object", properties: {} },
    freshness: "live",
    ...overrides,
  };
}

test("search applies the required lexical ranking tiers", () => {
  const tools = [
    tool("linear", "search_issues", { description: "Search" }),
    tool("github", "search_issues", { description: "Search" }),
    tool("search", "issues_by_state", { description: "Search issues" }),
  ];

  assert.equal(
    rankCatalogTools(tools, "github.search_issues")[0]?.tool.path,
    "github.search_issues",
  );
  assert.ok(
    (scoreCatalogTool(tools[0]!, "search issues") ?? 0) <
      (scoreCatalogTool(tools[1]!, "github.search_issues") ?? 0),
  );

  const exactName = tool("alpha", "search");
  const prefixName = tool("beta", "search_everything");
  assert.deepEqual(
    rankCatalogTools([prefixName, exactName], "search").map(
      (match) => match.tool.path,
    ),
    ["alpha.search", "beta.search_everything"],
  );
});

test("search covers server, description, and nested input metadata", () => {
  const tools = [
    tool("billing", "create_report", {
      description: "Build a monthly statement",
      inputSchema: {
        type: "object",
        properties: {
          account: {
            type: "object",
            properties: {
              customerId: {
                type: "string",
                description: "External subscriber identity",
              },
            },
          },
        },
      },
    }),
  ];

  for (const query of [
    "billing",
    "monthly statement",
    "customer id",
    "subscriber identity",
  ]) {
    assert.equal(
      searchCatalogTools(tools, { query }).items[0]?.path,
      tools[0]!.path,
    );
  }
});

test("search pagination is deterministic, bounded, and cursor based", () => {
  const tools = Array.from({ length: 25 }, (_, index) =>
    tool("server", `tool_${String(index).padStart(2, "0")}`, {
      description: "common pagination phrase",
    }),
  );

  const first = searchCatalogTools(tools, { query: "common" });
  assert.equal(first.items.length, DEFAULT_SEARCH_LIMIT);
  assert.ok(first.nextCursor);
  assert.deepEqual(
    first.items.map((item) => item.path),
    [
      "server.tool_00",
      "server.tool_01",
      "server.tool_02",
      "server.tool_03",
      "server.tool_04",
    ],
  );

  const second = searchCatalogTools(tools, {
    query: "common",
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, DEFAULT_SEARCH_LIMIT);
  assert.equal(
    first.items.some((item) => item.path === second.items[0]?.path),
    false,
  );

  const capped = searchCatalogTools(tools, { query: "common", limit: 10_000 });
  assert.equal(capped.items.length, MAX_SEARCH_LIMIT);
  assert.throws(
    () =>
      searchCatalogTools(tools, {
        query: "different",
        cursor: first.nextCursor,
      }),
    /cursor/i,
  );
});

test("search summaries bound descriptions and render input guidance", () => {
  const result = searchCatalogTools(
    [
      tool("server", "large", {
        description: `needle ${"🙂".repeat(2_000)}`,
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" } },
        },
      }),
    ],
    { query: "needle" },
  );
  const match = result.items[0]!;
  assert.ok(
    Buffer.byteLength(match.description ?? "", "utf8") <=
      MAX_SEARCH_DESCRIPTION_BYTES,
  );
  assert.equal(match.input, "{ query: string }");
});

test("catalog overlays live records on cached records and restores cache", () => {
  const catalog = new McpCatalog();
  catalog.replaceCached("github", [
    tool("github", "cached_tool", { freshness: "cached" }),
  ]);
  assert.equal(catalog.lookup("github.cached_tool")?.freshness, "cached");

  catalog.replaceLive("github", [tool("github", "live_tool")]);
  assert.equal(catalog.lookup("github.cached_tool"), undefined);
  assert.equal(catalog.lookup("github.live_tool")?.freshness, "live");

  catalog.removeLive("github");
  assert.equal(catalog.lookup("github.cached_tool")?.freshness, "cached");
  catalog.removeServer("github");
  assert.equal(catalog.size, 0);
});

test("catalog replacement is atomic and rejects canonical collisions", () => {
  const catalog = new McpCatalog();
  catalog.replaceLive("github", [tool("github", "existing")]);

  assert.throws(
    () =>
      catalog.replaceLive("github", [
        tool("github", "duplicate"),
        tool("github", "duplicate"),
      ]),
    CatalogCollisionError,
  );
  assert.deepEqual(
    catalog.list().map((record) => record.path),
    ["github.existing"],
  );
  assert.throws(
    () =>
      catalog.replaceLive("github", [
        { ...tool("github", "bad"), path: "other.bad" },
      ]),
    /catalog path/i,
  );
  catalog.replaceLive("github", [tool("github", "repos.list")]);
  assert.equal(catalog.lookup("github.repos.list")?.name, "repos.list");
  assert.throws(
    () => catalog.replaceLive("github", [tool("github", "bad name")]),
    /Invalid MCP tool name/,
  );
});

test("catalog lookup, search, and describe stay bounded", () => {
  const catalog = new McpCatalog();
  catalog.replaceLive("docs", [
    tool("docs", "read", {
      description: "Read documentation",
      inputSchema: {
        type: "object",
        properties: { payload: { const: "x".repeat(300_000) } },
      },
    }),
  ]);

  assert.equal(
    catalog.search({ query: "documentation" }).items[0]?.path,
    "docs.read",
  );
  const description = catalog.describe("docs.read");
  assert.ok(serializedByteLength(description) <= MAX_CATALOG_OPERATION_BYTES);
  assert.deepEqual(description.inputSchema, {
    omitted: true,
    reason: "Input schema exceeded the catalog description output limit",
  });
  assert.throws(() => catalog.describe("docs.missing"), /Unknown MCP tool/);
});

test("schema renderer handles objects, required fields, arrays, tuples, and maps", () => {
  const rendered = renderSchemaAsTypeScript({
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      count: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      pair: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
      },
      nested: {
        type: "object",
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
  });

  assert.equal(
    rendered,
    "{ query: string; count?: number; tags?: string[]; pair?: [string, number]; nested?: { enabled: boolean }; metadata?: { [key: string]: string } }",
  );
});

test("schema renderer handles unions, null, literals, refs, and unknown fallback", () => {
  assert.equal(
    renderSchemaAsTypeScript({
      oneOf: [
        { enum: ["open", "closed"] },
        { type: "integer" },
        { type: "null" },
      ],
    }),
    '"open" | "closed" | number | null',
  );
  assert.equal(
    renderSchemaAsTypeScript({ type: "string", nullable: true }),
    "string | null",
  );
  assert.equal(renderSchemaAsTypeScript({ const: true }), "true");
  assert.equal(
    renderSchemaAsTypeScript({
      $defs: { Id: { type: "string" } },
      type: "object",
      properties: { id: { $ref: "#/$defs/Id" } },
    }),
    "{ id?: string }",
  );
  assert.equal(renderSchemaAsTypeScript({ allOf: [] }), "unknown");
  assert.equal(renderSchemaAsTypeScript(null), "unknown");
  assert.equal(
    renderSchemaAsTypeScript({
      type: "object",
      properties: { value: { not: {} } },
    }),
    "{ value?: unknown }",
  );
});

test("permissions resolve exact before wildcard before safe default", () => {
  const rules = {
    "github.*": "ask",
    "github.read": "allow",
    "github.delete": "deny",
  } as const;
  assert.equal(resolvePermission("github.read", rules, "deny"), "allow");
  assert.equal(resolvePermission("github.delete", rules, "allow"), "deny");
  assert.equal(resolvePermission("github.write", rules, "allow"), "ask");
  assert.equal(resolvePermission("linear.read", rules), "ask");
  assert.equal(
    resolveConfiguredPermission(
      { permissions: { "linear.*": "deny" }, defaultPermission: "allow" },
      "linear.read",
    ),
    "deny",
  );
});

test("secret redaction covers keys and token-shaped strings without mutating input", () => {
  const input = {
    password: "hunter2",
    nested: {
      accessToken: "abc",
      tokenCount: 3,
      note: "Use Bearer abc.def-123, Basic YWJjZA==, password=visible, and ghp_abcdefghijklmnopqrstuvwxyz",
      url: "https://example.test/?api_key=visible&ok=1",
    },
  };
  const redacted = redactSecrets(input);

  assert.deepEqual(redacted, {
    password: REDACTED_VALUE,
    nested: {
      accessToken: REDACTED_VALUE,
      tokenCount: 3,
      note: `Use Bearer ${REDACTED_VALUE}, Basic ${REDACTED_VALUE}, password=${REDACTED_VALUE}, and ${REDACTED_VALUE}`,
      url: `https://example.test/?api_key=${REDACTED_VALUE}&ok=1`,
    },
  });
  assert.equal(input.password, "hunter2");
  assert.ok(
    Buffer.byteLength(formatRedactedArguments(input, 160), "utf8") <= 160,
  );
});

test("MCP content normalization preserves supported content and redacts output", () => {
  const result = normalizeMcpResult({
    content: [
      { type: "text", text: "Authorization: Bearer top-secret" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      {
        type: "resource",
        resource: {
          uri: "file:///notes?token=secret",
          text: "ghp_abcdefghijklmnopqrstuvwxyz",
        },
      },
      { type: "audio", data: "ignored" },
    ],
    structuredContent: {
      apiKey: "do-not-leak",
      values: [1, 2, 3],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.content, [
    { type: "text", text: `Authorization: Bearer ${REDACTED_VALUE}` },
    { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
    {
      type: "resource",
      uri: `file:///notes?token=${REDACTED_VALUE}`,
      text: REDACTED_VALUE,
    },
    { type: "text", text: "[Unsupported MCP content omitted: audio]" },
  ]);
  assert.deepEqual(result.structuredContent, {
    apiKey: REDACTED_VALUE,
    values: [1, 2, 3],
  });
});

test("MCP structured content preserves large tabular results while redacting", () => {
  const longText = `large field: ${"x".repeat(4_096)}`;
  const rows = Array.from({ length: 350 }, (_, index) => ({
    id: index,
    label: index === 0 ? longText : `row-${index}`,
    note:
      index === 349
        ? "Use Bearer abc.def-123 to authenticate"
        : `safe-${index}`,
    apiKey: `secret-${index}`,
  }));
  const input = {
    content: [],
    structuredContent: {
      rows,
      summary: longText,
      sessionToken: "top-secret",
    },
  };

  const result = normalizeMcpResult(input);

  assert.deepEqual(result.structuredContent, {
    rows: rows.map((row) => ({
      ...row,
      note:
        row.id === 349
          ? `Use Bearer ${REDACTED_VALUE} to authenticate`
          : row.note,
      apiKey: REDACTED_VALUE,
    })),
    summary: longText,
    sessionToken: REDACTED_VALUE,
  });
  assert.equal(rows.length, 350);
  assert.equal(rows[0]?.label, longText);
  assert.equal(rows[349]?.apiKey, "secret-349");
  assert.equal(rows[349]?.note, "Use Bearer abc.def-123 to authenticate");
});

test("MCP structured content handles cycles and rejects excessive depth", () => {
  const cyclic: Record<string, unknown> = {
    label: "safe",
    accessToken: "secret",
  };
  cyclic.self = cyclic;

  const normalized = normalizeMcpResult({
    content: [],
    structuredContent: cyclic,
  });
  assert.deepEqual(normalized.structuredContent, {
    label: "safe",
    accessToken: REDACTED_VALUE,
    self: "[Circular]",
  });
  assert.equal(cyclic.self, cyclic);

  const deeplyNested: Record<string, unknown> = {};
  let cursor = deeplyNested;
  for (let depth = 0; depth < 101; depth += 1) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }

  assert.throws(
    () =>
      normalizeMcpResult({
        content: [],
        structuredContent: deeplyNested,
      }),
    /maximum depth/i,
  );
});

test("MCP isError becomes a recoverable result envelope", () => {
  const result = normalizeMcpResult({
    isError: true,
    content: [{ type: "text", text: "Issue not found" }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: "MCP_TOOL_ERROR",
    message: "Issue not found",
  });
});

test("per-result and aggregate MCP output guards fail before overflow", () => {
  const oversized = {
    content: [{ type: "text", text: "x".repeat(1_000) }],
  };
  assert.throws(
    () => normalizeMcpResult(oversized, { maxResultBytes: 100 }),
    McpOutputLimitError,
  );
  assert.throws(() => normalizeMcpResult({ content: {} }), /content/i);
  assert.throws(
    () => normalizeMcpResult({ content: [] }, { remainingBytes: 0 }),
    McpOutputLimitError,
  );

  const budget = new McpOutputBudget(180, 150);
  budget.consume({ value: "x".repeat(80) });
  assert.ok(budget.usedBytes > 0);
  assert.throws(
    () => budget.consume({ value: "y".repeat(100) }),
    McpOutputLimitError,
  );

  const normalizationBudget = new McpOutputBudget(180, 150);
  normalizeMcpResult(
    { content: [], structuredContent: { value: "x".repeat(40) } },
    { budget: normalizationBudget },
  );
  const usedAfterFirstResult = normalizationBudget.usedBytes;
  assert.throws(
    () =>
      normalizeMcpResult(
        { content: [], structuredContent: { value: "y".repeat(40) } },
        { budget: normalizationBudget },
      ),
    McpOutputLimitError,
  );
  assert.equal(normalizationBudget.usedBytes, usedAfterFirstResult);
  assert.equal(new McpOutputBudget().maxBytes, MAX_INTERMEDIATE_MCP_BYTES);
});
