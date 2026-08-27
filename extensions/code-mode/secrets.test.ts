import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredSecretValues,
  redactExactSecrets,
} from "./src/mcp/secrets.ts";

test("configured exact secrets are found and scrubbed from nested MCP data", () => {
  const previous = process.env.PI_CODE_MODE_EXACT_TEST;
  process.env.PI_CODE_MODE_EXACT_TEST = "opaque-value-not-token-shaped";
  try {
    const secrets = configuredSecretValues({
      transport: "http",
      url: "https://example.test/mcp?api_key=query-secret-value",
      headers: { Authorization: "Bearer ${PI_CODE_MODE_EXACT_TEST}" },
      oauth: false,
    });
    const input = {
      schema: { description: "echo opaque-value-not-token-shaped" },
      rows: [{ value: "Bearer opaque-value-not-token-shaped" }],
      query: "query-secret-value",
    };
    const redacted = redactExactSecrets(input, secrets);
    assert.equal(
      JSON.stringify(redacted).includes("opaque-value-not-token-shaped"),
      false,
    );
    assert.equal(
      JSON.stringify(redacted).includes("query-secret-value"),
      false,
    );
    assert.equal(
      JSON.stringify(input).includes("opaque-value-not-token-shaped"),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODE_MODE_EXACT_TEST;
    else process.env.PI_CODE_MODE_EXACT_TEST = previous;
  }
});
