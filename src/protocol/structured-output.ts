import { z } from "zod";

import type { JsonValue } from "../../schemas/serde_json/JsonValue";

export function toCodexJsonSchema(
  schema: z.ZodType,
): JsonValue {
  return z.toJSONSchema(
    schema,
    {
      target: "draft-7",
    },
  ) as JsonValue;
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