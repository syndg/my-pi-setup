import assert from "node:assert/strict";
import test from "node:test";
import type { FetchLike } from "@modelcontextprotocol/client";
import { createBoundedFetch } from "./src/mcp/bounded-fetch.ts";

test("bounded fetch rejects declared and streamed oversized responses", async () => {
  const declared = createBoundedFetch(
    4,
    async () => new Response("12345", { headers: { "content-length": "5" } }),
  );
  await assert.rejects(
    () => declared(new URL("https://example.test")),
    /exceeded 4 bytes/,
  );

  const streamed = createBoundedFetch(4, async () => new Response("12345"));
  const response = await streamed(new URL("https://example.test"));
  await assert.rejects(() => response.text(), /exceeded 4 bytes/);
});

test("bounded fetch prohibits redirects on the underlying request", async () => {
  let observedRedirect: RequestRedirect | undefined;
  const base: FetchLike = async (_input, init) => {
    observedRedirect = init?.redirect;
    return new Response("ok");
  };
  const bounded = createBoundedFetch(1024, base);
  await bounded(new URL("https://example.test"), { redirect: "follow" });
  assert.equal(observedRedirect, "error");
});
