import type { FetchLike } from "@modelcontextprotocol/client";

export const MAX_MCP_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_OAUTH_HTTP_RESPONSE_BYTES = 1024 * 1024;

export function createBoundedFetch(
  maxBytes: number,
  baseFetch: FetchLike = fetch,
  allowRedirect = false,
): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, {
      ...init,
      redirect: allowRedirect ? init?.redirect : "error",
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
      }
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const boundedBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxBytes) {
            controller.error(
              new Error(`HTTP response exceeded ${maxBytes} bytes`),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const boundedResponse = new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(boundedResponse, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return boundedResponse;
  };
}
