import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatalogCache } from "./src/mcp/catalog-cache.ts";
import type { CatalogTool, ServerRecord } from "./src/mcp/types.ts";

function record(enabled = true): ServerRecord {
  return {
    name: "example",
    scope: "global",
    enabled,
    config: {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${SECRET_TOKEN}" },
    },
  };
}

const tool: CatalogTool = {
  path: "example.lookup",
  server: "example",
  name: "lookup",
  description: "Look up an item",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  freshness: "live",
};

test("catalog cache is private, secret-independent, and only hydrates enabled servers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-code-mode-cache-"));
  const path = join(root, "catalog.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new CatalogCache(path);
  await cache.update(record(), [tool]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const serialized = await readFile(path, "utf8");
  assert.doesNotMatch(serialized, /SECRET_TOKEN|Bearer/);

  const reloaded = new CatalogCache(path);
  const enabled = await reloaded.load([record(true)]);
  assert.equal(enabled[0]?.tools[0]?.freshness, "cached");
  assert.deepEqual(await reloaded.load([record(false)]), []);
  assert.deepEqual(
    await reloaded.load([{ ...record(true), scope: "project" }]),
    [],
  );
  assert.deepEqual(
    await reloaded.load([
      {
        ...record(true),
        config: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${OTHER_TOKEN}" },
        },
      },
    ]),
    [],
  );
});
