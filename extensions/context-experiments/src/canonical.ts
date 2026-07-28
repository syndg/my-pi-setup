function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Deterministic reports reject non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new Error(`Deterministic reports cannot serialize ${typeof value}.`);
}

export function deterministicJson(value: unknown) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function canonicalCompactJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}
