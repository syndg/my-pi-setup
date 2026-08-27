# Supabase hosted MCP in Pi Code Mode

**Checked:** 2026-08-13 against Supabase MCP docs and `supabase/mcp` commit [`302d2ad`](https://github.com/supabase/mcp/tree/302d2ad7870352444ca0d71711622ab38a66e4ff), plus this Pi setup at `c34bd3b`.

## Recommendation

Use Supabase's hosted Streamable HTTP endpoint with browser OAuth, scope it to one **non-production development project**, enable read-only mode, restrict feature groups, and require interactive approval for every Supabase tool call.

Merge this entry and permission into `~/.pi/agent/code-mode.json` (do not replace existing servers/permissions). Replace `<PROJECT_REF>` with the development project's public project ref; it is an identifier, not a secret.

```json
{
  "servers": {
    "supabase": {
      "transport": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=<PROJECT_REF>&read_only=true&features=database,docs",
      "oauth": true
    }
  },
  "permissions": {
    "supabase.*": "ask"
  }
}
```

This is the exact Code Mode shape: the root key is `servers`; an HTTP entry accepts `transport`, `url`, optional `headers`, `enabled`, boolean `oauth`, and optional `requestTimeoutMs`; permissions are `allow | ask | deny`; optional root `executionTimeoutMs` bounds the complete queued sandbox execution. Timeouts default to 30 seconds and are capped at 10 minutes. `code-mode-catalog.json` is generated metadata/cache (`version`, fingerprints, tools, timestamps), not user configuration and should not be edited. [Code Mode types](../../extensions/code-mode/src/mcp/types.ts) [strict parser](../../extensions/code-mode/src/mcp/config.ts) [configuration docs](../../extensions/code-mode/README.md#configuration)

Do not simultaneously load `pi-mcp-adapter`: Code Mode owns MCP configuration/lifecycle and its docs explicitly warn against duplicate MCP integrations. The installed adapter was reviewed for comparison, but it uses a different `mcpServers`/`auth` config surface and is not the target here. [Code Mode install warning](../../extensions/code-mode/README.md#L25-L26) [troubleshooting](../../extensions/code-mode/README.md#troubleshooting)

## Hosted endpoint and URL controls

- Hosted endpoint: `https://mcp.supabase.com/mcp`. Local Supabase CLI uses `http://localhost:54321/mcp`; the local server has a limited tool subset and no OAuth 2.1. [Supabase setup docs](https://supabase.com/docs/guides/ai-tools/mcp#remote-mcp-installation) [official repository README](https://github.com/supabase/mcp/blob/302d2ad7870352444ca0d71711622ab38a66e4ff/README.md#cli)
- `project_ref=<id>` limits the server to one project and disables account-management tools. [Configuration options](https://supabase.com/docs/guides/ai-tools/mcp#configuration-options) [account tools](https://supabase.com/docs/guides/ai-tools/mcp#account-management)
- `read_only=true` executes queries as a read-only Postgres user. The official package README additionally states that read-only filtering excludes mutating tools. Treat this as defense in depth, not permission to use production data. [Configuration options](https://supabase.com/docs/guides/ai-tools/mcp#configuration-options) [official README filtering semantics](https://github.com/supabase/mcp/blob/302d2ad7870352444ca0d71711622ab38a66e4ff/README.md#usage-with-ai-sdks-mcp-client)
- `features=<groups>` enables only comma-separated tool groups. The recommended `database,docs` follows Supabase's documented example and excludes debugging, development keys/config, Edge Functions, account management, branching, and Storage. Storage is disabled by default; all other groups are enabled by default when `features` is omitted. [Configuration options](https://supabase.com/docs/guides/ai-tools/mcp#configuration-options) [available tools](https://supabase.com/docs/guides/ai-tools/mcp#available-tools)
- Parameters combine with `&`, as shown in the snippet. Supabase's documented combined example is `?project_ref=abc123&read_only=true`. [Configuration options](https://supabase.com/docs/guides/ai-tools/mcp#configuration-options)

## Authentication

The hosted server defaults to OAuth using dynamic client registration, so ordinary interactive use needs neither a PAT nor a manually created OAuth app. The browser flow logs into Supabase and grants the client access to the selected organization; choose the organization containing the scoped project. [Authentication](https://supabase.com/docs/guides/ai-tools/mcp#authentication) [manual authentication](https://supabase.com/docs/guides/ai-tools/mcp#manual-authentication)

In Code Mode, `"oauth": true` enables OAuth for an HTTP server. Start it explicitly with `/mcp auth supabase`; model-generated `execute` code cannot open the browser. Code Mode uses discovery, PKCE, dynamic registration, issuer validation, refresh/logout, binds credentials to scope/name/URL/issuer, and prefers the OS credential store. [Code Mode authentication](../../extensions/code-mode/README.md#authentication)

PAT authentication is only the documented fallback for CI/headless use: send `Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}` and keep the token in environment-backed configuration. A manually registered OAuth app is only needed when a client cannot perform dynamic registration. Do not add either to the interactive recommendation. [Supabase CI authentication](https://supabase.com/docs/guides/ai-tools/mcp#ci-environment) [manual OAuth app](https://supabase.com/docs/guides/ai-tools/mcp#manual-oauth-app)

## Security guidance

Supabase says the MCP server is for development/testing, not production. Use non-production or obfuscated data; do not expose this developer-permission server to customers; project-scope it; use read-only mode; restrict feature groups; and use database branches for risky work. Prompt injection in database content can induce unintended queries or disclosure. Keep per-tool approval enabled and inspect every proposed call and its output; Supabase's SQL-result wrapping is explicitly not foolproof. [Security risks and recommendations](https://supabase.com/docs/guides/ai-tools/mcp#security-risks)

The local configuration deliberately differs from this safety recommendation: `"supabase.*": "allow"` permits every exposed Supabase call without confirmation, and the configured endpoint is write-capable. Code Mode still validates each call, but MCP annotations cannot override local policy. [Code Mode permissions](../../extensions/code-mode/README.md#permissions)

## Verification

After merging the snippet:

1. Run `/mcp reload`.
2. Run `/mcp list` and confirm `supabase` is present.
3. Run `/mcp auth supabase`, complete browser consent, and choose the organization containing `<PROJECT_REF>`.
4. Run `/mcp test supabase`, then `/mcp tools supabase`.
5. Confirm only the intended Database and Docs tools appear; account-management and mutating tools should be absent in project-scoped/read-only mode.
6. Through Code Mode, ask to list database tables. Confirm an approval prompt appears, inspect it, then allow only the intended read call.
7. Optionally verify `search_docs` separately. Never test by writing data or against production.

Code Mode documents these management commands and the OAuth troubleshooting path. Supabase recommends verifying connection/tool visibility and then making a natural-language database query. [Code Mode management](../../extensions/code-mode/README.md#management) [Supabase next steps](https://supabase.com/docs/guides/ai-tools/mcp#next-steps)

## Sources

Only primary sources were used:

1. [Supabase MCP Server documentation](https://supabase.com/docs/guides/ai-tools/mcp).
2. Official [`supabase/mcp` repository README at `302d2ad`](https://github.com/supabase/mcp/blob/302d2ad7870352444ca0d71711622ab38a66e4ff/README.md).
3. This setup's [Code Mode README](../../extensions/code-mode/README.md), [config types](../../extensions/code-mode/src/mcp/types.ts), and [strict parser](../../extensions/code-mode/src/mcp/config.ts).
4. Local files reviewed without copying secrets: `~/.pi/agent/code-mode.json`, `~/.pi/agent/code-mode-catalog.json`, and installed `pi-mcp-adapter` 2.21.1 README/config/source.
