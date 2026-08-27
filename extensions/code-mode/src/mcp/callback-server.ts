/**
 * Fixed-loopback OAuth callback listener.
 *
 * Substantially adapted from pi-mcp-adapter@2.21.1 (MIT),
 * mcp-callback-server.ts. Copyright (c) Nico Bailon and contributors.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DEFAULT_OAUTH_CALLBACK_PORT,
  OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH,
} from "./oauth-provider.ts";

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Authorization complete</title></head><body><h1>Authorization complete</h1><p>You can close this window and return to Pi.</p></body></html>`;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorHtml(message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization failed</title></head><body><h1>Authorization failed</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export type OAuthCallbackResult = {
  code: string;
  /** RFC 9207 authorization-response issuer. */
  iss?: string;
};

type PendingCallback = {
  result?: OAuthCallbackResult;
  error?: Error;
  resolve?: (result: OAuthCallbackResult) => void;
  reject?: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

export type OAuthCallbackServerOptions = {
  /** Port zero is supported for isolated tests; production uses the fixed default. */
  port?: number;
  timeoutMs?: number;
};

export class OAuthCallbackServer {
  private server: Server | undefined;
  private binding: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingCallback>();
  private boundPort: number | undefined;
  private readonly requestedPort: number;
  private readonly timeoutMs: number;

  constructor(options: OAuthCallbackServerOptions = {}) {
    this.requestedPort = options.port ?? DEFAULT_OAUTH_CALLBACK_PORT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  }

  get callbackUrl() {
    if (this.boundPort === undefined)
      throw new Error("OAuth callback server is not running");
    return `http://${OAUTH_CALLBACK_HOST}:${this.boundPort}${OAUTH_CALLBACK_PATH}`;
  }

  private respond(response: ServerResponse, status: number, html: string) {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    response.end(html);
  }

  private handle = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      this.respond(response, 405, errorHtml("Method not allowed"));
      return;
    }
    const url = new URL(request.url ?? "/", `http://${OAUTH_CALLBACK_HOST}`);
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      this.respond(response, 404, errorHtml("Not found"));
      return;
    }
    const state = url.searchParams.get("state");
    if (!state) {
      this.respond(response, 400, errorHtml("Missing OAuth state"));
      return;
    }
    const pending = this.pending.get(state);
    if (!pending) {
      this.respond(response, 400, errorHtml("Invalid or expired OAuth state"));
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError) {
      const description = url.searchParams.get("error_description");
      const error = new Error(
        description ? `${providerError}: ${description}` : providerError,
      );
      this.respond(response, 200, errorHtml(error.message));
      this.settleError(state, pending, error);
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      this.respond(response, 400, errorHtml("Missing authorization code"));
      return;
    }
    const iss = url.searchParams.get("iss");
    const result = { code, ...(iss ? { iss } : {}) };
    this.respond(response, 200, SUCCESS_HTML);
    this.settleResult(state, pending, result);
  };

  private settleResult(
    state: string,
    pending: PendingCallback,
    result: OAuthCallbackResult,
  ) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abort?.();
    if (pending.resolve) {
      this.pending.delete(state);
      pending.resolve(result);
    } else {
      pending.result = result;
    }
  }

  private settleError(state: string, pending: PendingCallback, error: Error) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abort?.();
    if (pending.reject) {
      this.pending.delete(state);
      pending.reject(error);
    } else {
      pending.error = error;
    }
  }

  private async ensureListening() {
    if (this.closing) throw new Error("OAuth callback server is closing");
    if (this.server) return;
    if (this.binding) return this.binding;
    const candidate = createServer(this.handle);
    const operation = new Promise<void>((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(this.requestedPort, OAUTH_CALLBACK_HOST, () => {
        candidate.removeListener("error", reject);
        const address = candidate.address();
        if (!address || typeof address === "string") {
          reject(new Error("OAuth callback server did not report a port"));
          return;
        }
        this.boundPort = address.port;
        this.server = candidate;
        candidate.unref();
        resolve();
      });
    });
    this.binding = operation;
    try {
      await operation;
    } catch (error) {
      candidate.close();
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "EADDRINUSE") {
        throw new Error(
          `OAuth callback port ${this.requestedPort} is already in use`,
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      if (this.binding === operation) this.binding = undefined;
    }
  }

  async reserve(state: string) {
    if (!state) throw new Error("OAuth callback state is required");
    await this.ensureListening();
    if (this.pending.has(state))
      throw new Error("OAuth callback state is already reserved");
    this.pending.set(state, {});
    return this.callbackUrl;
  }

  wait(state: string, signal?: AbortSignal) {
    const pending = this.pending.get(state);
    if (!pending)
      return Promise.reject(new Error("OAuth callback state is not reserved"));
    if (pending.result) {
      this.pending.delete(state);
      return Promise.resolve(pending.result);
    }
    if (pending.error) {
      this.pending.delete(state);
      return Promise.reject(pending.error);
    }
    if (pending.resolve)
      return Promise.reject(
        new Error("OAuth callback is already being awaited"),
      );
    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
      const finishReject = (error: Error) => {
        cleanupAbort();
        reject(error);
      };
      const onAbort = () => {
        this.cancel(
          state,
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Authorization cancelled"),
        );
      };
      pending.resolve = (result) => {
        cleanupAbort();
        resolve(result);
      };
      pending.reject = finishReject;
      pending.abort = cleanupAbort;
      pending.timeout = setTimeout(() => {
        this.cancel(state, new Error("OAuth callback timeout"));
      }, this.timeoutMs);
      pending.timeout.unref?.();
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  cancel(state: string, reason = new Error("Authorization cancelled")) {
    const pending = this.pending.get(state);
    if (!pending) return;
    this.pending.delete(state);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abort?.();
    pending.reject?.(reason);
  }

  async close() {
    if (this.closing) return this.closing;
    const operation = (async () => {
      if (this.binding) await this.binding.catch(() => undefined);
      for (const state of [...this.pending.keys()]) {
        this.cancel(state, new Error("OAuth callback server stopped"));
      }
      const active = this.server;
      this.server = undefined;
      this.boundPort = undefined;
      if (active) {
        await new Promise<void>((resolve) => active.close(() => resolve()));
      }
    })();
    const tracked = operation.finally(() => {
      if (this.closing === tracked) this.closing = undefined;
    });
    this.closing = tracked;
    return tracked;
  }

  get pendingCount() {
    return this.pending.size;
  }

  get running() {
    return this.server !== undefined;
  }
}

const sharedCallbackServer = new OAuthCallbackServer();

export function getSharedCallbackServer() {
  return sharedCallbackServer;
}

export function stopCallbackServer() {
  return sharedCallbackServer.close();
}
