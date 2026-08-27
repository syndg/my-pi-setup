/**
 * User-initiated OAuth orchestration for Code Mode.
 *
 * Substantially adapted from pi-mcp-adapter@2.21.1 (MIT),
 * mcp-auth-flow.ts. Copyright (c) Nico Bailon and contributors.
 */
import { randomBytes } from "node:crypto";
import {
  auth as sdkAuth,
  UnauthorizedError,
  type AuthOptions,
  type AuthResult,
  type FetchLike,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import open from "open";
import {
  createBoundedFetch,
  MAX_OAUTH_HTTP_RESPONSE_BYTES,
} from "./bounded-fetch.ts";
import {
  OAuthCredentialStore,
  identityForRecord,
  normalizeServerUrl,
} from "./auth-store.ts";
import {
  OAuthCallbackServer,
  getSharedCallbackServer,
  type OAuthCallbackResult,
} from "./callback-server.ts";
import {
  CodeModeOAuthProvider,
  type OAuthClientConfig,
  type OAuthProviderOptions,
} from "./oauth-provider.ts";
import type { ServerRecord } from "./types.ts";

export type AuthStatus = "authenticated" | "expired" | "not_authenticated";

type RunAuth = (
  provider: CodeModeOAuthProvider,
  options: AuthOptions,
) => Promise<AuthResult>;

export type AuthenticateServerOptions = {
  store?: OAuthCredentialStore;
  provider?: Omit<
    OAuthProviderOptions,
    "store" | "allowRedirect" | "initialState" | "onRedirect" | "redirectUrl"
  >;
  config?: OAuthClientConfig;
  callbackServer?: OAuthCallbackServer;
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
  /** Set false in headless callers after presenting onAuthorizationUrl. */
  openBrowser?: boolean;
  browserOpener?: (authorizationUrl: string) => void | Promise<void>;
  runAuth?: RunAuth;
  fetchFn?: FetchLike;
  resourceMetadataUrl?: URL;
  scope?: string;
  skipIssuerMetadataValidation?: boolean;
};

export type RefreshServerOptions = Omit<
  AuthenticateServerOptions,
  "callbackServer" | "onAuthorizationUrl" | "openBrowser" | "browserOpener"
>;

type InFlightOperation = {
  kind: "authenticate" | "refresh";
  promise: Promise<unknown>;
};

const inFlight = new Map<string, InFlightOperation>();
const activeControllers = new Map<string, AbortController>();
const callbackServers = new Set<OAuthCallbackServer>();

function operationKey(record: ServerRecord) {
  if (record.config.transport !== "http") {
    throw new Error(
      `OAuth is only supported for HTTP MCP servers: ${record.name}`,
    );
  }
  return JSON.stringify([
    record.scope,
    record.name,
    normalizeServerUrl(record.config.url),
  ]);
}

function assertOAuthRecord(record: ServerRecord) {
  if (!record.enabled)
    throw new Error(`MCP server is disabled: ${record.name}`);
  if (record.config.transport !== "http" || record.config.oauth !== true) {
    throw new Error(`OAuth is not enabled for MCP server: ${record.name}`);
  }
}

function combinedSignal(...signals: Array<AbortSignal | undefined>) {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  return AbortSignal.any(present);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("OAuth operation cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function singleFlight<T>(
  key: string,
  kind: InFlightOperation["kind"],
  operation: () => Promise<T>,
  signal: AbortSignal,
) {
  const existing = inFlight.get(key);
  if (existing) {
    if (existing.kind === kind) {
      return abortable(existing.promise as Promise<T>, signal);
    }
    await abortable(
      existing.promise.catch(() => undefined),
      signal,
    );
    return singleFlight(key, kind, operation, signal);
  }
  const promise = operation();
  inFlight.set(key, { kind, promise });
  try {
    return await promise;
  } finally {
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
  }
}

function cancellableFetch(fetchFn: FetchLike, signal: AbortSignal): FetchLike {
  return (url, init) => {
    const requestSignal = init?.signal;
    const effectiveSignal = requestSignal
      ? AbortSignal.any([requestSignal, signal])
      : signal;
    return fetchFn(url, { ...init, signal: effectiveSignal });
  };
}

function authOptions(
  record: ServerRecord,
  options: AuthenticateServerOptions,
  signal: AbortSignal,
): AuthOptions {
  if (record.config.transport !== "http")
    throw new Error("HTTP server required");
  return {
    serverUrl: record.config.url,
    fetchFn: cancellableFetch(
      createBoundedFetch(
        MAX_OAUTH_HTTP_RESPONSE_BYTES,
        options.fetchFn ?? fetch,
      ),
      signal,
    ),
    ...(options.resourceMetadataUrl
      ? { resourceMetadataUrl: options.resourceMetadataUrl }
      : {}),
    ...((options.scope ?? options.config?.scope)
      ? { scope: options.scope ?? options.config?.scope }
      : {}),
    ...((options.skipIssuerMetadataValidation ??
    options.config?.skipIssuerMetadataValidation)
      ? { skipIssuerMetadataValidation: true }
      : {}),
  };
}

function callbackCompletionOptions(
  record: ServerRecord,
  options: AuthenticateServerOptions,
  callback: OAuthCallbackResult,
  signal: AbortSignal,
): AuthOptions {
  return {
    ...authOptions(record, options, signal),
    authorizationCode: callback.code,
    ...(callback.iss ? { iss: callback.iss } : {}),
  };
}

function createFlowProvider(
  record: ServerRecord,
  signal: AbortSignal,
  store: OAuthCredentialStore,
  options: AuthenticateServerOptions,
  callbackUrl: string,
  state: string,
  onRedirect: (url: URL) => void,
) {
  return new CodeModeOAuthProvider(record, signal, {
    ...options.provider,
    store,
    config: options.config ?? options.provider?.config,
    redirectUrl: callbackUrl,
    allowRedirect: true,
    initialState: state,
    onRedirect,
  });
}

/** Explicit user action: may present and open a browser authorization URL. */
export function authenticateServer(
  record: ServerRecord,
  signal: AbortSignal,
  options: AuthenticateServerOptions = {},
) {
  assertOAuthRecord(record);
  const key = operationKey(record);
  return singleFlight(
    key,
    "authenticate",
    async () => {
      const controller = new AbortController();
      activeControllers.set(key, controller);
      const effectiveSignal = combinedSignal(signal, controller.signal);
      const store = options.store ?? new OAuthCredentialStore();
      const callbackServer =
        options.callbackServer ?? getSharedCallbackServer();
      callbackServers.add(callbackServer);
      const state = randomBytes(32).toString("base64url");
      let provider: CodeModeOAuthProvider | undefined;
      let reservation: Promise<string> | undefined;

      try {
        effectiveSignal?.throwIfAborted();
        if (!effectiveSignal) {
          throw new Error("OAuth authentication requires a signal");
        }
        reservation = callbackServer.reserve(state);
        const callbackUrl = await abortable(reservation, effectiveSignal);
        effectiveSignal.throwIfAborted();
        let authorizationUrl: string | undefined;
        provider = createFlowProvider(
          record,
          effectiveSignal,
          store,
          options,
          callbackUrl,
          state,
          (url) => {
            authorizationUrl = url.toString();
          },
        );
        const runAuth = options.runAuth ?? sdkAuth;
        const started = await abortable(
          runAuth(provider, authOptions(record, options, effectiveSignal)),
          effectiveSignal,
        );
        if (started === "AUTHORIZED") return "authenticated" as const;
        if (!authorizationUrl) {
          throw new UnauthorizedError(
            "OAuth authorization URL was not provided",
          );
        }

        // Wait before handing the URL to the browser, closing the callback race.
        const callbackPromise = callbackServer.wait(state, effectiveSignal);
        void callbackPromise.catch(() => undefined);
        await abortable(
          Promise.resolve(options.onAuthorizationUrl?.(authorizationUrl)),
          effectiveSignal,
        );
        if (options.openBrowser !== false) {
          const opener = options.browserOpener ?? ((url: string) => open(url));
          try {
            await abortable(
              Promise.resolve(opener(authorizationUrl)),
              effectiveSignal,
            );
          } catch (error) {
            effectiveSignal.throwIfAborted();
            if (!options.onAuthorizationUrl) throw error;
          }
        }
        const callback = await abortable(callbackPromise, effectiveSignal);
        const completed = await abortable(
          runAuth(
            provider,
            callbackCompletionOptions(
              record,
              options,
              callback,
              effectiveSignal,
            ),
          ),
          effectiveSignal,
        );
        if (completed !== "AUTHORIZED") {
          throw new UnauthorizedError(
            `OAuth failed for MCP server: ${record.name}`,
          );
        }
        return "authenticated" as const;
      } finally {
        if (reservation) await reservation.catch(() => undefined);
        callbackServer.cancel(state);
        try {
          provider?.clearTransientState();
        } finally {
          provider?.deactivate();
          if (activeControllers.get(key) === controller) {
            activeControllers.delete(key);
          }
        }
      }
    },
    signal,
  );
}

/** Non-interactive refresh path. Its provider cannot open a browser. */
export function refreshServer(
  record: ServerRecord,
  signal: AbortSignal,
  options: RefreshServerOptions = {},
) {
  assertOAuthRecord(record);
  const key = operationKey(record);
  return singleFlight(
    key,
    "refresh",
    async () => {
      const controller = new AbortController();
      activeControllers.set(key, controller);
      const effectiveSignal = combinedSignal(signal, controller.signal);
      effectiveSignal?.throwIfAborted();
      if (!effectiveSignal) throw new Error("OAuth refresh requires a signal");
      const store = options.store ?? new OAuthCredentialStore();
      const provider = new CodeModeOAuthProvider(record, effectiveSignal, {
        ...options.provider,
        store,
        config: options.config ?? options.provider?.config,
        allowRedirect: false,
      });
      try {
        const result = await abortable(
          (options.runAuth ?? sdkAuth)(
            provider,
            authOptions(record, options, effectiveSignal),
          ),
          effectiveSignal,
        );
        if (result !== "AUTHORIZED") return undefined;
        return provider.tokens();
      } catch (error) {
        if (error instanceof UnauthorizedError) return undefined;
        throw error;
      } finally {
        provider.deactivate();
        if (activeControllers.get(key) === controller)
          activeControllers.delete(key);
      }
    },
    signal,
  );
}

export function getAuthStatus(
  record: ServerRecord,
  options: Pick<AuthenticateServerOptions, "store"> = {},
): AuthStatus {
  if (record.config.transport !== "http") return "not_authenticated";
  const store = options.store ?? new OAuthCredentialStore();
  const tokens = store.read(identityForRecord(record))?.tokens;
  if (!tokens) return "not_authenticated";
  if (
    tokens.expiresAt !== undefined &&
    tokens.expiresAt <= Date.now() / 1_000
  ) {
    return "expired";
  }
  return "authenticated";
}

export function getStoredTokens(
  record: ServerRecord,
  options: Pick<AuthenticateServerOptions, "store"> = {},
): StoredOAuthTokens | undefined {
  if (record.config.transport !== "http") return undefined;
  const tokens = (options.store ?? new OAuthCredentialStore()).read(
    identityForRecord(record),
  )?.tokens;
  if (!tokens) return undefined;
  const { expiresAt, ...stored } = tokens;
  return {
    ...structuredClone(stored),
    ...(expiresAt !== undefined
      ? { expires_in: Math.max(0, Math.floor(expiresAt - Date.now() / 1_000)) }
      : {}),
  };
}

export function logoutServer(
  record: ServerRecord,
  options: Pick<AuthenticateServerOptions, "store"> = {},
) {
  const key = operationKey(record);
  activeControllers
    .get(key)
    ?.abort(new Error(`Logged out MCP server: ${record.name}`));
  (options.store ?? new OAuthCredentialStore()).remove(
    identityForRecord(record),
  );
}

export async function closeOAuthFlows() {
  for (const controller of activeControllers.values()) {
    controller.abort(new Error("OAuth flows closed"));
  }
  activeControllers.clear();
  await Promise.all([...callbackServers].map((server) => server.close()));
  callbackServers.clear();
}
