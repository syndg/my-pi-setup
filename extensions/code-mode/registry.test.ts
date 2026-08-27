import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  IDENTIFIER_SAFE_SERVER_NAME_PATTERN,
  mergeCodeModeConfigs,
  parseCodeModeConfig,
  readCodeModeConfig,
  writeCodeModeConfig,
} from "./src/mcp/config.ts";
import { createMcpRegistry } from "./src/mcp/registry.ts";
import type { ServerRecord } from "./src/mcp/types.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "code-mode-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    global: join(root, "agent", "code-mode.json"),
    project: join(root, "project", ".pi-test", "code-mode.json"),
  };
}

test("strict parsing validates every config layer and leaves placeholders unresolved", () => {
  const config = parseCodeModeConfig({
    servers: {
      "remote-api": {
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ${REMOTE_TOKEN}" },
        oauth: true,
        requestTimeoutMs: 120_000,
      },
      local: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@example/mcp"],
        env: { TOKEN: "${LOCAL_TOKEN}" },
        cwd: "/work",
        oauth: false,
        requestTimeoutMs: 45_000,
      },
    },
    permissions: { "remote-api.*": "ask" },
    defaultPermission: "deny",
    executionTimeoutMs: 300_000,
  });

  assert.equal(
    config.servers["remote-api"]?.transport === "http"
      ? config.servers["remote-api"].headers?.Authorization
      : undefined,
    "Bearer ${REMOTE_TOKEN}",
  );
  assert.equal(
    config.servers.local?.transport === "stdio"
      ? config.servers.local.env?.TOKEN
      : undefined,
    "${LOCAL_TOKEN}",
  );
  assert.equal(config.executionTimeoutMs, 300_000);
  assert.equal(config.servers["remote-api"]?.requestTimeoutMs, 120_000);
  assert.equal(config.servers.local?.requestTimeoutMs, 45_000);
  assert.equal(IDENTIFIER_SAFE_SERVER_NAME_PATTERN.test("remote-api"), false);
  assert.equal(IDENTIFIER_SAFE_SERVER_NAME_PATTERN.test("remoteApi"), true);

  assert.throws(
    () => parseCodeModeConfig({ servers: {}, typo: true }),
    /config\.typo is not allowed/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          local: { transport: "stdio", command: "node", url: "https://bad" },
        },
      }),
    /config\.servers\.local\.url is not allowed/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          remote: {
            transport: "http",
            url: "https://example.test",
            command: "curl",
          },
        },
      }),
    /config\.servers\.remote\.command is not allowed/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          remote: {
            transport: "http",
            url: "http://example.test/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      }),
    /must use https: unless the host is loopback/,
  );
  assert.doesNotThrow(() =>
    parseCodeModeConfig({
      servers: {
        localHttp: {
          transport: "http",
          url: "http://127.0.0.1:3333/mcp",
        },
      },
    }),
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          remote: {
            transport: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer plaintext" },
          },
        },
      }),
    /plaintext credential/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          local: {
            transport: "stdio",
            command: "node",
            env: { API_TOKEN: "plaintext" },
          },
        },
      }),
    /plaintext credential/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          local: {
            transport: "stdio",
            command: "node",
            args: ["server.mjs", "--api-key", "plaintext"],
          },
        },
      }),
    /pass credentials through env/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          remote: {
            transport: "http",
            url: "https://example.test/mcp?api_key=plaintext",
          },
        },
      }),
    /credential query parameters/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: { "not.dot.safe": { transport: "stdio", command: "node" } },
      }),
    /invalid namespace/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: { remote: { transport: "http", url: "file:\/\/\/tmp\/mcp" } },
      }),
    /must use http: or https:/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig({
        servers: {
          local: { transport: "stdio", command: "node", oauth: true },
        },
      }),
    /oauth must be false/,
  );
  assert.throws(
    () =>
      parseCodeModeConfig(
        '{"servers":{"__proto__":{"transport":"stdio","command":"node"}}}',
      ),
    /reserved guest property/,
  );
  for (const timeout of [0, 600_001, 1.5, "30000"]) {
    assert.throws(
      () =>
        parseCodeModeConfig({
          servers: {
            remote: {
              transport: "http",
              url: "https://example.test/mcp",
              requestTimeoutMs: timeout,
            },
          },
        }),
      /requestTimeoutMs must be an integer from 1 to 600000 milliseconds/,
    );
  }
  for (const timeout of [0, 600_001, 1.5, "30000"]) {
    assert.throws(
      () =>
        parseCodeModeConfig({
          servers: {},
          executionTimeoutMs: timeout,
        }),
      /executionTimeoutMs must be an integer from 1 to 600000 milliseconds/,
    );
  }
  for (const timeout of [1, 600_000]) {
    assert.doesNotThrow(() =>
      parseCodeModeConfig({
        servers: {
          remote: {
            transport: "http",
            url: "https://example.test/mcp",
            requestTimeoutMs: timeout,
          },
        },
        executionTimeoutMs: timeout,
      }),
    );
  }
});

test("project precedence replaces server identity without inheriting credentials", () => {
  const merged = mergeCodeModeConfigs(
    parseCodeModeConfig({
      servers: {
        api: {
          transport: "http",
          url: "https://global.example/mcp",
          headers: { Authorization: "Bearer ${GLOBAL_TOKEN}" },
          oauth: true,
        },
      },
      permissions: { "api.*": "deny", "api.read": "allow" },
      defaultPermission: "deny",
      executionTimeoutMs: 120_000,
    }),
    parseCodeModeConfig({
      servers: {
        api: {
          transport: "http",
          url: "https://project.example/mcp",
        },
      },
      permissions: { "api.*": "ask" },
      executionTimeoutMs: 300_000,
    }),
  );

  assert.deepEqual(merged.servers.api, {
    transport: "http",
    url: "https://project.example/mcp",
  });
  assert.deepEqual(merged.permissions, {
    "api.*": "ask",
    "api.read": "allow",
  });
  assert.equal(merged.defaultPermission, "deny");
  assert.equal(merged.executionTimeoutMs, 300_000);

  const transportChanged = mergeCodeModeConfigs(
    parseCodeModeConfig({
      servers: {
        api: {
          transport: "http",
          url: "https://global.example/mcp",
          headers: { Authorization: "Bearer ${GLOBAL_TOKEN}" },
        },
      },
    }),
    parseCodeModeConfig({
      servers: { api: { transport: "stdio", command: "api-server" } },
    }),
  );
  assert.deepEqual(transportChanged.servers.api, {
    transport: "stdio",
    command: "api-server",
  });
});

test("config reads and writes reject files above the bounded size", async (t) => {
  const paths = await fixture(t);
  const oversized = join(paths.root, "oversized.json");
  await writeFile(oversized, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(() => readCodeModeConfig(oversized), /byte limit/);
  await assert.rejects(
    () =>
      writeCodeModeConfig(join(paths.root, "write.json"), {
        servers: {
          local: {
            transport: "stdio",
            command: "x".repeat(1024 * 1024),
          },
        },
      }),
    /byte limit/,
  );
});

test("atomic config writes create private files and leave no temporary file", async (t) => {
  const paths = await fixture(t);
  await writeCodeModeConfig(paths.global, {
    servers: { local: { transport: "stdio", command: "node" } },
  });
  await writeCodeModeConfig(paths.global, {
    servers: {
      remote: { transport: "http", url: "https://example.test/mcp" },
    },
  });

  const metadata = await stat(paths.global);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.deepEqual(await readCodeModeConfig(paths.global), {
    servers: {
      remote: {
        transport: "http",
        url: "https://example.test/mcp",
      },
    },
  });
  assert.deepEqual(await readdir(dirname(paths.global)), ["code-mode.json"]);
});

test("registry exposes provenance and ignores untrusted project configuration", async (t) => {
  const paths = await fixture(t);
  await writeCodeModeConfig(paths.global, {
    servers: {
      shared: { transport: "stdio", command: "global-server" },
      globalOnly: { transport: "stdio", command: "global-only" },
    },
  });
  await writeCodeModeConfig(paths.project, {
    servers: {
      shared: { transport: "stdio", command: "project-server" },
      projectOnly: { transport: "stdio", command: "project-only" },
    },
  });

  const untrusted = createMcpRegistry({
    paths,
    projectTrusted: false,
  });
  assert.deepEqual(
    (await untrusted.list()).map(({ name, scope }) => ({ name, scope })),
    [
      { name: "globalOnly", scope: "global" },
      { name: "shared", scope: "global" },
    ],
  );
  await assert.rejects(
    untrusted.add({
      name: "blocked",
      scope: "project",
      config: { transport: "stdio", command: "blocked" },
    }),
    /until the project is trusted/,
  );

  const trusted = createMcpRegistry({ paths, projectTrusted: true });
  const records = await trusted.list();
  assert.deepEqual(
    records.map(({ name, scope }) => ({ name, scope })),
    [
      { name: "globalOnly", scope: "global" },
      { name: "projectOnly", scope: "project" },
      { name: "shared", scope: "project" },
    ],
  );
  const shared = records.find(({ name }) => name === "shared");
  assert.equal(
    shared?.config.transport === "stdio" ? shared.config.command : undefined,
    "project-server",
  );
});

test("registry mutations are scoped, unique, and run injected cleanup", async (t) => {
  const paths = await fixture(t);
  const teardown: ServerRecord[] = [];
  const cache: ServerRecord[] = [];
  const credentials: ServerRecord[] = [];
  const registry = createMcpRegistry({
    paths,
    projectTrusted: true,
    teardownServer: (record) => teardown.push(record),
    clearServerCache: (record) => cache.push(record),
    clearServerCredentials: (record) => credentials.push(record),
  });

  const added = await registry.add({
    name: "remote",
    scope: "project",
    config: {
      transport: "http",
      url: "https://one.example/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    },
  });
  assert.equal(added.scope, "project");
  assert.equal(added.enabled, true);
  await assert.rejects(
    registry.add({
      name: "remote",
      scope: "global",
      config: { transport: "stdio", command: "duplicate" },
    }),
    /already configured/,
  );

  await registry.disable("remote");
  assert.equal((await registry.list())[0]?.enabled, false);
  await registry.enable("remote");
  assert.equal((await registry.list())[0]?.enabled, true);
  assert.equal(
    (await readCodeModeConfig(paths.project)).servers.remote?.enabled,
    true,
  );

  await registry.remove("remote", { removeCredentials: true });
  assert.deepEqual(await registry.list(), []);
  assert.equal(teardown.length, 2);
  assert.equal(cache.length, 4);
  assert.equal(credentials.length, 1);
  assert.ok(
    [...teardown, ...cache, ...credentials].every(
      (record) => record.name === "remote" && record.scope === "project",
    ),
  );
});

test("reload invalidates changed state and URL-bound credentials", async (t) => {
  const paths = await fixture(t);
  await writeCodeModeConfig(paths.global, {
    servers: {
      remote: { transport: "http", url: "https://one.example/mcp" },
    },
  });
  const teardown: ServerRecord[] = [];
  const cache: ServerRecord[] = [];
  const credentials: ServerRecord[] = [];
  const registry = createMcpRegistry({
    paths,
    teardownServer: (record) => teardown.push(record),
    clearServerCache: (record) => cache.push(record),
    clearServerCredentials: (record) => credentials.push(record),
  });
  await registry.list();

  await writeFile(
    paths.global,
    `${JSON.stringify({
      servers: {
        remote: { transport: "http", url: "https://two.example/mcp" },
      },
    })}\n`,
    { mode: 0o600 },
  );
  await registry.reload();

  assert.equal(teardown.length, 1);
  assert.equal(cache.length, 1);
  assert.equal(credentials.length, 1);
  const [record] = await registry.list();
  assert.equal(
    record?.config.transport === "http" ? record.config.url : undefined,
    "https://two.example/mcp",
  );
});
