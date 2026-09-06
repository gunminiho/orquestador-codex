import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
import {
  ProjectExecutionBusyError,
  ProjectExecutionLock,
} from "../runtime/project-execution-lock";
import { ProjectRuntime } from "../runtime/project-runtime";
import { TaskWorkspace } from "../workflows/task-workspace";
import {
  RepositoryLock,
  StaleForeignRepositoryLockError,
} from "../workflows/repository-lock";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowStore } from "../workflows/workflow-store";

const deadPid = 2147483647;
const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "task-a",
  assignedTo: "frontend" as const,
  title: "delivery",
  objective: "finalize",
  context: "",
  requirements: [],
  acceptanceCriteria: [],
  allowedPaths: ["**"],
  forbiddenPaths: [],
  validationCommands: [],
  notes: [],
};
const report = {
  type: "TASK_REPORT" as const,
  taskId: assignment.taskId,
  agent: "frontend" as const,
  status: "READY_FOR_REVIEW" as const,
  summary: "done",
  filesChanged: [],
  testsChanged: [],
  validations: [],
  risks: [],
  blockers: [],
  notes: [],
};
const approval = {
  type: "REVIEW_RESULT" as const,
  taskId: assignment.taskId,
  reviewedAgent: "frontend" as const,
  decision: "APPROVED" as const,
  summary: "approved",
  findings: [],
  requiredChanges: [],
  validationRequired: [],
};

async function root() {
  return mkdtemp(path.join(os.tmpdir(), "project-execution-lock-"));
}

async function staleLease(
  root: string,
  workflowId = "workflow-a",
) {
  const owner = new ProjectExecutionLock();
  const lease = await owner.acquire({
    projectId: "p",
    workflowId,
    physicalRoot: root,
  });
  const stale = {
    ...lease,
    owner: { ...lease.owner, pid: deadPid, serverPid: null },
  };
  await writeFile(
    path.join(root, ".orchestrator-repository.lock"),
    JSON.stringify(stale),
  );
  return stale;
}

test("a dead internal execution owner is reclaimed across workflow ids", async () => {
  const physicalRoot = await root();
  await staleLease(physicalRoot);
  const contender = new ProjectExecutionLock();
  const lease = await contender.acquire({
    projectId: "p",
    workflowId: "workflow-b",
    physicalRoot,
  });
  assert.equal(lease.workflowId, "workflow-b");
  assert.equal(lease.owner.sessionId, contender.sessionId);
  assert.equal(await contender.release(lease), true);
});

test("two fresh schedulers racing stale execution recovery elect one owner", async () => {
  const physicalRoot = await root();
  await staleLease(physicalRoot);
  const first = new ProjectExecutionLock();
  const second = new ProjectExecutionLock();
  const outcomes = await Promise.allSettled([
    first.acquire({ projectId: "p", workflowId: "workflow-b", physicalRoot }),
    second.acquire({ projectId: "p", workflowId: "workflow-c", physicalRoot }),
  ]);
  const winners = outcomes.filter(
    (
      outcome,
    ): outcome is PromiseFulfilledResult<
      Awaited<ReturnType<ProjectExecutionLock["acquire"]>>
    > => outcome.status === "fulfilled",
  );
  assert.equal(winners.length, 1);
  const winner = winners[0]!.value;
  const owner = winner.owner.sessionId === first.sessionId ? first : second;
  assert.deepEqual(await owner.inspect(physicalRoot), winner);
  assert.equal(await owner.release(winner), true);
});

test("live and foreign-host project execution owners stay conservative", async () => {
  const physicalRoot = await root();
  const owner = new ProjectExecutionLock();
  const lease = await owner.acquire({
    projectId: "p",
    workflowId: "workflow-a",
    physicalRoot,
  });
  await assert.rejects(
    new ProjectExecutionLock().acquire({
      projectId: "p",
      workflowId: "workflow-b",
      physicalRoot,
    }),
    ProjectExecutionBusyError,
  );
  const foreign = {
    ...lease,
    owner: {
      ...lease.owner,
      pid: deadPid,
      serverPid: null,
      hostname: "foreign-host",
    },
  };
  await writeFile(
    path.join(physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify(foreign),
  );
  await assert.rejects(
    new ProjectExecutionLock().acquire({
      projectId: "p",
      workflowId: "workflow-b",
      physicalRoot,
    }),
    ProjectExecutionBusyError,
  );
});

test("project runtime reclaims stale scheduler lock even when workflow B is recovered first", async () => {
  const rootDirectory = await root();
  const repository = path.join(rootDirectory, "plain");
  const executionRoot = path.join(rootDirectory, "execution");
  await Promise.all([mkdir(repository), mkdir(executionRoot)]);
  const store = new WorkflowStore(rootDirectory);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: rootDirectory,
      repositories: [
        {
          id: "repo",
          root: repository,
          metadata: {},
          ownership: [],
        },
      ],
      agentWorkspaces: {},
    }),
  );
  const workspace = new TaskWorkspace(rootDirectory, ownership, store);
  let workflowA = await engine.create("p", "finalizing owner", "workflow-a");
  workflowA = await engine.transition(workflowA, "PLANNING", "fixture");
  workflowA = await engine.assign(workflowA, assignment);
  workflowA = await engine.transition(workflowA, "IMPLEMENTING", "fixture");
  workflowA = await engine.report(workflowA, report, {
    ok: true,
    violations: [],
    verifiedFiles: [],
    source: "snapshot",
  });
  workflowA = await engine.transition(workflowA, "REVIEWING", "fixture");
  workflowA = await engine.review(workflowA, approval);
  assert.equal(workflowA.state, "FINALIZING_DELIVERY");
  const workflowB = await engine.create("p", "recovered first", "workflow-b");
  await staleLease(executionRoot, workflowA.id);

  const runtime = new ProjectRuntime(
    "p",
    {
      client: {
        processId: null,
        interruptTurn: async () => ({}),
        getAccountRateLimits: async () => ({}),
      },
      start: async () => {},
      stop: () => {},
    } as never,
    store,
    engine,
    { runUntilPauseOrTerminal: async (workflow: unknown) => workflow } as never,
    workspace,
    executionRoot,
  );
  assert.ok(
    (await store.recoverable("p")).some(
      (workflow) => workflow.id === workflowA.id,
    ),
  );
  assert.equal((await runtime.execute(workflowB.id)).state, "PENDING");
  assert.equal((await runtime.execute(workflowA.id)).state, "APPROVED");
  assert.notEqual((await store.get("p", workflowB.id)).state, "PAUSED_MANUAL");
});

test("application repository locks retain foreign-stale manual safety", async () => {
  const physicalRoot = await root();
  const owner = new RepositoryLock();
  const input = {
    projectId: "p",
    repositoryId: "repo",
    physicalRoot,
    workflowId: "workflow-a",
    taskId: "task-a",
    attemptId: "attempt-a",
  };
  const lease = await owner.acquire(input);
  await writeFile(
    path.join(physicalRoot, ".orchestrator-repository.lock"),
    JSON.stringify({
      ...lease,
      owner: { ...lease.owner, pid: deadPid, serverPid: null },
    }),
  );
  await assert.rejects(
    new RepositoryLock().acquire({
      ...input,
      workflowId: "workflow-b",
      taskId: "task-b",
    }),
    StaleForeignRepositoryLockError,
  );
});
