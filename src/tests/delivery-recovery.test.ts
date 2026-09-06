import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
import { ProjectRuntime } from "../runtime/project-runtime";
import { TaskWorkspace } from "../workflows/task-workspace";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowStore } from "../workflows/workflow-store";

const exec = promisify(execFile);

const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "delivery-task",
  assignedTo: "frontend" as const,
  title: "durable delivery",
  objective: "finalize reviewed work",
  context: "",
  requirements: [],
  acceptanceCriteria: [],
  allowedPaths: ["**"],
  forbiddenPaths: [],
  validationCommands: [],
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

type RepositoryFixture = { id: string; root: string };

async function gitRepository(
  root: string,
  id: string,
): Promise<RepositoryFixture> {
  const repository = path.join(root, id);
  await mkdir(repository, { recursive: true });
  const git = (...args: string[]) =>
    exec("git", ["-C", repository, ...args], { windowsHide: true });
  await git("init");
  await git("config", "core.autocrlf", "false");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repository, "modified.txt"), "original\n");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  return { id, root: repository };
}

function ownership(root: string, repositories: RepositoryFixture[]) {
  return new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: root,
      repositories: repositories.map((repository) => ({
        ...repository,
        metadata: {},
        ownership: [
          {
            pattern: "**",
            readableBy: ["frontend"],
            writableBy: ["frontend"],
            architectControlled: false,
          },
        ],
      })),
      agentWorkspaces: {},
    }),
  );
}

function finalizationRuntime(
  root: string,
  store: WorkflowStore,
  engine: WorkflowEngine,
  workspace: TaskWorkspace,
) {
  return new ProjectRuntime(
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
    null as never,
    workspace,
    path.join(root, ".orchestrator", "delivery-recovery"),
  );
}

async function finalizingWorkflow(repositoryCount = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "delivery-recovery-"));
  const repositories = await Promise.all(
    Array.from({ length: repositoryCount }, (_, index) =>
      gitRepository(root, `repo-${index + 1}`),
    ),
  );
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const verifier = ownership(root, repositories);
  const workspace = new TaskWorkspace(root, verifier, store);
  let workflow = await engine.create("p", "durable delivery");
  workflow = await engine.transition(workflow, "PLANNING", "fixture");
  workflow = await engine.assign(workflow, assignment);
  workflow = await engine.transition(workflow, "IMPLEMENTING", "fixture");
  workflow = (await workspace.prepare(workflow)).workflow;

  for (const worktree of workflow.worktrees) {
    await writeFile(
      path.join(worktree.worktreePath, "modified.txt"),
      `approved ${worktree.repositoryId}\n`,
    );
  }
  const report = {
    type: "TASK_REPORT" as const,
    taskId: assignment.taskId,
    agent: "frontend" as const,
    status: "READY_FOR_REVIEW" as const,
    summary: "implemented",
    filesChanged: workflow.worktrees.map(
      (worktree) => `${worktree.repositoryId}:modified.txt`,
    ),
    testsChanged: [],
    validations: [],
    risks: [],
    blockers: [],
    notes: [],
  };
  workflow = await engine.report(workflow, report, {
    ok: true,
    violations: [],
    verifiedFiles: report.filesChanged,
    source: "git",
  });
  workflow = await engine.transition(workflow, "REVIEWING", "fixture");
  workflow = await engine.review(workflow, approval);
  assert.equal(workflow.state, "FINALIZING_DELIVERY");
  assert.equal(workflow.reviews.at(-1)!.decision, "APPROVED");
  return { root, repositories, store, engine, verifier, workspace, workflow };
}

async function restartAndFinalize(
  fixture: Awaited<ReturnType<typeof finalizingWorkflow>>,
) {
  const store = new WorkflowStore(fixture.root);
  const workspace = new TaskWorkspace(fixture.root, fixture.verifier, store);
  const runtime = finalizationRuntime(
    fixture.root,
    store,
    new WorkflowEngine(store),
    workspace,
  );
  const recoverable = await store.recoverable("p");
  assert.ok(
    recoverable.some((workflow) => workflow.id === fixture.workflow.id),
  );
  return runtime.execute(fixture.workflow.id);
}

async function assertDurableResult(
  fixture: Awaited<ReturnType<typeof finalizingWorkflow>>,
  workflow: Awaited<ReturnType<typeof restartAndFinalize>>,
) {
  assert.equal(workflow.state, "APPROVED");
  for (const delivery of workflow.deliveries) {
    const repository = fixture.repositories.find(
      (item) => item.id === delivery.repositoryId,
    )!;
    const content = await exec(
      "git",
      [
        "-C",
        repository.root,
        "show",
        `${delivery.resultCommitSha}:modified.txt`,
      ],
      { windowsHide: true },
    );
    assert.equal(content.stdout, `approved ${delivery.repositoryId}\n`);
  }
  for (const worktree of workflow.worktrees) {
    await assert.rejects(access(worktree.worktreePath));
  }
}

test("FINALIZING_DELIVERY survives a crash before first delivery persistence", async () => {
  const fixture = await finalizingWorkflow();
  assert.deepEqual(fixture.workflow.deliveries, []);
  await assertDurableResult(fixture, await restartAndFinalize(fixture));
});

test("FINALIZING_DELIVERY resumes after a result commit but before delivery persistence", async () => {
  const fixture = await finalizingWorkflow();
  const committed = await fixture.workspace.git.finalizeApproved(
    fixture.workflow.worktrees[0]!,
  );
  const result = await restartAndFinalize(fixture);
  assert.equal(
    result.deliveries[0]!.resultCommitSha,
    committed.resultCommitSha,
  );
  await assertDurableResult(fixture, result);
});

test("FINALIZING_DELIVERY resumes cleanup after delivery persistence", async () => {
  const fixture = await finalizingWorkflow();
  const persisted = await fixture.workspace.finalizeApproved(fixture.workflow);
  assert.equal(persisted.deliveries.length, 1);
  await access(persisted.worktrees[0]!.worktreePath);
  await assertDurableResult(fixture, await restartAndFinalize(fixture));
});

test("partial multi-repository delivery resumes without rewriting durable results", async () => {
  const fixture = await finalizingWorkflow(2);
  const first = fixture.workflow.worktrees[0]!;
  const committed = await fixture.workspace.git.finalizeApproved(first);
  const partial = await fixture.store.saveApprovedDeliveries(
    "p",
    fixture.workflow.id,
    [
      {
        repositoryId: first.repositoryId,
        taskId: first.taskId,
        baseCommitSha: committed.baseCommitSha,
        resultCommitSha: committed.resultCommitSha,
        branch: committed.branch,
        originalRepositoryRoot: first.originalRepositoryRoot,
        originalBranch: first.originalBranch,
        status: "READY_TO_INTEGRATE",
        finalizedAt: new Date().toISOString(),
        integratedAt: null,
        integrationReason: null,
      },
    ],
  );
  assert.equal(partial.deliveries.length, 1);

  const result = await restartAndFinalize(fixture);
  const firstDelivery = result.deliveries.find(
    (delivery) => delivery.repositoryId === first.repositoryId,
  )!;
  assert.equal(firstDelivery.resultCommitSha, committed.resultCommitSha);
  const original = fixture.repositories.find(
    (repository) => repository.id === first.repositoryId,
  )!;
  assert.equal(
    (
      await exec(
        "git",
        ["-C", original.root, "rev-parse", `refs/heads/${first.branch}`],
        { windowsHide: true },
      )
    ).stdout.trim(),
    committed.resultCommitSha,
  );
  assert.equal(result.deliveries.length, 2);
  await assertDurableResult(fixture, result);
});

test("concurrent delivery persistence retains independent repository deliveries", async () => {
  const fixture = await finalizingWorkflow(2);
  const [first, second] = fixture.workflow.worktrees;
  const deliveries = [first!, second!].map((worktree, index) => ({
    repositoryId: worktree.repositoryId,
    taskId: worktree.taskId,
    baseCommitSha: worktree.baseCommitSha,
    resultCommitSha: `result-${index}`,
    branch: worktree.branch,
    originalRepositoryRoot: worktree.originalRepositoryRoot,
    originalBranch: worktree.originalBranch,
    status: "READY_TO_INTEGRATE" as const,
    finalizedAt: new Date().toISOString(),
    integratedAt: null,
    integrationReason: null,
  }));
  await Promise.all(
    deliveries.map((delivery) =>
      new WorkflowStore(fixture.root).saveApprovedDeliveries(
        "p",
        fixture.workflow.id,
        [delivery],
      ),
    ),
  );
  const reloaded = await fixture.store.get("p", fixture.workflow.id);
  assert.deepEqual(
    reloaded.deliveries.map((delivery) => delivery.resultCommitSha).sort(),
    ["result-0", "result-1"],
  );
});
