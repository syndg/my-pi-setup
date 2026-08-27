import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { createHash } from "node:crypto";
import { checkSync } from "recheck";

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 512;

const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
const addFormats = addFormatsImport as unknown as (instance: Ajv) => void;

const draft7 = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  addUsedSchema: false,
});
const draft2020 = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  addUsedSchema: false,
});
addFormats(draft7);
addFormats(draft2020);

function schemaRecord(schema: unknown) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("MCP tool input schema must be a JSON Schema object");
  }
  return schema as Record<string, unknown>;
}

function serializedSchema(schema: unknown) {
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(`schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  return serialized;
}

function schemaKey(serialized: string) {
  return createHash("sha256").update(serialized).digest("hex");
}

function assertSafePatterns(schema: Record<string, unknown>) {
  const patterns = new Set<string>();
  const stack: unknown[] = [schema];
  let nodes = 0;

  while (stack.length > 0) {
    if (++nodes > MAX_SCHEMA_NODES) {
      throw new Error(`schema exceeds ${MAX_SCHEMA_NODES} nodes`);
    }
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.pattern === "string") patterns.add(record.pattern);
    if (
      record.patternProperties &&
      typeof record.patternProperties === "object" &&
      !Array.isArray(record.patternProperties)
    ) {
      for (const pattern of Object.keys(record.patternProperties)) {
        patterns.add(pattern);
      }
    }
    stack.push(...Object.values(record));
  }

  if (patterns.size > MAX_SCHEMA_PATTERNS) {
    throw new Error(
      `schema exceeds ${MAX_SCHEMA_PATTERNS} regular expressions`,
    );
  }
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `schema regular expression exceeds ${MAX_PATTERN_LENGTH} characters`,
      );
    }
    const safety = checkSync(pattern, "u", {
      checker: "automaton",
      maxPatternSize: MAX_PATTERN_LENGTH,
    });
    if (safety.status !== "safe") {
      throw new Error(`unsafe schema regular expression (${safety.status})`);
    }
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? [])
    .slice(0, 8)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

export class McpArgumentValidator {
  private readonly validators = new Map<string, ValidateFunction>();

  private compile(schema: unknown) {
    const record = schemaRecord(schema);
    const serialized = serializedSchema(record);
    const key = schemaKey(serialized);
    const existing = this.validators.get(key);
    if (existing) return existing;
    assertSafePatterns(record);
    const dialect = typeof record.$schema === "string" ? record.$schema : "";
    const validator = dialect.includes("2020-12")
      ? draft2020.compile(record)
      : draft7.compile(record);
    this.validators.set(key, validator);
    return validator;
  }

  validate(schema: unknown, input: unknown) {
    let validator: ValidateFunction;
    try {
      validator = this.compile(schema);
    } catch (error) {
      throw new Error(
        `MCP tool schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (validator(input)) return;
    throw new Error(
      `Invalid MCP tool arguments: ${formatErrors(validator.errors)}`,
    );
  }
}
