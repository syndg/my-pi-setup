/**
 * MCP SDK v2 OAuthClientProvider for Code Mode.
 *
 * Substantially adapted from pi-mcp-adapter@2.21.1 (MIT),
 * mcp-oauth-provider.ts. Copyright (c) Nico Bailon and contributors.
 */
import {
  UnauthorizedError,
  type AddClientAuthentication,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  OAuthCredentialStore,
  identityForRecord,
  normalizeIssuer,
  type AuthEntry,
} from "./auth-store.ts";
import type { ServerRecord } from "./types.ts";

export const OAUTH_CALLBACK_HOST = "127.0.0.1";
export const OAUTH_CALLBACK_PATH = "/callback";
export const DEFAULT_OAUTH_CALLBACK_PORT = 19_876;

export type OAuthClientConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  clientName?: string;
  clientUri?: string;
  authorizationParams?: Record<string, string>;
  skipIssuerMetadataValidation?: boolean;
};

export type OAuthProviderOptions = {
  store?: OAuthCredentialStore;
  config?: OAuthClientConfig;
  redirectUrl?: string;
  /** Redirects are denied unless the caller is an explicit user auth flow. */
  allowRedirect?: boolean;
  initialState?: string;
  onRedirect?: (url: URL) => void | Promise<void>;
};

const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
]);

function withAuthorizationParams(
  url: URL,
  parameters?: Record<string, string>,
) {
  if (!parameters) return url;
  const result = new URL(url);
  for (const [name, value] of Object.entries(parameters)) {
    if (
      RESERVED_AUTHORIZATION_PARAMS.has(name) ||
      result.searchParams.has(name)
    ) {
      throw new Error(
        `OAuth authorizationParams.${name} cannot override a flow parameter`,
      );
    }
    result.searchParams.set(name, value);
  }
  return result;
}

function discoveredIssuer(state?: OAuthDiscoveryState) {
  const issuer =
    state?.authorizationServerMetadata?.issuer ?? state?.authorizationServerUrl;
  return issuer ? normalizeIssuer(issuer) : undefined;
}

function withoutTransient(
  entry: AuthEntry,
  property: "codeVerifier" | "state" | "discoveryState",
) {
  const next = structuredClone(entry);
  delete next[property];
  return next;
}

export class CodeModeOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthCredentialStore;
  private readonly config: OAuthClientConfig;
  private readonly redirectUrlSnapshot: string;
  private readonly record: ServerRecord;
  private readonly signal: AbortSignal;
  private readonly options: OAuthProviderOptions;
  private active = true;
  private issuer: string | undefined;
  private stateSnapshot: string | undefined;

  constructor(
    record: ServerRecord,
    signal: AbortSignal,
    options: OAuthProviderOptions = {},
  ) {
    if (record.config.transport !== "http" || record.config.oauth !== true) {
      throw new Error(`OAuth is not enabled for MCP server: ${record.name}`);
    }
    this.record = record;
    this.signal = signal;
    this.options = options;
    this.store = options.store ?? new OAuthCredentialStore();
    this.config = options.config ?? {};
    this.redirectUrlSnapshot =
      options.redirectUrl ??
      `http://${OAUTH_CALLBACK_HOST}:${DEFAULT_OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
    this.stateSnapshot = options.initialState;
  }

  private identity(issuer = this.issuer) {
    return identityForRecord(this.record, issuer);
  }

  private assertActive() {
    if (!this.active) throw new Error("OAuth provider is no longer active");
    this.signal.throwIfAborted();
  }

  private bindIssuer(
    ctx?: OAuthClientInformationContext,
    stampedIssuer?: string,
  ) {
    const next = ctx?.issuer ?? stampedIssuer;
    if (!next) return this.issuer;
    const normalized = normalizeIssuer(next);
    if (this.issuer && this.issuer !== normalized) {
      this.store.remove(this.identity());
      throw new Error(
        `OAuth issuer changed for MCP server: ${this.record.name}`,
      );
    }
    this.issuer = normalized;
    if (this.stateSnapshot) {
      this.store.write(this.identity(normalized), (entry) => ({
        ...entry,
        state: this.stateSnapshot,
      }));
    }
    return normalized;
  }

  private entry(ctx?: OAuthClientInformationContext) {
    this.bindIssuer(ctx);
    return this.store.read(this.identity());
  }

  deactivate() {
    this.active = false;
  }

  get redirectUrl() {
    return this.redirectUrlSnapshot;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrlSnapshot],
      client_name: this.config.clientName ?? "Pi Code Mode",
      ...(this.config.clientUri ? { client_uri: this.config.clientUri } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret
        ? "client_secret_post"
        : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  clientInformation(ctx?: OAuthClientInformationContext) {
    this.assertActive();
    const issuer = this.bindIssuer(ctx);
    const clientId = this.config.clientId;
    if (clientId) {
      const identity = this.identity(issuer);
      const entry = this.store.read(identity);
      if (
        issuer &&
        (entry?.configuredClientId !== clientId ||
          entry.clientInformation?.issuer !== issuer)
      ) {
        this.store.write(identity, (current) => ({
          ...current,
          configuredClientId: clientId,
          clientInformation: { client_id: clientId, issuer },
        }));
      }
      return {
        client_id: clientId,
        ...(this.config.clientSecret
          ? { client_secret: this.config.clientSecret }
          : {}),
        ...(issuer ? { issuer } : {}),
      } satisfies StoredOAuthClientInformation;
    }
    const entry = this.entry(ctx);
    if (entry?.configuredClientId) return undefined;
    const information = entry?.clientInformation;
    if (!information) return undefined;
    if (information.client_secret_expires_at) {
      if (information.client_secret_expires_at <= Date.now() / 1_000)
        return undefined;
    }
    return structuredClone(information);
  }

  saveClientInformation(
    information: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ) {
    this.assertActive();
    const issuer = this.bindIssuer(ctx, information.issuer);
    const stored = { ...information, ...(issuer ? { issuer } : {}) };
    const configuredClientId =
      this.config.clientId === information.client_id
        ? information.client_id
        : undefined;
    this.store.write(this.identity(issuer), (entry) => ({
      ...entry,
      clientInformation: stored,
      configuredClientId,
    }));
  }

  tokens(ctx?: OAuthClientInformationContext) {
    this.assertActive();
    const tokens = this.entry(ctx)?.tokens;
    if (!tokens) return undefined;
    const { expiresAt, ...stored } = tokens;
    return {
      ...structuredClone(stored),
      ...(expiresAt !== undefined
        ? {
            expires_in: Math.max(0, Math.floor(expiresAt - Date.now() / 1_000)),
          }
        : {}),
    };
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
    this.assertActive();
    const issuer = this.bindIssuer(ctx, tokens.issuer);
    const stored = {
      ...tokens,
      ...(issuer ? { issuer } : {}),
      ...(tokens.expires_in !== undefined
        ? { expiresAt: Date.now() / 1_000 + tokens.expires_in }
        : {}),
    };
    this.store.write(this.identity(issuer), (entry) => ({
      ...entry,
      tokens: stored,
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    this.assertActive();
    if (!this.options.allowRedirect || !this.options.onRedirect) {
      throw new UnauthorizedError(
        `Interactive authentication required for MCP server: ${this.record.name}`,
      );
    }
    const state = await this.state();
    if (!state) throw new UnauthorizedError("OAuth state is not available");
    await this.options.onRedirect(
      withAuthorizationParams(
        authorizationUrl,
        this.config.authorizationParams,
      ),
    );
  }

  saveCodeVerifier(codeVerifier: string) {
    this.assertActive();
    this.store.write(this.identity(), (entry) => ({ ...entry, codeVerifier }));
  }

  codeVerifier() {
    this.assertActive();
    const verifier = this.entry()?.codeVerifier;
    if (!verifier) {
      throw new Error(`No PKCE verifier for MCP server: ${this.record.name}`);
    }
    return verifier;
  }

  saveState(state: string) {
    this.assertActive();
    this.stateSnapshot = state;
    this.store.write(this.identity(), (entry) => ({ ...entry, state }));
  }

  state() {
    this.assertActive();
    const state = this.stateSnapshot ?? this.entry()?.state;
    if (!state) {
      throw new UnauthorizedError(
        `Interactive authentication required for MCP server: ${this.record.name}`,
      );
    }
    return state;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.assertActive();
    const issuer = this.bindIssuer(undefined, discoveredIssuer(state));
    this.store.write(this.identity(issuer), (entry) => ({
      ...entry,
      discoveryState: structuredClone(state),
    }));
  }

  discoveryState() {
    this.assertActive();
    const state = this.entry()?.discoveryState;
    if (state) this.bindIssuer(undefined, discoveredIssuer(state));
    return state ? structuredClone(state) : undefined;
  }

  clearTransientState() {
    this.stateSnapshot = undefined;
    for (const property of ["codeVerifier", "state"] as const) {
      const entry = this.store.read(this.identity());
      if (entry)
        this.store.replace(this.identity(), withoutTransient(entry, property));
    }
  }

  invalidateCredentials(
    kind: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    this.assertActive();
    if (kind === "all") {
      this.store.remove(this.identity());
      this.issuer = undefined;
      return;
    }
    const entry = this.store.read(this.identity());
    if (!entry) return;
    const next = structuredClone(entry);
    if (kind === "client") delete next.clientInformation;
    if (kind === "tokens") delete next.tokens;
    if (kind === "verifier") delete next.codeVerifier;
    if (kind === "discovery") delete next.discoveryState;
    this.store.replace(this.identity(), next);
  }

  addClientAuthentication: AddClientAuthentication = async (
    headers,
    parameters,
    _url,
    metadata,
  ) => {
    this.assertActive();
    if (
      parameters.get("grant_type") === "authorization_code" &&
      this.config.scope &&
      !parameters.has("scope")
    ) {
      parameters.set("scope", this.config.scope);
    }
    const information = await this.clientInformation();
    if (!information) return;
    const methods = metadata?.token_endpoint_auth_methods_supported ?? [];
    if (information.client_secret && methods.includes("client_secret_basic")) {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${information.client_id}:${information.client_secret}`).toString("base64")}`,
      );
      return;
    }
    if (!parameters.has("client_id")) {
      parameters.set("client_id", information.client_id);
    }
    if (information.client_secret && !parameters.has("client_secret")) {
      parameters.set("client_secret", information.client_secret);
    }
  };
}

export function createOAuthProvider(
  record: ServerRecord,
  signal: AbortSignal,
  options: OAuthProviderOptions = {},
) {
  if (record.config.transport !== "http" || record.config.oauth !== true) {
    return undefined;
  }
  return new CodeModeOAuthProvider(record, signal, {
    ...options,
    allowRedirect: options.allowRedirect === true,
  });
}
