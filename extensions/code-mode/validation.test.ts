import assert from "node:assert/strict";
import test from "node:test";
import { McpArgumentValidator } from "./src/mcp/validation.ts";

test("argument validation rejects unsafe schema regular expressions", () => {
  const validator = new McpArgumentValidator();
  assert.throws(
    () =>
      validator.validate(
        {
          type: "object",
          properties: { value: { type: "string", pattern: "(a+)+$" } },
        },
        { value: "safe" },
      ),
    /unsafe schema regular expression/,
  );
});

test("argument validation accepts safe patterns and enforces schemas", () => {
  const validator = new McpArgumentValidator();
  const schema = {
    type: "object",
    properties: { value: { type: "string", pattern: "^[a-z]+$" } },
    required: ["value"],
    additionalProperties: false,
  };

  assert.doesNotThrow(() => validator.validate(schema, { value: "safe" }));
  assert.throws(
    () => validator.validate(schema, { value: "123" }),
    /Invalid MCP tool arguments/,
  );
});
