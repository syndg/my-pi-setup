# Sandboxed MCP Code Mode Implementation Plan

Status: Implemented extension-only in `extensions/code-mode`; validation complete for stdio, live Context7 Streamable HTTP, sandboxing, management, permissions, and OAuth unit flows \
Updated: 2026-08-13 \
Implementation repository: `my-pi-setup@6cd4dd52270d64e35e3a70e0be2fc6019b2a467f` \
Pi runtime baseline: official Pi, installed CLI version `0.84.1`; no Pi source fork is an implementation target \
just-bash baseline: `main@d97425dff8f51cfd773d22bc009561a09235cd1b` (`just-bash@3.2.0`) \
MCP donor baseline: `pi-mcp-adapter@2.21.1` (MIT; selective source adaptation only) \
MCP SDK choice: pinned donor-compatible split v2 packages, `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/core@2.0.0`; monolithic SDK omitted

## 1. Non-negotiable invariant

**MCP tool definitions must never be registered as Pi tools or eagerly added to the model's tool context.**

The model sees one MCP orchestration tool:

```ts
execute({ code: string });
```

The Code Mode extension owns the MCP server connections, host-side tool catalog, discovery, argument validation, approval policy, and invocation. The complete MCP catalog stays outside the provider transcript.

The model receives information about an MCP tool only when its sandboxed program explicitly searches for or describes that tool. A selected result can then enter context as an ordinary `execute` result, but unrelated MCP definitions never do.

A second invariant is equally important: **version one is implemented entirely through Pi's existing extension interface.** It does not add a generic registered-tool invoker, nested tool events, credential store, or MCP subsystem to Pi core.

The extension registers only:

```ts
pi.registerTool({ name: "execute", ... })
pi.registerCommand("mcp", ...)
```

`/mcp` is a user command and does not enter the provider's tool context. A top-level `pi mcp` shell command is out of scope.

## 2. Objective

Build an opt-in extension for official Pi in the `my-pi-setup` repository. The model writes a small TypeScript-flavored program that runs through core [`just-bash`](https://github.com/vercel-labs/just-bash) and can search for, describe, and invoke MCP tools through a narrow host callback.

All implementation, tests, dependencies, setup instructions, and attribution live in `my-pi-setup`; the Pi source repository is a reference for the public extension API only.

Use:

- `just-bash` for the confined guest runtime
- The official MCP TypeScript client packages for protocol and transports
- Pi's existing extension interface for the outer `execute` tool, `/mcp`, UI, cancellation, and lifecycle
- A Code Mode-owned MCP host, registry, credential store, and host-only catalog
- Selectively adapted, attributed code and tests from MIT-licensed `pi-mcp-adapter@2.21.1` for mature MCP management behavior

Do not use:

- `pi-mcp-adapter` as a runtime dependency or loaded Pi extension
- Executor
- `@just-bash/executor`
- Dynamically registered Pi wrappers for MCP tools
- Node `vm` for generated code
- Private imports from the installed `pi-mcp-adapter` package

## 3. Architecture

```text
Provider tool context
├── read                 normal Pi tool
├── bash                 normal Pi tool
├── edit                 normal Pi tool
├── write                normal Pi tool
└── execute              the only MCP-facing Pi tool
      │
      ▼
Code Mode extension
├── just-bash runtime
├── host-only MCP catalog
├── MCP registry and configuration
├── credential store and OAuth flow
├── /mcp management command
├── search and description
├── approval policy
└── MCP connection manager
      │
      ▼
just-bash js-exec /workspace/program.ts
      │
      ▼
QuickJS/WASM worker
      │
      └── tools.* proxy
              │
              ▼
     javascript.invokeTool(path, argsJson)
              │
              ├── tools.search    → host catalog search
              ├── tools.describe  → one host catalog record
              ├── tools.call      → named MCP invocation
              └── tools.<server>.<tool> → named MCP invocation
                                      │
                                      ▼
                              MCP connection manager
                                      │
                             ┌────────┴────────┐
                             ▼                 ▼
                         stdio MCP      Streamable HTTP MCP
```

### 3.1 Context behavior

The provider request contains the schema and description of `execute`, not MCP schemas.

The complete host catalog may contain thousands of tools:

```text
Host-only catalog
├── github.search_issues
├── github.get_issue
├── github.add_comment
├── linear.list_issues
├── linear.update_issue
├── slack.search_messages
└── ...
```

None of those records enter the provider request automatically.

The model discovers a narrow subset by running code:

```ts
return await tools.search({ query: "find open Linear issues" });
```

Only the bounded search result becomes the outer `execute` result. On the next provider turn, the model can invoke the selected path:

```ts
const issues = await tools.linear.list_issues({
  assignee: "me",
  state: "open",
});

return issues;
```

This deliberate two-step flow is acceptable because it trades one provider turn for substantial catalog-token savings. A program may also search and call dynamically in one execution when it already knows how to construct the selected arguments.

## 4. Scope

### 4.1 Version-one capabilities

- One model-visible `execute` tool
- One user-facing `/mcp` slash command with interactive management
- No Pi core changes
- Erasable TypeScript and JavaScript through `js-exec`
- Host-only MCP catalog
- Lexical search over MCP tool metadata
- On-demand tool description
- Direct or dynamic MCP tool invocation
- Add, remove, enable, disable, reconnect, inspect, and test MCP servers
- OAuth authenticate and logout flows for remote servers
- stdio MCP servers
- Streamable HTTP MCP servers
- Static headers and environment-based credentials
- OS secure credential storage with a documented locked-file fallback where necessary
- Host-side argument validation
- Per-tool approval policy
- Cancellation through `AbortSignal`
- MCP content normalization
- Intermediate and final output limits
- Ephemeral virtual filesystem
- Official Pi's Node runtime
- Installation from the cloned `my-pi-setup` agent directory

### 4.2 Explicit non-goals

- Any Pi core runtime or extension-interface change
- A top-level `pi mcp` shell command or companion MCP executable
- Supporting or rebuilding the retired fullscreen Pi fork
- Patching or compiling an alternate Pi binary
- Registering MCP tools through `pi.registerTool()`
- Calling MCP tools through Pi's registered-tool lifecycle
- Loading `pi-mcp-adapter` alongside Code Mode
- Executor or `@just-bash/executor`
- General invocation of arbitrary Pi tools from guest code
- Full TypeScript typechecking or compilation
- Persistent guest state between `execute` calls
- Host project filesystem mounts
- Direct guest network access
- Python execution
- Parallel MCP calls in version one
- MCP prompts or resources in version one
- MCP sampling or elicitation in version one
- Durable pause/resume
- Eagerly injecting MCP server instructions into model context
- Persisting secrets in the catalog cache
- Automatically uninstalling npm, Python, Docker, or system packages when a server is removed

Pi's ordinary `read`, `bash`, `edit`, and `write` tools remain normal direct tools. Version one Code Mode is specifically an MCP orchestration module. Nested MCP operations are internal to the outer `execute` call and do not emit first-class Pi tool events.

## 5. Extension layout

Implement it directly as a standalone extension directory in `my-pi-setup`. There is no examples-tree stage and no later promotion into Pi's source tree.

```text
my-pi-setup/
├── docs/
│   └── code-mode-plan.md
└── extensions/
    └── code-mode/
        ├── index.ts
        ├── package.json
        ├── tsconfig.json
        ├── README.md
        ├── THIRD_PARTY_NOTICES.md
        ├── code-mode.test.ts
        └── src/
            ├── runtime.ts
            ├── program.ts
            ├── result.ts
            ├── limits.ts
            └── mcp/
                ├── config.ts
                ├── registry.ts
                ├── commands.ts
                ├── setup.ts
                ├── host.ts
                ├── connection-manager.ts
                ├── catalog.ts
                ├── search.ts
                ├── schema.ts
                ├── permissions.ts
                ├── content.ts
                ├── auth-store.ts
                ├── oauth-provider.ts
                ├── oauth-flow.ts
                └── callback-server.ts
```

Install `just-bash`, the selected MCP client packages, JSON Schema validation, browser-opening, and keyring dependencies from the `my-pi-setup` repository root using `npm install`, so `package.json` and `package-lock.json` stay authoritative for the cloned `~/.pi/agent` setup. Use `extensions/code-mode/package.json` for extension-scoped scripts and metadata; do not require a second production install unless native dependency isolation proves unavoidable.

The extension uses only official Pi's published extension capabilities: `pi.registerTool()`, `pi.registerCommand()`, `ctx.ui`, tool abort signals and updates, project trust, extension lifecycle events, and ordinary host filesystem access. Worker, WASM, or keyring asset-resolution fixes belong to `extensions/code-mode` or the setup repository's install process, never to a Pi fork.

## 6. Deep MCP host module

The MCP host is the main module. It hides transports, connection state, catalog refresh, validation, permissions, cancellation, content normalization, output guarding, and shutdown behind a small interface.

Proposed interface:

```ts
type McpHost = {
  search(input: SearchInput, options: HostOptions): Promise<SearchResult>;
  describe(path: string, options: HostOptions): Promise<ToolDescription>;
  call(input: CallInput, options: CallOptions): Promise<McpCallResult>;
  close(): Promise<void>;
};
```

This is the interface used by the just-bash callback and by tests.

Do not expose individual clients, transports, validators, caches, or approval helpers through the external interface. They are internal seams.

### 6.1 Search input

```ts
type SearchInput = {
  query: string;
  limit?: number;
  cursor?: string;
};
```

### 6.2 Call input

```ts
type CallInput = {
  path: string;
  args: unknown;
};
```

### 6.3 Host options

```ts
type HostOptions = {
  signal: AbortSignal;
};

type CallOptions = HostOptions & {
  parentToolCallId: string;
  onStatus?: (status: CallStatus) => void;
};
```

### 6.4 Call behavior

For every MCP call, the host must:

1. Resolve the exact configured server and advertised tool.
2. Reject unknown or stale paths.
3. Validate arguments against the advertised input schema.
4. Evaluate the host approval policy.
5. Ask the user when policy is `ask`.
6. Re-check cancellation before transport invocation.
7. Call the MCP server through the official SDK.
8. Pass the effective `AbortSignal` to the SDK request.
9. Validate the protocol result shape.
10. Enforce intermediate-result limits.
11. Normalize supported MCP content.
12. Sanitize transport and infrastructure errors.
13. Record a bounded trace entry.
14. Return a stable guest result envelope.

The guest never receives an MCP `Client`, URL, child-process handle, transport, environment object, or credential.

### 6.5 Extension-only execution seam

The just-bash callback calls `McpHost` directly. It does not call Pi tools, create synthetic Pi tool calls, or require `ctx.invokeTool()`. Pi observes the normal lifecycle of the outer `execute` tool only.

Per-MCP-call approval, tracing, argument validation, and cancellation are owned by `McpHost`. Other Pi extensions can observe the outer `execute` call but not each internal MCP operation. This trade-off is deliberate because registering nested MCP operations with Pi would undermine catalog isolation.

### 6.6 MCP registry interface

Management commands use a second deep module:

```ts
type McpRegistry = {
  list(): Promise<ServerRecord[]>;
  add(input: AddServerInput): Promise<ServerRecord>;
  remove(name: string, options?: RemoveServerOptions): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  reload(): Promise<void>;
};
```

The registry owns configuration lookup, global/project scope, atomic writes, project trust checks, connection teardown, catalog invalidation, and credential cleanup decisions. Slash-command handlers must remain thin adapters over this interface.

## 7. MCP configuration

Use a Code Mode-owned configuration file rather than adapter configuration. The exact location should follow Pi's extension configuration conventions; a concrete initial shape is:

```json
{
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "requestTimeoutMs": 300000
    },
    "linear": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LINEAR_TOKEN}"
      },
      "requestTimeoutMs": 300000
    }
  },
  "permissions": {
    "github.search_issues": "allow",
    "github.get_issue": "allow",
    "github.add_comment": "ask",
    "linear.*": "ask",
    "linear.delete_issue": "deny"
  },
  "executionTimeoutMs": 300000
}
```

### 7.1 Configuration rules

- Server names must be unique and valid guest namespace keys.
- Environment placeholders are resolved host-side.
- Resolved credentials must never enter the catalog or guest result.
- stdio commands and arguments come only from trusted configuration.
- Guest programs cannot add or alter MCP servers.
- HTTP URLs come only from trusted configuration.
- Redirect and origin behavior must follow the MCP SDK's secure defaults.
- Unknown configuration fields should fail validation rather than be ignored silently.
- `executionTimeoutMs` and per-server `requestTimeoutMs` default to 30 seconds and accept integer millisecond values from 1 ms through 10 minutes.
- Project `executionTimeoutMs` overrides the global value; a project server definition replaces the complete same-named global server, including its request timeout.

### 7.2 Authentication

Version one supports:

- stdio environment variables
- Static HTTP headers populated from environment variables
- Bearer tokens referenced through environment variables or the secure credential store
- Remote OAuth discovery, PKCE, dynamic client registration, refresh, authenticate, and logout
- Explicitly disabling OAuth for a remote server

OAuth is user-initiated through `/mcp auth <server>` or the interactive `/mcp` panel. A model-generated `execute` call must never open a browser. If automatic refresh cannot recover, the call returns a bounded error instructing the user to authenticate.

The host implements the selected SDK's OAuth provider persistence callbacks. Adapt the mature provider, callback-server, and keyring behavior from `pi-mcp-adapter`; do not invent a new OAuth protocol implementation.

### 7.3 Server installation semantics

Adding a server means registering trusted connection configuration:

- Remote servers require no local installation; store the URL and host-side auth configuration.
- Package-runner stdio servers store a structured command and arguments such as `npx -y package` or `uvx package`. The runner owns download and caching.
- Preinstalled binaries store an executable path and argument array.

The MCP SDK spawns or connects; it does not install packages. Never accept a shell command string for execution when a command plus argument array can be stored instead.

Removing a server closes its client and process, removes its config entry and catalog cache, and asks whether to remove credentials. It does not run package-manager uninstall commands, clear shared caches, delete binaries, or remove Docker images.

### 7.4 `/mcp` management surface

Register one Pi slash command:

```text
/mcp                         interactive management panel
/mcp list                    list configured servers and status
/mcp add                     interactive global/project setup
/mcp remove <server>         remove config and optionally credentials
/mcp enable <server>         enable a configured server
/mcp disable <server>        disable without deleting config
/mcp reconnect [server]      reconnect one server or all servers
/mcp auth [server]           run user-initiated OAuth
/mcp logout <server>         remove stored credentials
/mcp test <server>           test connection and tools/list
/mcp tools <server>          inspect host-side tool count and metadata
/mcp reload                  reload configuration and invalidate state
```

Use `pi.registerCommand("mcp", ...)`, argument completions, and `ctx.ui.select/input/confirm/custom`. In non-interactive modes, require complete arguments and return a clear error for UI-dependent flows.

`/mcp add` must choose global or project scope, validate a unique name and transport, write atomically, and optionally test the connection. Project-local stdio servers may launch only when `ctx.isProjectTrusted()` is true.

`/mcp remove` must show scope and transport, confirm destructive changes, close the active connection, invalidate catalog metadata, and handle credentials keyed by server identity rather than display name alone.

A top-level `pi mcp` CLI adapter is explicitly deferred. Slash commands are sufficient for version one and do not enter model context.

### 7.5 Credential storage

Adapt `pi-mcp-adapter`'s OS keyring implementation, URL-bound credential identity, legacy plaintext migration, PKCE/state persistence, and cleanup behavior. Preserve issuer information supplied by the SDK and serialize authentication or refresh work per server to avoid concurrent refresh races.

Credential records are keyed by configuration scope, server name, normalized server URL, and authorization issuer where available. A URL or issuer change invalidates incompatible tokens and dynamic client registration.

Never store resolved credentials in the main MCP config, catalog cache, traces, approvals, guest memory, or session transcript. Any fallback file must be permissioned to `0600`, written atomically, and documented as less preferable than the OS secure store.

## 8. Connection management

Use the official MCP TypeScript SDK `Client` with:

- `StdioClientTransport` for configured local servers
- `StreamableHTTPClientTransport` for configured HTTP servers

### 8.1 Lifecycle

- Parse configuration when the extension loads.
- Do not start every server merely to construct the provider request.
- Reuse one connected client per configured server.
- Connect lazily when search, describe, or call needs that server.
- Close clients and stdio child processes on session shutdown or extension unload.
- Remove failed clients from the live map so a later request can reconnect.
- Bound simultaneous connection attempts.

### 8.2 Discovery

`tools/list` responses populate the host-only catalog. Tool list metadata may be cached on disk so later sessions can search before reconnecting every server.

Cache rules:

- Store server name, tool name, description, input schema, annotations, and refresh metadata.
- Never store resolved headers, environment values, OAuth tokens, or transport secrets.
- Namespace cache entries by a non-secret server configuration fingerprint.
- Mark cached records stale until the server confirms them.
- Refresh when the server sends a tool-list-changed notification.
- Reject a stale call if the live server no longer advertises the selected tool.

Persistence is an optimization, not a source of authority. The live server's advertised catalog wins.

### 8.3 Selective reuse from `pi-mcp-adapter`

Use `pi-mcp-adapter@2.21.1` as a tested donor implementation, not as a runtime dependency. Its package is MIT licensed by Nico Bailon; retain the copyright and permission notice for substantial copied portions.

Prioritize adaptation of:

```text
server-manager.ts
runtime-owner.ts
abort.ts
session-recovery.ts
lifecycle.ts
mcp-status.ts
config.ts
types.ts
commands.ts
mcp-panel.ts
mcp-setup-panel.ts
npx-resolver.ts
json-schema-validator.ts
metadata-cache.ts
search-ranking.ts
ts-shape.ts
tool-approval.ts
mcp-output-guard.ts
mcp-auth.ts
mcp-keyring-helper.cjs
mcp-oauth-provider.ts
mcp-auth-flow.ts
mcp-callback-server.ts
```

Port the relevant tests with the code, especially OAuth state and URL binding, keyring fallback and migration, callback cleanup, abort races, reconnect single-flight, stale-session recovery, schema drafts, approval behavior, and output limits.

Do not carry over:

```text
direct-tools.ts
tool-registrar.ts
proxy-modes.ts
mcp-code.ts
mcp-script-worker.mjs
resource-tools.ts
prompts.ts
sampling-handler.ts
elicitation-handler.ts
agent-plugin-loader.ts
MCP Apps and UI bridge modules
```

Do not import those donor files through unexported package paths. Either adapt them into Code Mode with provenance comments or first extract an intentionally supported host package upstream.

The donor uses `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/core@2.0.0`, while the initial plan referenced monolithic SDK v1.29. Phase 0 must choose one coherent SDK line based on stability, API compatibility, packaging, and how much donor code can be safely retained. Do not mix both client generations.

## 9. Host-only catalog

The catalog is never translated into Pi `ToolDefinition` objects.

Canonical record:

```ts
type CatalogTool = {
  path: string;
  server: string;
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  freshness: "cached" | "live";
};
```

Canonical paths use server namespaces:

```text
github.search_issues
linear.list_issues
slack.search_messages
```

Reject collisions during configuration or discovery rather than silently renaming tools.

### 9.1 No eager catalog injection

The `execute` description explains the guest operations but contains no complete MCP tool definitions.

It may contain configured server names and a few syntax examples, subject to a small fixed character budget. It must not inline the full list of tools or schemas.

The only ways MCP metadata reaches the model are:

1. A bounded `tools.search()` result returned by an `execute` program.
2. A single `tools.describe()` result returned by an `execute` program.
3. A bounded MCP invocation result selected and returned by the program.

## 10. Search and description

### 10.1 Guest operations

```ts
const matches = await tools.search({
  query: "search GitHub issues",
  limit: 5,
});

const description = await tools.describe({
  path: matches[0].path,
});
```

### 10.2 Search behavior

Search over:

- Server name
- Tool name
- Canonical path
- Tool description
- Input property names
- Input property descriptions

Use deterministic weighted lexical ranking:

1. Exact path match
2. Exact tool-name match
3. Prefix match
4. Token overlap in name and path
5. Input-field match
6. Description match

Defaults:

- Five results
- Maximum twenty results
- Stable pagination
- Stable lexical tie-breaking

Return only bounded summaries:

```ts
type SearchMatch = {
  path: string;
  description?: string;
  input: string;
  freshness: "cached" | "live";
};
```

### 10.3 Schema rendering

Render MCP JSON Schema as concise TypeScript for model guidance only.

Support common forms:

- Objects and required properties
- Strings, numbers, integers, and booleans
- Arrays and tuples
- Enums and literal unions
- `anyOf`, `oneOf`, and nullable values
- Nested objects
- Additional properties

Fall back to `unknown` for unsupported schema constructs. Runtime validation remains host-side.

### 10.4 Runtime validation

Use a maintained JSON Schema validator with draft-07 and 2020-12 support. Compile validators lazily and cache them by server/tool/schema fingerprint.

The MCP server remains responsible for its own validation as well. Host validation improves errors and prevents obviously invalid calls from reaching an approved remote operation.

## 11. Permissions and approvals

Permissions are evaluated for each MCP invocation, not once for the outer `execute` program.

Rules use canonical paths and support exact and server-wide patterns:

```text
github.search_issues → allow
github.add_comment   → ask
github.*             → ask
linear.delete_issue  → deny
```

Resolution order:

1. Exact tool rule
2. Server wildcard rule
3. Global default

Safe default:

- Read-only tools may be configured as `allow`.
- Unknown, mutating, or destructive tools default to `ask`.
- In non-interactive operation, unresolved `ask` decisions fail closed unless an explicit non-interactive policy is configured.

Treat MCP annotations as hints, not trusted proof. A server claiming that a tool is read-only must not automatically override an explicit local rule.

Approval UI should display:

- Server and tool path
- Description
- Bounded arguments with secrets redacted
- Parent `execute` tool-call ID
- Current call count and remaining budget

The guest receives only `allowed`, `denied`, or a sanitized failure. It cannot access approval configuration or UI handles.

## 12. Model-facing `execute` tool

### 12.1 Input

```ts
{
  code: string;
}
```

Timeouts and resource limits are host policy and are not model-controlled in version one.

### 12.2 Tool description

The description teaches only the stable guest interface:

```ts
await tools.search({ query, limit?, cursor? })
await tools.describe({ path })
await tools.call({ path, args })
await tools.<server>.<tool>(args)
return value
```

It explicitly says:

- Search before calling an unfamiliar tool.
- Use the exact returned path and input shape.
- Return only the information needed by the user.
- Intermediate MCP results stay in the sandbox unless returned.
- Calls are sequential in version one.

Do not include all MCP definitions in this description.

### 12.3 Program wrapper

Wrap supplied source in an async function so the model can use `await` and `return`:

```ts
const issues = await tools.linear.list_issues({ state: "open" });
return issues.content.filter((issue) => issue.priority === "urgent");
```

The wrapper serializes the return value through a private sentinel. `console.log` and `console.error` are collected separately as bounded diagnostics.

### 12.4 TypeScript support

Use just-bash's type stripping. Support erasable TypeScript syntax but do not typecheck.

Document unsupported constructs that require TypeScript runtime lowering:

- Enums
- Namespaces
- Parameter properties
- Legacy decorators
- Similar non-erasable syntax

## 13. just-bash runtime

Create a fresh `Bash` instance for every `execute` call.

### 13.1 Filesystem

- Ephemeral in-memory filesystem
- Wrapped program at `/workspace/program.ts`
- No host project mount
- No persistence between calls
- Maximum size: 32 MB

### 13.2 JavaScript

- Execute through `js-exec`
- QuickJS/WASM worker
- Existing 64 MB JavaScript memory default
- Configurable JavaScript timeout: 30 seconds by default, up to 10 minutes
- No Node globals or modules
- No host environment variables

### 13.3 Network and commands

- Guest network disabled
- No host command execution
- just-bash virtual commands may operate only on the virtual filesystem
- Python disabled
- No custom command may close over ambient host authority

### 13.4 Host callback routing

The callback receives exactly:

```ts
invokeTool(path: string, argsJson: string): Promise<string>
```

Route only known operations:

```text
search                     host catalog search
describe                   host catalog description
call                       dynamic MCP call
<configured-server>.<tool> exact MCP call
```

Reject:

- Unknown servers
- Unknown tools
- Arbitrary URLs
- Arbitrary process commands
- Reserved namespace collisions
- Recursive `execute` attempts
- Malformed JSON

## 14. Result transport

Use a stable JSON envelope inside the guest:

```ts
type CodeModeMcpResult = {
  ok: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mediaType: string; data?: string }
    | { type: "resource"; uri: string; text?: string }
  >;
  structuredContent?: unknown;
  error?: {
    code: string;
    message: string;
  };
};
```

Preserve supported MCP content without exposing transport internals. Reject or safely summarize unsupported content types.

Expected MCP tool failures return `ok: false` so guest code can recover. Unexpected infrastructure failures throw sanitized errors with opaque diagnostic IDs.

Do not automatically place every intermediate MCP result in the outer Pi result. Only the program's returned value becomes model-visible.

## 15. Limits

Default and configurable limits:

| Resource                      |                                Limit |
| ----------------------------- | -----------------------------------: |
| Total `execute` time          | 30-second default; 10-minute maximum |
| JavaScript time               | 30-second default; 10-minute maximum |
| One MCP request               | 30-second default; 10-minute maximum |
| MCP calls                     |                                   25 |
| Concurrent MCP calls          |                                    1 |
| Source code                   |                                 1 MB |
| Search results                |                5 default, 20 maximum |
| Search/describe output        |                 256 KB per operation |
| One MCP result                |                                 5 MB |
| Total intermediate MCP data   |                                16 MB |
| Final stdout and stderr       |                                50 KB |
| Final serialized return value |                                 1 MB |
| Virtual filesystem            |                                32 MB |
| QuickJS memory                |                                64 MB |

Use just-bash's hardened execution profile and override only documented limits required by Code Mode.

The extension owns MCP-call and intermediate-data counters because those resources cross the host callback and are not fully covered by shell limits.

## 16. Cancellation

Create one deadline controller per outer `execute` call. Combine:

- Pi's outer tool abort signal
- The configured Code Mode execution deadline

Pass the effective signal to:

- `Bash.exec()`
- Catalog connection and refresh operations
- MCP SDK `callTool()` requests
- Approval waits

On cancellation:

1. Stop accepting new guest operations.
2. Abort the current MCP request cooperatively.
3. Stop the just-bash worker.
4. Ignore late updates and results.
5. Return a concise cancellation result.

Cancellation cannot undo side effects already completed by an MCP server.

## 17. Trace and UI

The outer `execute` tool streams concise status updates:

```text
Searching MCP catalog…
Calling github.search_issues (1/25)…
Calling linear.list_issues (2/25)…
Completed 2 MCP calls in 1.8s
```

Collect a bounded trace in outer result `details`:

```ts
type CodeModeTraceEntry = {
  server: string;
  tool: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error" | "denied" | "cancelled";
  inputBytes: number;
  outputBytes: number;
};
```

Do not store full arguments or full MCP results in the trace by default.

Only the outer `execute` tool appears in provider history. Nested MCP operations remain implementation details of that call.

## 18. Error model

### 18.1 Guest errors

Examples:

- Syntax error
- Unsupported TypeScript syntax
- Reference error
- Explicit throw

Return bounded source location and diagnostic text without worker internals or host paths.

### 18.2 Expected MCP errors

Examples:

- Invalid arguments
- Permission denied
- MCP tool returned `isError`
- Server unavailable

Return a structured `ok: false` result so the guest can inspect or recover when appropriate.

### 18.3 Infrastructure errors

Examples:

- Worker bridge failure
- Unexpected SDK exception
- Serialization failure
- Cache corruption

Return a sanitized message and opaque diagnostic ID. Keep full details in local logs only.

## 19. Implementation phases

### Phase 0: Runtime, dependency, and packaging spike

Build a disposable `extensions/code-mode` spike that:

1. Runs a `.ts` file through `js-exec`.
2. Calls a fake host operation through `tools.*`.
3. Uses an interface and generic to prove type stripping.
4. Cancels an infinite loop.
5. Enforces output and filesystem limits.
6. Runs from the `my-pi-setup` checkout under the installed official Pi CLI.
7. Runs after the repository is cloned or copied to `~/.pi/agent` and installed with the documented root `npm install`.
8. Uses only official Pi's published extension/package exports and no fullscreen-fork API.
9. Audits `pi-mcp-adapter@2.21.1` modules and tests for selective adaptation.
10. Chooses one MCP SDK generation; prefer the donor-compatible split v2 packages if they pass stability and packaging checks.
11. Records donor provenance and licensing requirements.

Add dependencies with `npm install` from the setup repository root rather than editing package manifests manually. Validate just-bash worker/WASM resolution and any keyring helper or native asset resolution from both repository and installed-agent layouts.

Exit criterion: the extension runs on official Pi without modifying or rebuilding Pi, one MCP SDK line is selected, dependency assets resolve from the normal `my-pi-setup` installation, and the donor/adapt/rewrite matrix is recorded.

### Phase 1: Minimal MCP host

Adapt the narrow lifecycle, cancellation, and connection behavior needed for configuration, one stdio server, lazy connection, `tools/list`, `callTool`, reconnect, and shutdown.

Use an in-process MCP test server and transport adapter. Port applicable donor tests instead of testing private implementation details.

Exit criteria:

- MCP tools are not registered with Pi.
- The provider sees only `execute`.
- No Pi core source file changes are required.
- The host can list and invoke a configured test server.
- Unknown servers and tools are rejected.
- Closing the session closes the MCP client and child process.

### Phase 2: Sandboxed `execute`

Integrate `McpHost` with a fresh just-bash instance and the `tools.*` callback.

Exit criteria:

- A TypeScript-flavored program invokes an MCP tool and returns a filtered result.
- Intermediate MCP data does not enter provider history.
- The guest cannot access Node, host files, host environment, network, credentials, or transport objects.
- Recursion and arbitrary server creation are impossible.

### Phase 3: Host-only discovery

Add host catalog, search, describe, TypeScript schema rendering, namespacing, and a non-secret metadata cache.

Exit criteria:

- No full MCP catalog is present in the `execute` description.
- Search returns only bounded relevant matches.
- Describe returns one selected tool.
- Dynamic tool-list changes invalidate or refresh affected records.
- Cached records are never treated as live authority for invocation.

### Phase 4: `/mcp` registry and management

Adapt the useful command and panel patterns from `pi-mcp-adapter`, backed by the new `McpRegistry`. Implement list, add, remove, enable, disable, reconnect, test, tools, reload, and global/project scopes.

Exit criteria:

- All management is available through the extension-owned `/mcp` command.
- Add and remove update configuration atomically.
- Project-local stdio execution requires project trust.
- Removing a server tears down runtime state without uninstalling external packages.
- No top-level `pi mcp` CLI or Pi core change is introduced.

### Phase 5: Streamable HTTP, credentials, and OAuth

Add Streamable HTTP, environment-derived headers, secure credential storage, OAuth provider, callback server, authenticate, refresh, logout, and reconnect behavior by selectively adapting the donor implementation.

Exit criteria:

- stdio and Streamable HTTP share the same MCP host interface.
- OAuth can begin only from a user-initiated `/mcp auth` flow.
- Stored tokens refresh without entering guest or model context.
- URL and issuer changes invalidate incompatible credentials.
- Abort behavior works for transports and pending auth.
- Credential-store and OAuth security tests pass.

### Phase 6: Permissions and hardening

Add JSON Schema validation, allow/ask/deny rules, interactive approval, non-interactive fail-closed behavior, output guarding, sanitization, and all budgets.

Exit criteria:

- Approval is checked for every MCP call.
- Guest code cannot bypass policy.
- Every documented limit has a test.
- Secrets do not enter guest results, traces, cache, or transcript.
- Unexpected host errors do not expose internals.

### Phase 7: Documentation and rollout

Document extension installation, `/mcp` management, server registration versus package installation, permissions, OAuth, guest operations, TypeScript constraints, limits, donor attribution, troubleshooting, and security assumptions.

Exit criteria:

- Loading the extension adds only `execute` to Pi's provider tool surface and `/mcp` to the user command surface.
- A fresh user can add one MCP server and run a search-then-call flow.
- Disabling the extension removes Code Mode without affecting Pi's direct tools.
- The implementation remains extension-only.

### Phase 8: Optional host-side batching

The current just-bash bridge is synchronous, so ordinary `Promise.all()` does not create genuine MCP concurrency. If measurements justify it, add:

```ts
await tools.parallel([
  { path: "github.get_issue", args: { number: 1 } },
  { path: "github.get_issue", args: { number: 2 } },
]);
```

Enforce a maximum of eight concurrent calls, stable result order, shared cancellation, and per-call approval. This is not required for version one.

## 20. Test plan

### 20.1 Context isolation

- Provider request contains `execute` but no MCP tool definitions.
- MCP tools are never passed to `pi.registerTool()`.
- A catalog with thousands of tools does not change provider tool-schema size.
- Search returns only its configured bounded result count.
- Only the outer `execute` call and result enter provider history.

### 20.2 MCP host

- Connects lazily to stdio server
- Connects lazily to Streamable HTTP server
- Lists and namespaces tools
- Reuses healthy clients
- Reconnects after failure
- Refreshes tool-list changes
- Rejects stale or unknown paths
- Validates arguments
- Propagates `AbortSignal`
- Closes clients and child processes
- Does not cache secrets

### 20.3 Management and authentication

- `/mcp` is registered as a user command and never as a provider tool
- Lists global and project servers with scope and status
- Adds stdio configuration as a command plus argument array
- Adds Streamable HTTP configuration with environment-referenced secrets
- Requires project trust before launching project-local stdio configuration
- Enables and disables without deleting configuration
- Reconnects one server and all servers
- Removes configuration, runtime state, cache, and optionally credentials
- Never uninstalls external packages during removal
- Starts OAuth only from an explicit user action
- Validates callback state and PKCE
- Binds credentials to server URL and issuer
- Refreshes tokens through a per-server single-flight path
- Logs out without removing server configuration
- Redacts credentials in UI, logs, traces, and errors
- Fails closed for UI-required operations in non-interactive mode

### 20.4 Permissions

- Exact rule beats wildcard
- Wildcard beats default
- Deny never reaches the server
- Ask displays bounded redacted arguments
- Non-interactive ask fails closed
- Server annotations do not override local policy
- Every call in a loop is checked independently

### 20.5 Sandboxed runtime

- Executes JavaScript
- Strips erasable TypeScript
- Supports `await` and `return`
- Searches and describes tools
- Invokes direct namespace path
- Invokes dynamic path through `tools.call`
- Filters large intermediate results
- Handles expected MCP errors
- Cannot import Node built-ins
- Cannot read `process.env`
- Cannot access host files
- Cannot use guest network
- Cannot create arbitrary MCP clients
- Infinite loop times out
- Output, filesystem, call-count, and intermediate-data limits hold

### 20.6 Packaging

- Development checkout under the installed official Pi CLI
- Repository cloned or copied to `~/.pi/agent`
- Root `npm install` using the committed lockfile
- Extension auto-discovery from `~/.pi/agent/extensions/code-mode`
- Worker asset lookup after installation
- QuickJS WASM/module lookup after installation
- Keyring helper or native asset lookup after installation
- Offline startup after dependencies are installed
- No imports from the retired fullscreen fork

## 21. Evaluation plan

Compare direct eager MCP exposure with Code Mode on repeatable tasks.

Measure:

- MCP schema tokens in provider requests
- Number of provider turns
- Total input and output tokens
- Time to first MCP call
- End-to-end latency
- Number of approvals
- MCP call success rate
- Final-answer correctness
- Intermediate data entering provider context

Representative tasks:

- Find the correct tool among hundreds
- Search then invoke one unfamiliar tool
- Fetch a large list and return only matching rows
- Join two MCP results
- Paginate until a condition is met
- Recover from an expected MCP error
- Attempt a denied MCP operation

Success means:

- Provider MCP schema cost remains approximately constant as the MCP catalog grows.
- Relevant tools remain discoverable.
- Large intermediate results remain inside the sandbox.
- Approval and security behavior remain correct.

## 22. Risks and mitigations

### Adapting a mature MCP host creates forked security-sensitive code

Mitigation: selectively adapt only the needed MIT-licensed modules and their tests from `pi-mcp-adapter@2.21.1`, preserve attribution and exact provenance, keep the Code Mode interfaces narrow, and schedule periodic donor security reviews. Do not depend on unexported package internals.

### MCP SDK generations differ between the donor and initial research

Mitigation: select one coherent SDK line during Phase 0. Prefer the donor-compatible split v2 packages if stable and packageable; otherwise port intentionally to v1.29. Never mix OAuth or transport types from both generations.

### Search requires connecting to servers with no cache

Mitigation: use a non-secret metadata cache and refresh lazily. Connecting does not add tool schemas to model context.

### Official Pi installation cannot resolve just-bash or credential-store assets

Mitigation: make normal `my-pi-setup` installation the first gate, test from a clean `~/.pi/agent` layout, and keep asset-resolution fixes inside the extension or setup process. Do not patch or rebuild Pi.

### The synchronous bridge adds latency

Mitigation: begin sequentially for correctness and add explicit host batching only after measurement.

### MCP output overwhelms the worker bridge

Mitigation: enforce per-result and aggregate byte limits before copying content into QuickJS.

### Configured stdio servers have host authority

Mitigation: treat server configuration as trusted, never permit guest-created command lines, and document the MCP server trust model.

### just-bash is not a formal security proof

Mitigation: follow its threat model, use QuickJS for generated JavaScript, keep host callbacks narrow, disable unnecessary capabilities, and enforce defense-in-depth budgets.

## 23. Completion criteria

The feature is complete when:

- The implementation is entirely extension-owned and requires no Pi core source changes.
- Pi registers exactly one MCP-facing provider tool: `execute`.
- Pi registers one user command: `/mcp`; it does not enter model context.
- No MCP tool definition is registered with Pi or included in provider tool context.
- Catalog size does not materially affect provider-request schema tokens.
- The model can search, describe, and invoke MCP tools through sandboxed code.
- MCP metadata enters context only through bounded, explicit program results.
- Generated code runs through just-bash's QuickJS/WASM worker and ephemeral filesystem.
- Guest code has no ambient Node, host filesystem, environment, network, credential, or MCP transport access.
- Every MCP invocation is resolved, validated, approved, bounded, cancellable, and normalized by the host.
- Intermediate MCP results remain outside provider history unless the program returns them.
- `/mcp` can add, remove, enable, disable, reconnect, test, authenticate, and log out servers.
- OAuth credentials are stored securely, tied to server identity, and never enter guest or model context.
- Server removal does not uninstall externally managed packages.
- stdio and Streamable HTTP work under supported official Pi releases.
- Existing Pi behavior is unchanged when the extension is absent or disabled.
- The full implementation, tests, notices, and setup instructions live in `my-pi-setup`.

## 24. Recommended commit sequence

1. `feat(code-mode): add sandboxed runtime`
2. `feat(code-mode): add internal mcp host`
3. `feat(code-mode): add lazy mcp discovery`
4. `feat(code-mode): add mcp management command`
5. `feat(code-mode): add secure mcp authentication`
6. `feat(code-mode): add mcp approval policy`
7. `test(code-mode): harden sandbox isolation`
8. `docs(code-mode): document mcp code mode`

Keep runtime, MCP hosting, discovery, management, authentication, and hardening in separately reviewable commits in `my-pi-setup`. Preserve donor attribution in every commit that adapts substantial `pi-mcp-adapter` source. Do not modify Pi core, resurrect the fullscreen fork, or introduce a top-level `pi mcp` CLI unless a later requirement explicitly justifies it.
