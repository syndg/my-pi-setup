# Pi Code Mode

Code Mode is an opt-in Pi extension that exposes MCP through exactly one
model-visible tool, `execute`. MCP clients, transports, credentials, and the
complete tool catalog remain host-side. Guest programs run in a fresh
`just-bash` QuickJS/WASM sandbox for every call.

## Install

Code Mode is tested with Pi 0.84.1 and requires Node.js 20.18.1 or newer.

Install the repository dependencies from the repository root:

```sh
npm install
```

When this repository is cloned or copied to `~/.pi/agent`, Pi discovers
`extensions/code-mode/index.ts` automatically. From another checkout, use:

```sh
pi -e ./extensions/code-mode/index.ts
```

Do not load `pi-mcp-adapter` at the same time. Code Mode owns its own MCP
configuration and lifecycle.

## Configuration

Global configuration is stored at:

```text
~/.pi/agent/code-mode.json
```

Project configuration is stored at:

```text
.pi/code-mode.json
```

Project configuration is ignored unless Pi trusts the project. Project entries
override same-named global entries without inheriting credentials when the
transport or URL changes.

```json
{
  "servers": {
    "context7": {
      "transport": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      },
      "oauth": false,
      "requestTimeoutMs": 300000
    },
    "local": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "TOKEN": "${LOCAL_MCP_TOKEN}"
      }
    }
  },
  "permissions": {
    "context7.*": "allow",
    "local.read_data": "allow",
    "local.write_data": "ask",
    "local.delete_data": "deny"
  },
  "defaultPermission": "ask",
  "executionTimeoutMs": 300000
}
```

Configuration is strict: unknown fields, malformed URLs, invalid server names,
and shell command strings are rejected. stdio configuration always stores an
executable plus an argument array. `${NAME}` placeholders are resolved only in
the host immediately before a connection is created; resolved values are not
written to the catalog, trace, guest, or transcript.

`executionTimeoutMs` controls the complete queued sandbox execution.
`requestTimeoutMs` controls connection, discovery, refresh, and tool requests for
one server. Both default to 30 seconds and accept integer millisecond values
from 1 ms through 10 minutes. The execution deadline still bounds the full
program, so a server
request cannot keep an `execute` call alive beyond `executionTimeoutMs`.

## Management

```text
/mcp
/mcp list
/mcp add
/mcp add <global|project> <name> <stdio|http> <command-or-url> [args...]
/mcp remove <server>
/mcp enable <server>
/mcp disable <server>
/mcp reconnect [server]
/mcp auth [server]
/mcp logout <server>
/mcp test <server>
/mcp tools <server>
/mcp reload
```

`/mcp` and bare `/mcp add` provide interactive selection in the TUI. In
noninteractive print/JSON modes, supply the complete form shown above. For
`stdio`, the target is the executable and remaining tokens become its arguments;
for `http`, the target is the URL and additional arguments are not used.
UI-dependent operations fail closed in print/JSON modes. Removal is interactive
only: it confirms the server deletion, then separately asks whether saved
credentials should also be deleted (default No). Adding a stdio server records
trusted configuration; the selected package runner remains responsible for
package downloads and caching. Removing a server never invokes a package-manager
uninstall or deletes shared caches/binaries.

## Guest interface

The model receives only the `execute({ code })` schema and this stable guest
interface:

```ts
const matches = await tools.search({
  query: "find current library documentation",
  limit: 5,
});

const description = await tools.describe({ path: matches.items[0].path });

const result = await tools.call({
  path: description.path,
  args: { libraryName: "Svelte", query: "Svelte lifecycle documentation" },
});

return result;
```

A known path can be called directly:

```ts
return await tools.context7["resolve-library-id"]({
  libraryName: "Svelte",
  query: "Svelte lifecycle documentation",
});
```

Use the exact path returned by search. Bracket notation supports MCP tool names
that are not JavaScript identifiers; `tools.call` supports every canonical path.
MCP calls are sequential in version one. Intermediate values stay in QuickJS
unless the program returns them.

`.ts` programs support erasable TypeScript syntax. Constructs requiring runtime
lowering are unsupported, including enums, namespaces, parameter properties,
legacy decorators, and similar non-erasable syntax.

## Permissions

Resolution order is:

1. Exact canonical path
2. Server wildcard (`server.*`)
3. `defaultPermission`
4. Safe fallback: `ask`

Every MCP invocation is independently validated and approved. MCP annotations
are display hints and never override local policy. `ask` fails closed when no
interactive UI is available. Approval previews are bounded and redact common
secret-bearing keys.

## Authentication

Static headers and stdio environment variables should reference environment
variables. Values are resolved from the Pi process first and then
`~/.pi/agent/.env`. Sensitive header/environment fields without a placeholder,
credential-bearing URL query parameters, and common credential CLI arguments
are rejected rather than persisted in plaintext. Remote OAuth is initiated only
by `/mcp auth <server>` or the interactive management surface; an `execute`
call never opens a browser.

OAuth uses discovery, PKCE, dynamic client registration, issuer validation,
refresh, and logout from the official MCP client. Credentials are bound to
configuration scope, server name, normalized URL, and issuer. The OS credential
store is preferred. If a keyring operation fails, Code Mode automatically and
silently falls back to atomically written files under
`~/.pi/agent/code-mode/oauth-fallback/`; credential files and lock files use
`0600` permissions and the directory uses `0700`. No notification or automatic
fallback report is shown, and this fallback is less secure than the OS
credential store. Code Mode removes exact configured/stored secret values and
common token forms from metadata, traces, guest results, and cache entries.
Do not authenticate to an untrusted MCP server: no client can reliably detect a
secret after a malicious server transforms or encodes it.

## Limits

| Resource                        |                 Limit |
| ------------------------------- | --------------------: |
| Total execution                 |  30s default; 10m max |
| JavaScript execution            |  30s default; 10m max |
| MCP calls                       |                    25 |
| Concurrent MCP calls            |                     1 |
| Guest source                    |                  1 MB |
| Search results                  | 5 default, 20 maximum |
| Search/description result       |                256 KB |
| One MCP argument payload        |                  1 MB |
| One MCP result                  |                  5 MB |
| Aggregate intermediate MCP data |                 16 MB |
| Raw HTTP response stream        |                 16 MB |
| Configuration file              |                  1 MB |
| Catalog tools per server        |                10,000 |
| One catalog tool definition     |                512 KB |
| Effective catalog tools         |                50,000 |
| stdout/stderr returned          |                 50 KB |
| Serialized final value          |                  1 MB |
| Virtual filesystem              |                 32 MB |
| QuickJS memory                  |                 64 MB |

The outer Pi abort signal and Code Mode deadline are propagated to the sandbox,
connection setup, approval wait, and MCP SDK request. Cancellation cannot undo a
remote side effect that already completed.

Parallel outer `execute` requests are queued before entering just-bash's shared
`js-exec` worker; their configured execution deadline includes queue time.

## Context7 smoke test

With `CONTEXT7_API_KEY` set and the example server configured:

```ts
const matches = await tools.search({ query: "Context7 resolve library ID" });
const resolver = matches.items.find(
  (match) => match.path === "context7.resolve-library-id",
);
if (!resolver) return matches;

return await tools.call({
  path: resolver.path,
  args: {
    libraryName: "Svelte",
    query: "Find the official Svelte documentation library",
  },
});
```

The result should include `/sveltejs/svelte` without exposing the API key.

Run the complete opt-in live test with:

```sh
PI_CODE_MODE_CONTEXT7_E2E=1 npm --prefix extensions/code-mode test
```

The opt-in clean copied-layout install check is:

```sh
PI_CODE_MODE_PACKAGING_E2E=1 node --test --experimental-strip-types extensions/code-mode/packaging.e2e.test.ts
```

## Troubleshooting

- **Server missing:** run `/mcp reload`, then `/mcp list`.
- **Project server ignored:** trust the project and reload.
- **Missing environment variable:** set it in the Pi process or `~/.pi/agent/.env`, then reconnect.
- **OAuth required:** run `/mcp auth <server>`; model-generated code cannot start it.
- **Credential-store failure:** unlock/configure the OS credential store. Because fallback is silent, check `~/.pi/agent/code-mode/oauth-fallback/` to determine whether locked files were created; do not expose their contents.
- **Diagnostic ID:** inspect `~/.pi/agent/code-mode-diagnostics.log`. Code Mode writes redacted errors there instead of writing over Pi's TUI, and rotates the previous 5 MB log to `.old`.
- **Worker/WASM resolution:** run `npm install` from the repository root after copying the complete repository to `~/.pi/agent`.
- **Duplicate MCP tools:** disable `pi-mcp-adapter` and any direct MCP-specific extension such as `@upstash/context7-pi`.

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for donor provenance and
license notices.
