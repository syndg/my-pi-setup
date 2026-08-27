type JsonSchema = Record<string, unknown>;

export const DEFAULT_SCHEMA_SUMMARY_MAX_BYTES = 8 * 1024;

const MAX_SCHEMA_DEPTH = 12;
const MAX_OBJECT_PROPERTIES = 100;

export type SchemaRenderOptions = {
  maxBytes?: number;
};

export function renderSchemaAsTypeScript(
  inputSchema: unknown,
  options: SchemaRenderOptions = {},
) {
  if (!isRecord(inputSchema)) return "unknown";

  const rendered = renderSchema(inputSchema, inputSchema, 0, new Set());
  const maxBytes =
    positiveInteger(options.maxBytes) ?? DEFAULT_SCHEMA_SUMMARY_MAX_BYTES;
  return Buffer.byteLength(rendered, "utf8") <= maxBytes ? rendered : "unknown";
}

/** Compatibility-friendly short name for catalog callers. */
export const renderTypeScriptSchema = renderSchemaAsTypeScript;
export const renderTsShape = renderSchemaAsTypeScript;

function renderSchema(
  schema: JsonSchema,
  root: JsonSchema,
  depth: number,
  references: Set<string>,
): string {
  if (depth > MAX_SCHEMA_DEPTH) return "unknown";

  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#/") || references.has(schema.$ref))
      return "unknown";
    const referenced = resolveLocalReference(root, schema.$ref);
    if (!isRecord(referenced)) return "unknown";
    const nextReferences = new Set(references);
    nextReferences.add(schema.$ref);
    return renderSchema(referenced, root, depth + 1, nextReferences);
  }

  if (Object.hasOwn(schema, "const")) return renderLiteral(schema.const);

  if (Array.isArray(schema.enum)) {
    const values = unique(schema.enum.map(renderLiteral));
    return values.length > 0 && !values.includes("unknown")
      ? values.join(" | ")
      : "unknown";
  }

  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (variants) {
    const rendered = unique(
      variants.map((variant) =>
        isRecord(variant)
          ? renderSchema(variant, root, depth + 1, references)
          : "unknown",
      ),
    );
    return rendered.length > 0 ? rendered.join(" | ") : "unknown";
  }

  if (Array.isArray(schema.type)) {
    const rendered = unique(
      schema.type.map((type) => renderPrimitiveType(type)),
    );
    return rendered.length > 0 ? rendered.join(" | ") : "unknown";
  }

  let rendered: string;
  if (schema.type === "object" || isRecord(schema.properties)) {
    rendered = renderObject(schema, root, depth, references);
  } else if (
    schema.type === "array" ||
    Array.isArray(schema.prefixItems) ||
    Array.isArray(schema.items)
  ) {
    rendered = renderArray(schema, root, depth, references);
  } else if (typeof schema.type === "string") {
    rendered = renderPrimitiveType(schema.type);
  } else {
    rendered = "unknown";
  }

  if (schema.nullable === true && rendered !== "null") {
    return `${parenthesizeUnion(rendered)} | null`;
  }
  return rendered;
}

function renderObject(
  schema: JsonSchema,
  root: JsonSchema,
  depth: number,
  references: Set<string>,
) {
  const properties = isRecord(schema.properties)
    ? Object.entries(schema.properties).slice(0, MAX_OBJECT_PROPERTIES)
    : [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (property): property is string => typeof property === "string",
        )
      : [],
  );
  const members = properties.map(([name, property]) => {
    const type = isRecord(property)
      ? renderSchema(property, root, depth + 1, references)
      : "unknown";
    return `${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${type}`;
  });

  if (schema.additionalProperties === true) {
    members.push("[key: string]: unknown");
  } else if (isRecord(schema.additionalProperties)) {
    members.push(
      `[key: string]: ${renderSchema(schema.additionalProperties, root, depth + 1, references)}`,
    );
  }

  if (members.length === 0) {
    return schema.additionalProperties === false
      ? "{}"
      : "Record<string, unknown>";
  }
  return `{ ${members.join("; ")} }`;
}

function renderArray(
  schema: JsonSchema,
  root: JsonSchema,
  depth: number,
  references: Set<string>,
) {
  const tupleItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;

  if (tupleItems) {
    const items = tupleItems.map((item) =>
      isRecord(item)
        ? renderSchema(item, root, depth + 1, references)
        : "unknown",
    );
    const restSchema = Array.isArray(schema.prefixItems)
      ? schema.items
      : schema.additionalItems;
    if (isRecord(restSchema)) {
      const rest = renderSchema(restSchema, root, depth + 1, references);
      items.push(`...${parenthesizeUnion(rest)}[]`);
    } else if (restSchema === true) {
      items.push("...unknown[]");
    }
    return `[${items.join(", ")}]`;
  }

  if (!isRecord(schema.items)) return "unknown[]";
  const item = renderSchema(schema.items, root, depth + 1, references);
  return `${parenthesizeUnion(item)}[]`;
}

function renderPrimitiveType(type: unknown) {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    default:
      return "unknown";
  }
}

function renderLiteral(value: unknown) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "unknown";
}

function resolveLocalReference(root: JsonSchema, reference: string) {
  let value: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    if (!isRecord(value)) return undefined;
    value = value[decodePointerToken(token)];
  }
  return value;
}

function decodePointerToken(token: string) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function formatPropertyName(name: string) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function parenthesizeUnion(type: string) {
  return type.includes(" | ") ? `(${type})` : type;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
