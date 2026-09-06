import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitFixture } from "./fixtures";
import { ProjectRuntime } from "../runtime/project-runtime";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { TaskWorkspace } from "../workflows/task-workspace";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";

const exec = promisify(execFile);
const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "approved-task",
  assignedTo: "frontend" as const,
  title: "approved task",
  objective: "persist approved implementation",
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
  summary: "implemented",
  filesChanged: ["repo:modified.txt"],
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

function topology(root: string, repo: string) {
  return new TopologyService({
    version: 1,
    workspaceRoot: root,
    repositories: [
      {
        id: "repo",
        root: repo,
        metadata: {},
        ownership: [
          {
            pattern: "**",
            readableBy: ["frontend"],
            writableBy: ["frontend"],
            architectControlled: false,
          },
        ],
      },
    ],
    agentWorkspaces: {},
  });
}

function runtimeFixture(root: string, repo: string) {
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(topology(root, repo));
  const workspace = new TaskWorkspace(root, ownership, store);
  const architect = {
    getThreadId: () => "architect-thread",
    sendStructured: async () => ({
      data: calls++ === 0 ? assignment : approval,
    }),
  };
  let calls = 0;
  const router = {
    getThreadId: () => "frontend-thread",
    routeTask: async (_: unknown, options: { cwd?: string }) => {
      await writeFile(
        path.join(options.cwd!, "modified.txt"),
        "approved implementation\n",
      );
      return report;
    },
  };
  const runner = new WorkflowRunner(
    engine,
    store,
    architect as never,
    router as never,
    ownership,
    workspace,
  );
  const lifecycle = {
    client: {
      processId: null,
      interruptTurn: async () => ({}),
      getAccountRateLimits: async () => ({}),
    },
    start: async () => {},
    stop: () => {},
  };
  const runtime = new ProjectRuntime(
    "p",
    lifecycle as never,
    store,
    engine,
    runner,
    workspace,
    path.join(root, ".orchestrator", "execution"),
  );
  return { store, engine, ownership, workspace, runtime, lifecycle };
}

async function approvedWorkflow() {
  const fixture = await gitFixture();
  const runtime = runtimeFixture(fixture.root, fixture.repo);
  const workflow = await runtime.engine.create(
    "p",
    "deliver approved implementation",
  );
  const result = await runtime.runtime.execute(workflow.id);
  return { fixture, workflow: result, ...runtime };
}

test("approved runtime finalization commits, persists, and preserves result after disposable worktree cleanup", async () => {
  const { fixture, workflow, store, ownership, lifecycle } =
    await approvedWorkflow();
  const delivery = workflow.deliveries[0]!;
  assert.equal(workflow.state, "APPROVED");
  assert.equal(delivery.status, "READY_TO_INTEGRATE");
  assert.equal(
    await readFile(path.join(fixture.repo, "modified.txt"), "utf8"),
    "original\n",
  );
  await assert.rejects(access(workflow.worktrees[0]!.worktreePath));

  const reloaded = await new WorkflowStore(fixture.root).get("p", workflow.id);
  const durable = reloaded.deliveries[0]!;
  assert.equal(durable.resultCommitSha, delivery.resultCommitSha);
  assert.equal(
    (
      await exec("git", [
        "-C",
        fixture.repo,
        "show",
        `${durable.resultCommitSha}:modified.txt`,
      ])
    ).stdout,
    "approved implementation\n",
  );
  assert.equal(
    (
      await exec("git", [
        "-C",
        fixture.repo,
        "rev-parse",
        `refs/heads/${durable.branch}`,
      ])
    ).stdout.trim(),
    durable.resultCommitSha,
  );

  // Reconstruct the runtime/store after terminal cleanup and integrate the durable result.
  const restartedStore = new WorkflowStore(fixture.root);
  const restartedWorkspace = new TaskWorkspace(
    fixture.root,
    ownership,
    restartedStore,
  );
  const restarted = new ProjectRuntime(
    "p",
    lifecycle as never,
    restartedStore,
    new WorkflowEngine(restartedStore),
    null as never,
    restartedWorkspace,
    path.join(fixture.root, ".orchestrator", "execution-restarted"),
  );
  const integrated = await restarted.integrate(workflow.id);
  assert.equal(integrated.deliveries[0]!.status, "INTEGRATED");
  assert.equal(
    await readFile(path.join(fixture.repo, "modified.txt"), "utf8"),
    "approved implementation\n",
  );
  assert.equal(
    (
      await exec("git", ["-C", fixture.repo, "rev-parse", "HEAD"])
    ).stdout.trim(),
    durable.resultCommitSha,
  );
});

test("dirty original checkout is never overwritten and keeps durable approved delivery", async () => {
  const { fixture, workflow, runtime } = await approvedWorkflow();
  const delivery = workflow.deliveries[0]!;
  await writeFile(
    path.join(fixture.repo, "modified.txt"),
    "owner dirty work\n",
  );
  const result = await runtime.integrate(workflow.id);
  assert.equal(result.deliveries[0]!.status, "OWNER_ACTION_REQUIRED");
  assert.match(result.deliveries[0]!.integrationReason!, /dirty/);
  assert.equal(
    await readFile(path.join(fixture.repo, "modified.txt"), "utf8"),
    "owner dirty work\n",
  );
  assert.equal(
    (
      await exec("git", [
        "-C",
        fixture.repo,
        "rev-parse",
        `refs/heads/${delivery.branch}`,
      ])
    ).stdout.trim(),
    delivery.resultCommitSha,
  );
});

test("diverged original checkout is never overwritten and keeps durable approved delivery", async () => {
  const { fixture, workflow, runtime } = await approvedWorkflow();
  const delivery = workflow.deliveries[0]!;
  await writeFile(
    path.join(fixture.repo, "modified.txt"),
    "owner divergent commit\n",
  );
  await fixture.git("add", "modified.txt");
  await fixture.git("commit", "-m", "owner diverged");
  const before = (await fixture.git("rev-parse", "HEAD")).stdout.trim();
  const result = await runtime.integrate(workflow.id);
  assert.equal(result.deliveries[0]!.status, "OWNER_ACTION_REQUIRED");
  assert.match(result.deliveries[0]!.integrationReason!, /Original HEAD/);
  assert.equal((await fixture.git("rev-parse", "HEAD")).stdout.trim(), before);
  assert.equal(
    (
      await exec("git", [
        "-C",
        fixture.repo,
        "rev-parse",
        `refs/heads/${delivery.branch}`,
      ])
    ).stdout.trim(),
    delivery.resultCommitSha,
  );
});

for (const terminal of ["CANCELLED", "FAILED"] as const) {
  test(`${terminal} disposable worktree and branch clean safely`, async () => {
    const fixture = await gitFixture();
    const { engine, workspace } = runtimeFixture(fixture.root, fixture.repo);
    let workflow = await engine.transition(
      await engine.create("p", "terminal cleanup"),
      "PLANNING",
      "test",
    );
    workflow = await engine.assign(workflow, assignment);
    workflow = (await workspace.prepare(workflow)).workflow;
    const worktree = workflow.worktrees[0]!;
    await writeFile(
      path.join(worktree.worktreePath, "modified.txt"),
      "disposable\n",
    );
    workflow =
      terminal === "CANCELLED"
        ? await engine.cancel(workflow)
        : await engine.pauseForError(
            workflow,
            new Error("unrecoverable fixture failure"),
          );
    await workspace.cleanup(workflow);
    await assert.rejects(access(worktree.worktreePath));
    await assert.rejects(
      exec("git", [
        "-C",
        fixture.repo,
        "rev-parse",
        `refs/heads/${worktree.branch}`,
      ]),
    );
  });
}
