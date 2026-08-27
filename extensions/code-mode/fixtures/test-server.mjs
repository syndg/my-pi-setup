import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "code-mode-test", version: "1.0.0" });
const fixtureSecret = process.env.CODE_MODE_FIXTURE_SECRET;

server.registerTool(
  "echo",
  {
    description: fixtureSecret
      ? `Echo a message with a server marker ${fixtureSecret}`
      : "Echo a message with a server marker",
    inputSchema: z.object({ message: z.string() }),
  },
  async ({ message }) => ({
    content: [
      {
        type: "text",
        text: `server:${message}${fixtureSecret ? `:${fixtureSecret}` : ""}`,
      },
    ],
    structuredContent: { echoed: message, opaque: fixtureSecret },
  }),
);

server.registerTool(
  "sum",
  {
    description: "Add a list of numbers",
    inputSchema: z.object({ values: z.array(z.number()) }),
  },
  async ({ values }) => ({
    content: [
      {
        type: "text",
        text: String(values.reduce((sum, value) => sum + value, 0)),
      },
    ],
    structuredContent: { total: values.reduce((sum, value) => sum + value, 0) },
  }),
);

server.registerTool(
  "sleep",
  {
    description: "Wait for a bounded duration",
    inputSchema: z.object({ milliseconds: z.number().min(0).max(2_000) }),
  },
  async ({ milliseconds }) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { content: [{ type: "text", text: "done" }] };
  },
);

server.registerTool(
  "fail",
  {
    description: "Return an expected MCP tool error",
    inputSchema: z.object({ message: z.string().optional() }),
  },
  async ({ message }) => ({
    isError: true,
    content: [{ type: "text", text: message ?? "expected failure" }],
  }),
);

let dynamicToolRegistered = false;
server.registerTool(
  "add_dynamic_tool",
  {
    description: "Register a tool and emit a tools/list_changed notification",
    inputSchema: z.object({}),
  },
  async () => {
    if (!dynamicToolRegistered) {
      dynamicToolRegistered = true;
      server.registerTool(
        "dynamic",
        {
          description: "A dynamically registered tool",
          inputSchema: z.object({}),
        },
        async () => ({ content: [{ type: "text", text: "dynamic" }] }),
      );
    }
    return { content: [{ type: "text", text: "registered" }] };
  },
);

await server.connect(new StdioServerTransport());
