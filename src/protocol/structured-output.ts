import { z } from "zod";

import type { JsonValue } from "../../schemas/serde_json/JsonValue";

export function toCodexJsonSchema(
  schema: z.ZodType,
): JsonValue {
  const generated = z.toJSONSchema(
    schema,
    {
      target: "draft-7",
    },
  ) as JsonValue;

  return normalizeCodexSchema(generated);
}

type JsonObject = {
  [key: string]: JsonValue;
};

function isJsonObject(
  value: unknown,
): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeCodexSchema(
  value: JsonValue,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalizeCodexSchema);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const union = value.oneOf;
  if (
    Array.isArray(union) &&
    union.length > 0 &&
    union.every(isJsonObject)
  ) {
    return flattenObjectUnion(union);
  }

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema") {
      continue;
    }
    normalized[key] = normalizeCodexSchema(child);
  }
  return normalized;
}

function flattenObjectUnion(
  variants: JsonObject[],
): JsonObject {
  const properties: JsonObject = {};

  for (const variant of variants) {
    const variantProperties = variant.properties;
    if (!isJsonObject(variantProperties)) {
      continue;
    }

    for (const [key, property] of Object.entries(variantProperties)) {
      if (property === undefined) {
        continue;
      }
      const normalizedProperty =
        normalizeCodexSchema(property);
      const current = properties[key];
      properties[key] = current === undefined
        ? normalizedProperty
        : mergePropertySchemas(current, normalizedProperty);
    }
  }

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function mergePropertySchemas(
  left: JsonValue,
  right: JsonValue,
): JsonValue {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return left;
  }

  if (
    isJsonObject(left) &&
    isJsonObject(right)
  ) {
    const leftValues = schemaValues(left);
    const rightValues = schemaValues(right);
    if (
      leftValues !== undefined &&
      rightValues !== undefined
    ) {
      return {
        type: left.type ?? right.type ?? "string",
        enum: uniqueJsonValues([
          ...leftValues,
          ...rightValues,
        ]),
      };
    }

    if (
      typeof left.type === "string" &&
      left.type === right.type
    ) {
      return { type: left.type };
    }
  }

  return {};
}

function schemaValues(
  schema: JsonObject,
): JsonValue[] | undefined {
  if (schema.const !== undefined) {
    return [schema.const];
  }
  return Array.isArray(schema.enum)
    ? schema.enum
    : undefined;
}

function uniqueJsonValues(
  values: JsonValue[],
): JsonValue[] {
  const unique: JsonValue[] = [];
  for (const value of values) {
    if (!unique.some((item) =>
      JSON.stringify(item) === JSON.stringify(value),
    )) {
      unique.push(value);
    }
  }
  return unique;
}

export function parseStructuredOutput<T>(
  schema: z.ZodType<T>,
  text: string,
): T {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      [
        "Codex returned invalid structured JSON.",
        "",
        "Raw response:",
        text,
      ].join("\n"),
    );
  }

  const result =
    schema.safeParse(json);

  if (!result.success) {
    throw new Error(
      [
        "Codex returned JSON that does not match the expected schema.",
        "",
        z.prettifyError(
          result.error,
        ),
        "",
        "Raw response:",
        text,
      ].join("\n"),
    );
  }

  return result.data;
}
