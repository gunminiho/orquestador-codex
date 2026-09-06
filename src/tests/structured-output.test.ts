import assert from "node:assert/strict";
import test from "node:test";
import {
  ArchitectActionSchema,
} from "../protocol/team-messages";
import {
  parseStructuredOutput,
  toCodexJsonSchema,
} from "../protocol/structured-output";
import type { JsonValue } from "../../schemas/serde_json/JsonValue";

type JsonObject = {
  [key: string]: JsonValue;
};

function containsKeyword(
  value: unknown,
  keyword: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsKeyword(item, keyword),
    );
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(([key, child]) =>
    key === keyword || containsKeyword(child, keyword),
  );
}

test("Codex output schemas flatten discriminated unions", () => {
  const schema = toCodexJsonSchema(
    ArchitectActionSchema,
  );
  assert.equal(
    schema !== null &&
      typeof schema === "object" &&
      !Array.isArray(schema),
    true,
  );
  const objectSchema = schema as JsonObject;

  assert.equal(containsKeyword(objectSchema, "oneOf"), false);
  assert.deepEqual(objectSchema.type, "object");
  assert.deepEqual(
    (objectSchema.properties as JsonObject).type,
    {
      type: "string",
      enum: [
        "TASK_ASSIGNMENT",
        "REVIEW_RESULT",
        "OWNER_INPUT_REQUIRED",
      ],
    },
  );
  assert.equal(
    Array.isArray(objectSchema.required),
    true,
  );
  assert.equal(
    (objectSchema.required as JsonValue[]).includes(
      "taskId",
    ),
    true,
  );
  assert.equal(
    (objectSchema.required as JsonValue[]).includes(
      "decision",
    ),
    true,
  );
  assert.equal(objectSchema.additionalProperties, false);
});

test("flattened schema does not weaken client-side union validation", () => {
  const assignment = parseStructuredOutput(
    ArchitectActionSchema,
    JSON.stringify({
      type: "TASK_ASSIGNMENT",
      taskId: "task-1",
      assignedTo: "backend",
      title: "Smoke task",
      objective: "Create a file",
      context: "",
      requirements: ["Create the requested file"],
      acceptanceCriteria: ["The file exists"],
      allowedPaths: ["hello.txt"],
      forbiddenPaths: [],
      validationCommands: [],
      notes: [],
    }),
  );

  assert.equal(assignment.type, "TASK_ASSIGNMENT");
  assert.throws(() =>
    parseStructuredOutput(
      ArchitectActionSchema,
      JSON.stringify({
        type: "TASK_ASSIGNMENT",
        taskId: "task-1",
      }),
    ),
  );
});
