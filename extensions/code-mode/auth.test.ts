import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  AuthOptions,
  AuthResult,
  AuthorizationServerMetadata,
} from "@modelcontextprotocol/client";
import {
  LockedFileAuthSecretStore,
  MemoryAuthSecretStore,
  OAuthCredentialStore,
  identityForRecord,
} from "./src/mcp/auth-store.ts";
import { OAuthCallbackServer } from "./src/mcp/callback-server.ts";
import {
  authenticateServer,
  closeOAuthFlows,
  logoutServer,
  refreshServer,
} from "./src/mcp/oauth-flow.ts";
import {
  CodeModeOAuthProvider,
  createOAuthProvider,
} from "./src/mcp/oauth-provider.ts";
import type { ServerRecord } from "./src/mcp/types.ts";

function record(
  name = "example",
  url = "https://mcp.example.test/api",
  scope: "global" | "project" = "global",
): ServerRecord {
  return {
    name,
    scope,
    enabled: true,
    config: { transport: "http", url, oauth: true },
  };
}

function memoryStore() {
  const secrets = new MemoryAuthSecretStore();
  return { secrets, store: new OAuthCredentialStore({ secretStore: secrets }) };
}

function authorizationServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: "https://issuer.example",
    authorization_endpoint: "https://issuer.example/authorize",
    token_endpoint: "https://issuer.example/token",
    jwks_uri: "https://issuer.example/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

const temporaryDirectories: string[] = [];

after(async () => {
  await closeOAuthFlows();
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
});

describe("OAuth credential storage", () => {
  it("binds entries to scope, server name, normalized URL, and issuer", () => {
    const { store } = memoryStore();
    const global = record(
      "same",
      "https://MCP.EXAMPLE.test:443/api#fragment",
      "global",
    );
    const project = record("same", "https://mcp.example.test/api", "project");
    const identity = identityForRecord(global, "https://AUTH.example.test/");

    store.write(identity, (entry) => ({
      ...entry,
      tokens: { access_token: "global-token", token_type: "Bearer" },
    }));

    assert.equal(
      store.read(identityForRecord(global, "https://auth.example.test"))?.tokens
        ?.access_token,
      "global-token",
    );
    assert.equal(
      store.read(identityForRecord(project, "https://auth.example.test")),
      undefined,
    );
    assert.equal(
      store.read(
        identityForRecord(
          record("same", "https://mcp.example.test/other", "global"),
          "https://auth.example.test",
        ),
      ),
      undefined,
    );
    assert.equal(store.read(identity), undefined);
  });

  it("fails closed and invalidates credentials when the issuer changes", () => {
    const { store } = memoryStore();
    const server = record();
    store.write(
      identityForRecord(server, "https://issuer-a.example"),
      (entry) => ({
        ...entry,
        tokens: { access_token: "secret", token_type: "Bearer" },
      }),
    );

    assert.equal(
      store.read(identityForRecord(server, "https://issuer-b.example")),
      undefined,
    );
    assert.equal(store.read(identityForRecord(server)), undefined);
  });

  it("persists tokens, client registration, PKCE verifier, state, and discovery", () => {
    const { store } = memoryStore();
    const identity = identityForRecord(record(), "https://issuer.example");
    store.write(identity, (entry) => ({
      ...entry,
      tokens: {
        access_token: "token",
        token_type: "Bearer",
        issuer: identity.issuer,
      },
      clientInformation: {
        client_id: "dynamic-client",
        issuer: identity.issuer,
      },
      codeVerifier: "verifier",
      state: "state",
      discoveryState: {
        authorizationServerUrl: "https://issuer.example",
        authorizationServerMetadata: authorizationServerMetadata(),
      },
    }));

    const restored = store.read(identity);
    assert.equal(restored?.tokens?.access_token, "token");
    assert.equal(restored?.clientInformation?.client_id, "dynamic-client");
    assert.equal(restored?.codeVerifier, "verifier");
    assert.equal(restored?.state, "state");
    assert.equal(
      restored?.discoveryState?.authorizationServerUrl,
      "https://issuer.example",
    );
  });

  it("migrates URL-bound legacy plaintext credentials into the selected store", () => {
    const legacyRoot = join(
      tmpdir(),
      `pi-code-mode-legacy-${randomBytes(6).toString("hex")}`,
    );
    temporaryDirectories.push(legacyRoot);
    const server = record("legacy", "https://mcp.example.test/api");
    const directory = join(
      legacyRoot,
      `sha256-${createHash("sha256").update(server.name).digest("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "tokens.json"),
      JSON.stringify({
        serverUrl: "https://mcp.example.test/api",
        tokens: {
          accessToken: "legacy-token",
          refreshToken: "legacy-refresh",
          expiresAt: Date.now() / 1_000 + 3600,
          issuer: "https://issuer.example",
        },
      }),
    );
    const secrets = new MemoryAuthSecretStore();
    const store = new OAuthCredentialStore({
      secretStore: secrets,
      legacyDirectory: legacyRoot,
    });

    const migrated = store.read(identityForRecord(server));
    assert.equal(migrated?.tokens?.access_token, "legacy-token");
    assert.equal(migrated?.tokens?.refresh_token, "legacy-refresh");
    assert.equal(existsSync(directory), false);
    assert.ok(secrets.entries.size > 0);
  });

  it("uses an atomic 0600 locked-file fallback", () => {
    const directory = join(
      tmpdir(),
      `pi-code-mode-auth-${randomBytes(6).toString("hex")}`,
    );
    temporaryDirectories.push(directory);
    const fallback = new LockedFileAuthSecretStore(directory);
    fallback.write("account", "secret");

    const files = readdirSync(directory);
    assert.deepEqual(files, ["account.json"]);
    assert.equal(statSync(join(directory, "account.json")).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(fallback.read("account"), "secret");
    fallback.remove("account");
    assert.equal(existsSync(join(directory, "account.json")), false);
  });
});

describe("OAuth provider", () => {
  it("prohibits redirects for normal HTTP calls by default", async () => {
    const { store } = memoryStore();
    const controller = new AbortController();
    const provider = createOAuthProvider(record(), controller.signal, {
      store,
    });
    assert.ok(provider instanceof CodeModeOAuthProvider);
    await provider.saveState("state");
    await assert.rejects(
      provider.redirectToAuthorization(
        new URL("https://issuer.example/authorize"),
      ),
      /Interactive authentication required/,
    );
  });

  it("restores dynamic registration and redirect-round-trip state", async () => {
    const { store } = memoryStore();
    const server = record();
    const controller = new AbortController();
    const first = new CodeModeOAuthProvider(server, controller.signal, {
      store,
      allowRedirect: true,
      initialState: "csrf-state",
      onRedirect: () => undefined,
    });
    await first.saveDiscoveryState({
      authorizationServerUrl: "https://issuer.example",
      authorizationServerMetadata: authorizationServerMetadata(),
    });
    await first.saveClientInformation(
      { client_id: "dynamic", issuer: "https://issuer.example" },
      { issuer: "https://issuer.example" },
    );
    await first.saveCodeVerifier("pkce-verifier");

    const restored = new CodeModeOAuthProvider(server, controller.signal, {
      store,
    });
    assert.equal((await restored.clientInformation())?.client_id, "dynamic");
    assert.equal(await restored.codeVerifier(), "pkce-verifier");
    assert.equal(await restored.state(), "csrf-state");
    assert.equal(
      (await restored.discoveryState())?.authorizationServerMetadata?.issuer,
      "https://issuer.example",
    );
  });

  it("keeps fresh authorization state when cached discovery binds an issuer", () => {
    const { store } = memoryStore();
    const server = record("supabase", "https://mcp.supabase.com/mcp");
    const controller = new AbortController();
    const cached = new CodeModeOAuthProvider(server, controller.signal, {
      store,
    });
    cached.saveDiscoveryState({
      authorizationServerUrl: "https://api.supabase.com",
      authorizationServerMetadata: {
        ...authorizationServerMetadata(),
        issuer: "https://api.supabase.com",
      },
    });
    cached.deactivate();

    const authenticating = new CodeModeOAuthProvider(
      server,
      controller.signal,
      {
        store,
        allowRedirect: true,
        initialState: "fresh-csrf-state",
        onRedirect: () => undefined,
      },
    );
    assert.equal(authenticating.state(), "fresh-csrf-state");
    assert.equal(
      authenticating.discoveryState()?.authorizationServerMetadata?.issuer,
      "https://api.supabase.com",
    );
    assert.equal(authenticating.state(), "fresh-csrf-state");
    authenticating.clearTransientState();
    authenticating.deactivate();
  });
});

describe("loopback callback server", () => {
  it("validates state and carries the RFC 9207 iss parameter", async () => {
    const callback = new OAuthCallbackServer({ port: 0, timeoutMs: 2_000 });
    const state = "expected-state";
    await callback.reserve(state);
    const waiting = callback.wait(state);

    const invalid = await fetch(
      `${callback.callbackUrl}?code=nope&state=wrong`,
    );
    assert.equal(invalid.status, 400);
    const issuer = "https://issuer.example";
    const valid = await fetch(
      `${callback.callbackUrl}?code=code-123&state=${state}&iss=${encodeURIComponent(issuer)}`,
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(await waiting, { code: "code-123", iss: issuer });
    await callback.close();
  });

  it("cancels and cleans up a pending callback", async () => {
    const callback = new OAuthCallbackServer({ port: 0, timeoutMs: 2_000 });
    await callback.reserve("cancel-state");
    const waiting = callback.wait("cancel-state");
    callback.cancel("cancel-state");
    await assert.rejects(waiting, /cancelled/);
    assert.equal(callback.pendingCount, 0);
    await callback.close();
  });
});

describe("auth flow", () => {
  it("authenticates once per identity without a real browser or OAuth network", async () => {
    const { store } = memoryStore();
    const server = record("flow");
    const callback = new OAuthCallbackServer({ port: 0, timeoutMs: 2_000 });
    let starts = 0;
    let completions = 0;
    const runAuth = async (
      provider: CodeModeOAuthProvider,
      options: AuthOptions,
    ): Promise<AuthResult> => {
      if (options.authorizationCode === undefined) {
        starts += 1;
        await provider.saveDiscoveryState({
          authorizationServerUrl: "https://issuer.example",
          authorizationServerMetadata: authorizationServerMetadata(),
        });
        await provider.saveClientInformation(
          { client_id: "registered", issuer: "https://issuer.example" },
          { issuer: "https://issuer.example" },
        );
        await provider.saveCodeVerifier("pkce");
        const state = await provider.state();
        await provider.redirectToAuthorization(
          new URL(`https://issuer.example/authorize?state=${state}`),
        );
        return "REDIRECT";
      }
      completions += 1;
      assert.equal(options.iss, "https://issuer.example");
      assert.equal(await provider.codeVerifier(), "pkce");
      await provider.saveTokens(
        {
          access_token: "authorized-token",
          token_type: "Bearer",
          issuer: "https://issuer.example",
        },
        { issuer: "https://issuer.example" },
      );
      return "AUTHORIZED";
    };
    const controller = new AbortController();
    const options = {
      store,
      callbackServer: callback,
      openBrowser: false,
      runAuth,
      onAuthorizationUrl: async (authorizationUrl: string) => {
        const url = new URL(authorizationUrl);
        const state = url.searchParams.get("state");
        assert.ok(state);
        await fetch(
          `${callback.callbackUrl}?code=callback-code&state=${state}&iss=${encodeURIComponent("https://issuer.example")}`,
        );
      },
    };

    const [first, second] = await Promise.all([
      authenticateServer(server, controller.signal, options),
      authenticateServer(server, controller.signal, options),
    ]);
    assert.equal(first, "authenticated");
    assert.equal(second, "authenticated");
    assert.equal(starts, 1);
    assert.equal(completions, 1);
    assert.equal(
      store.read(identityForRecord(server))?.tokens?.access_token,
      "authorized-token",
    );
    assert.equal(
      store.read(identityForRecord(server))?.codeVerifier,
      undefined,
    );
    assert.equal(store.read(identityForRecord(server))?.state, undefined);
    await callback.close();
  });

  it("single-flights refresh and logs out only the selected scoped identity", async () => {
    const { store } = memoryStore();
    const server = record("refresh", "https://mcp.example.test/api", "project");
    const otherScope = record(
      "refresh",
      "https://mcp.example.test/api",
      "global",
    );
    store.write(
      identityForRecord(server, "https://issuer.example"),
      (entry) => ({
        ...entry,
        tokens: {
          access_token: "old",
          refresh_token: "refresh",
          token_type: "Bearer",
          issuer: "https://issuer.example",
        },
        discoveryState: {
          authorizationServerUrl: "https://issuer.example",
          authorizationServerMetadata: authorizationServerMetadata(),
        },
      }),
    );
    store.write(identityForRecord(otherScope), (entry) => ({
      ...entry,
      tokens: { access_token: "other", token_type: "Bearer" },
    }));
    let refreshes = 0;
    const runAuth = async (provider: CodeModeOAuthProvider) => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await provider.saveTokens({
        access_token: "fresh",
        token_type: "Bearer",
        issuer: "https://issuer.example",
      });
      return "AUTHORIZED" as const;
    };
    const controller = new AbortController();
    const [first, second] = await Promise.all([
      refreshServer(server, controller.signal, { store, runAuth }),
      refreshServer(server, controller.signal, { store, runAuth }),
    ]);
    assert.equal(first?.access_token, "fresh");
    assert.equal(second?.access_token, "fresh");
    assert.equal(refreshes, 1);

    logoutServer(server, { store });
    assert.equal(store.read(identityForRecord(server)), undefined);
    assert.equal(
      store.read(identityForRecord(otherScope))?.tokens?.access_token,
      "other",
    );
  });
});
