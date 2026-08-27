import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeCodeModeConfig } from "./src/mcp/config.ts";

const runner = fileURLToPath(
  new URL("./fixtures/extension-e2e-runner.ts", import.meta.url),
);
const execFileAsync = promisify(execFile);
const enabled = process.env.PI_CODE_MODE_CONTEXT7_E2E === "1";

test(
  "Code Mode searches, describes, and invokes the live Context7 MCP server",
  { skip: !enabled },
  async (t) => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-context7-"));
    t.after(() => rm(agentDir, { recursive: true, force: true }));
    await writeCodeModeConfig(join(agentDir, "code-mode.json"), {
      servers: {
        context7: {
          transport: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
          oauth: false,
        },
      },
      permissions: { "context7.*": "allow" },
    });
    const code = `
      const matches = await tools.search({ query: "Context7 library documentation", limit: 5 });
      const resolver = matches.items.find((item) => item.path === "context7.resolve-library-id");
      const queryDocs = matches.items.find((item) => item.path === "context7.query-docs")
        ?? (await tools.search({ query: "Context7 query docs", limit: 5 })).items.find((item) => item.path === "context7.query-docs");
      if (!resolver || !queryDocs) return { matches, error: "Context7 tools missing" };
      const resolverDescription = await tools.describe({ path: resolver.path });
      const docsDescription = await tools.describe({ path: queryDocs.path });
      const libraries = await tools.call({
        path: resolver.path,
        args: { libraryName: "Svelte", query: "Find the official Svelte documentation library" },
      });
      const docs = await tools.call({
        path: queryDocs.path,
        args: { libraryId: "/sveltejs/svelte", query: "What does onMount do?" },
      });
      return { resolverDescription, docsDescription, libraries, docs };
    `;
    const encoded = Buffer.from(code).toString("base64url");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", runner, agentDir, process.cwd(), encoded],
      { timeout: 60_000 },
    );
    assert.match(stdout, /context7\.resolve-library-id/);
    assert.match(stdout, /context7\.query-docs/);
    assert.match(stdout, /\/sveltejs\/svelte/);
    assert.match(stdout, /onMount/);
    const apiKey = process.env.CONTEXT7_API_KEY;
    if (apiKey) assert.equal(stdout.includes(apiKey), false);
  },
);
