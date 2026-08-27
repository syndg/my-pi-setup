# GitHub and Trigger.dev MCP installation/authentication

**Checked:** 2026-08-08 against the current default branches: GitHub MCP Server `eb4c099e05ef622445e930b18682a0464f22418f`; Trigger.dev `c526528d8f54dce67b5b723a34f28d7512571fd8`.

## Recommendation

- **GitHub:** use GitHub's hosted remote server at `https://api.githubcopilot.com/mcp/` over remote HTTP (`type: "http"`; the GitHub UI describes the client transport choice as “HTTP/SSE”). Prefer OAuth **only when the MCP client has a GitHub App or OAuth App configured for this integration**; otherwise send a GitHub PAT as `Authorization: Bearer …`. No local runtime is needed. [GitHub remote-server docs](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/remote-server.md) [GitHub installation docs](https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-mcp)
- **Trigger.dev:** there is no officially documented hosted/Streamable HTTP MCP endpoint. Use the official local **stdio** server, `npx trigger.dev@latest mcp`. Its browser login is Trigger CLI authentication, not MCP transport OAuth. Therefore a client that supports only Streamable HTTP cannot use the official Trigger.dev server directly; it must also support spawning stdio servers (or use a separately operated bridge, which Trigger.dev does not document as its official setup). [Trigger.dev MCP docs](https://trigger.dev/docs/mcp-introduction) [server transport source](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/commands/mcp.ts)

## 1. GitHub official MCP server

### Hosted installation

Generic configuration (adapt the outer keys to the client):

```json
{
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/"
  }
}
```

The URL, hosted status, and `type: "http"` configuration are explicit in GitHub's official README and remote-server guide. The endpoint's unauthenticated response advertises MCP protected-resource metadata at `https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/`. [README](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md#remote-github-mcp-server) [remote guide](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/remote-server.md) [OAuth protected-resource metadata](https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/)

Useful restrictions are available in the URL: `https://api.githubcopilot.com/mcp/readonly` exposes the default tools read-only, while `/mcp/x/{toolset}` selects one toolset and `/mcp/x/all` exposes all tools. Multiple toolsets require the `X-MCP-Toolsets` header. [remote guide](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/remote-server.md#url-path-parameters)

### OAuth

OAuth is officially supported, but it is **not zero-configuration for an arbitrary generic client**. GitHub states that each MCP host must configure a GitHub App or OAuth App to support remote OAuth. In a host with that integration, add the URL without an auth header, invoke the client's authenticate action, complete the GitHub browser consent, and let the client store/use the resulting bearer token. [GitHub README caveat](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md#remote-github-mcp-server) [GitHub browser-auth steps](https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-mcp#remote-server-configuration-example-with-oauth)

The endpoint's current official resource metadata names `https://github.com/login/oauth` as its authorization server and advertises these scopes: `repo`, `read:org`, `read:user`, `user:email`, `read:packages`, `write:packages`, `read:project`, `project`, `gist`, `notifications`, `workflow`, and `codespace`. Request only what the desired tools need; individual tool entries in the server README identify required scopes (for example, repository operations commonly require `repo`, teams require `read:org`, gists require `gist`, and notifications require `notifications`). [resource metadata](https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/) [tool scope reference](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md#tools)

**Limitation:** standard MCP OAuth capability alone does not guarantee success: the host-specific GitHub App/OAuth App requirement remains. A generic client without such registration should use PAT authentication rather than assuming dynamic client registration will work.

### PAT fallback

```json
{
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {
      "Authorization": "Bearer ${GITHUB_PAT}"
    }
  }
}
```

Any remote-capable host should support PAT auth. Permissions are feature-dependent; GitHub recommends minimum necessary permissions and gives `repo` for repository operations and `read:org` for organization/team access. Additional tools declare additional scopes in the README. A PAT may also be subject to organization SSO/policy approval. [PAT configuration and host limitation](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md#remote-github-mcp-server) [GitHub PAT docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

No environment variable is required by the hosted server itself; `${GITHUB_PAT}` above is a client-side secret convention. The required wire format is the `Authorization: Bearer` header.

### Official local fallback

If remote HTTP is unavailable, GitHub's official local server uses **stdio**:

```bash
docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN \
  ghcr.io/github/github-mcp-server
```

Set `GITHUB_PERSONAL_ACCESS_TOKEN` to the PAT. Official builds can instead perform browser OAuth with no token on github.com; the Docker OAuth setup additionally publishes a loopback callback port and sets `GITHUB_OAUTH_CALLBACK_PORT` (the official example uses `8085`). A static PAT takes precedence. [local server instructions](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md#local-github-mcp-server) [local OAuth details](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/oauth-login.md)

## 2. Trigger.dev official MCP server

### Installation and transport

Generic stdio configuration:

```json
{
  "trigger": {
    "command": "npx",
    "args": ["trigger.dev@latest", "mcp"]
  }
}
```

The optional installer is:

```bash
npx trigger.dev@latest install-mcp
```

Trigger.dev documents only this local command across supported clients. The implementation constructs `StdioServerTransport`; no HTTP/SSE/Streamable HTTP transport or hosted MCP URL is exposed in the official docs or server command. Node/npm access is therefore required, and first-run `npx` download can require a longer startup timeout (Trigger.dev recommends 30 seconds for Codex). [MCP installation docs](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/docs/mcp-introduction.mdx) [stdio implementation](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/commands/mcp.ts#L101-L113)

### Authentication

- `search_docs` works anonymously. All other tools require a Trigger.dev CLI login. On first authenticated use, the server opens a browser authorization-code page, polls for a Trigger.dev personal access token, and writes it to the selected CLI auth profile. This is an application-level CLI login inside the stdio server—not OAuth negotiated by the MCP client. [auth docs](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/docs/mcp-introduction.mdx#authentication) [auth implementation](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/mcp/auth.ts)
- To authenticate before starting MCP, run `npx trigger.dev@latest login`. [CLI login docs](https://trigger.dev/docs/cli-login-commands)
- For non-interactive configuration, set `TRIGGER_ACCESS_TOKEN` to a Trigger.dev **personal access token** beginning `tr_pat_`; create one at `https://cloud.trigger.dev/account/tokens`. `TRIGGER_API_URL` optionally overrides the API base (default `https://api.trigger.dev`) for self-hosted/custom deployments. [auth environment handling](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/mcp/auth.ts#L27-L45) [official API constants](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/consts.ts)

Trigger.dev does not document user-selectable OAuth/PAT scopes for this MCP credential; the code requires a personal access token and obtains tool-specific project JWTs internally. Treat the PAT as account-sensitive and use `--readonly` to hide write tools (`deploy`, `trigger_task`, `cancel_run`), plus `--project-ref` and/or `--dev-only` to reduce reach. [CLI options](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/docs/mcp-introduction.mdx#authentication)

## Sources

Only first-party sources were used:

1. [GitHub `github/github-mcp-server` README](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/README.md), [remote-server guide](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/remote-server.md), and [local OAuth guide](https://github.com/github/github-mcp-server/blob/eb4c099e05ef622445e930b18682a0464f22418f/docs/oauth-login.md).
2. [GitHub Docs: Extending GitHub Copilot Chat with MCP](https://docs.github.com/en/copilot/customizing-copilot/extending-copilot-chat-with-mcp) and the live [GitHub MCP OAuth protected-resource metadata](https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/).
3. [Trigger.dev MCP documentation](https://trigger.dev/docs/mcp-introduction), [CLI login documentation](https://trigger.dev/docs/cli-login-commands), and current first-party [MCP command](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/commands/mcp.ts) / [authentication source](https://github.com/triggerdotdev/trigger.dev/blob/c526528d8f54dce67b5b723a34f28d7512571fd8/packages/cli-v3/src/mcp/auth.ts).
