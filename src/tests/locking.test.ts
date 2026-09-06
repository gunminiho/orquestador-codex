import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RepositoryBusyError,
  RepositoryLock,
  StaleForeignRepositoryLockError,
} from "../workflows/repository-lock";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nongit-lock-"));
  return {
    projectId: "p",
    repositoryId: "r",
    physicalRoot: root,
    workflowId: "w",
    taskId: "t",
    attemptId: "a",
  };
}
test("first non-Git task acquires durable physical repository lock", async () => {
  const input = await fixture();
  const lock = new RepositoryLock();
  const lease = await lock.acquire(input);
  assert.deepEqual(await lock.inspect(input.physicalRoot), lease);
  assert.equal(await lock.release(lease), true);
});
test("competing task and session cannot concurrently acquire non-Git lock", async () => {
  const input = await fixture();
  const a = new RepositoryLock();
  const b = new RepositoryLock();
  const lease = await a.acquire(input);
  await assert.rejects(b.acquire(input), /locked/);
  await assert.rejects(a.acquire({ ...input, taskId: "other" }), /locked/);
  await a.release(lease);
});
test("non-owner cannot release; owner can release", async () => {
  const input = await fixture();
  const a = new RepositoryLock();
  const b = new RepositoryLock();
  const lease = await a.acquire(input);
  assert.equal(await b.release(lease), false);
  assert.equal(await a.release(lease), true);
});
test("restart reconciles only proven dead same-task owner", async () => {
  const input = await fixture();
  const a = new RepositoryLock();
  const lease = await a.acquire(input);
  lease.owner.pid = 2147483647;
  await writeFile(
    path.join(input.physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify(lease),
  );
  const b = new RepositoryLock();
  const adopted = await b.acquire(input);
  assert.equal(adopted.owner.sessionId, b.sessionId);
  assert.equal(await b.release(adopted), true);
});
test("age and foreign hostname never justify takeover", async () => {
  const input = await fixture();
  const a = new RepositoryLock();
  const lease = await a.acquire(input);
  lease.owner.pid = 2147483647;
  lease.owner.hostname = "other-host";
  lease.acquiredAt = "2000-01-01";
  await writeFile(
    path.join(input.physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify(lease),
  );
  await assert.rejects(new RepositoryLock().acquire(input), /locked/);
  await a.release(lease);
});
test("live foreign owner is retryable repository busy", async () => {
  const input = await fixture();
  const owner = new RepositoryLock();
  const lease = await owner.acquire(input);
  const contender = new RepositoryLock();
  await assert.rejects(
    contender.acquire({
      ...input,
      workflowId: "other-workflow",
      taskId: "other-task",
    }),
    (error: unknown) =>
      error instanceof RepositoryBusyError &&
      error.codexErrorInfo === "serverOverloaded",
  );
  await owner.release(lease);
});
test("dead foreign owner becomes durable manual reconciliation, never a transient retry", async () => {
  const input = await fixture();
  const owner = new RepositoryLock();
  const lease = await owner.acquire(input);
  lease.owner.pid = 2147483647;
  await writeFile(
    path.join(input.physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify(lease),
  );
  const contender = new RepositoryLock();
  await assert.rejects(
    contender.acquire({
      ...input,
      workflowId: "other-workflow",
      taskId: "other-task",
    }),
    (error: unknown) => error instanceof StaleForeignRepositoryLockError,
  );
  assert.deepEqual(await contender.inspect(input.physicalRoot), lease);

  const store = new WorkflowStore(input.physicalRoot);
  const engine = new WorkflowEngine(store);
  const workflow = await engine.create("p", "manual reconciliation");
  const result = await engine.pauseForError(
    workflow,
    new StaleForeignRepositoryLockError(lease),
  );
  assert.equal(result.state, "PAUSED_MANUAL");
  assert.deepEqual(result.manualReconciliation, {
    reason: "STALE_FOREIGN_REPOSITORY_LOCK",
    repositoryId: lease.repositoryId,
    physicalRoot: lease.physicalRoot,
    ownerWorkflowId: lease.workflowId,
    ownerTaskId: lease.taskId,
    detectedAt: result.manualReconciliation!.detectedAt,
  });
  await assert.rejects(
    contender.acquire({
      ...input,
      workflowId: "other-workflow",
      taskId: "other-task",
    }),
    StaleForeignRepositoryLockError,
  );
});
