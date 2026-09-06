import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newWorkflow, WorkflowSchema } from "../workflows/workflow-schema";
import { WorkflowStore } from "../workflows/workflow-store";

test("older V2 workflows receive attempt defaults", () => {
  const { attempts, worktrees, activeTurn, cancellationRequestedAt, ...old } =
    newWorkflow("p", "task");
  assert.deepEqual(WorkflowSchema.parse(old).attempts, []);
});

test("implementation attempt metadata survives store reload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attempt-"));
  const store = new WorkflowStore(root);
  const workflow = newWorkflow("p", "task");
  workflow.attempts.push({
    attemptId: "a",
    workflowId: workflow.id,
    taskId: "t",
    assignedAgent: "backend",
    threadId: "thread",
    turnId: "turn",
    repositoryId: "repo",
    worktreePath: root,
    baseCommitSha: "sha",
    startedAt: workflow.createdAt,
    completedAt: null,
    status: "INTERRUPTED",
    correctionAttempt: 1,
    reportPersisted: false,
    reconciliationState: "REPORT_CONTINUE",
  });
  await store.save(workflow);
  assert.deepEqual(
    (await new WorkflowStore(root).get("p", workflow.id)).attempts,
    workflow.attempts,
  );
});
