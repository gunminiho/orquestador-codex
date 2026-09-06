import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectRuntime } from "../runtime/project-runtime";
import { CodexLifecycleManager } from "../runtime/codex-lifecycle-manager";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { TaskWorkspace } from "../workflows/task-workspace";
import { TopologyService } from "../projects/project-topology";
import { OwnershipVerifier } from "../projects/ownership";
import type { TurnOptions } from "../codex/app-server-client";
const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "t",
  assignedTo: "frontend" as const,
  title: "x",
  objective: "x",
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
  taskId: "t",
  agent: "frontend" as const,
  status: "READY_FOR_REVIEW" as const,
  summary: "x",
  filesChanged: [],
  testsChanged: [],
  validations: [],
  risks: [],
  blockers: [],
  notes: [],
};
const review = {
  type: "REVIEW_RESULT",
  taskId: "t",
  reviewedAgent: "frontend",
  decision: "APPROVED",
  summary: "ok",
  findings: [],
  requiredChanges: [],
  validationRequired: [],
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-"));
  const repo = path.join(root, "plain");
  await mkdir(repo);
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(
    new TopologyService({
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
    }),
  );
  return {
    root,
    repo,
    store,
    engine,
    ownership,
    workspace: new TaskWorkspace(root, ownership, store),
  };
}
test("runtime reconnect continues workflow automatically through approval", async () => {
  const f = await fixture();
  let starts = 0;
  let calls = 0;
  const baseAgent = (id: string) => ({
    start: async () => ({ response: { thread: { id } } }),
    getThreadId: () => id,
  });
  const architect = {
    ...baseAgent("architect"),
    sendStructured: async () => {
      if (calls++ === 0) throw new Error("App Server exited");
      return { data: calls === 2 ? assignment : review };
    },
  };
  const client = {
    onExit: () => () => {},
    start: async () => {
      starts++;
    },
    stop: () => {},
    interruptTurn: async () => ({}),
  };
  const lifecycle = new CodexLifecycleManager(
    { id: "p" } as never,
    new OrchestratorStateStore(f.root),
    client as never,
    {
      architect,
      backend: baseAgent("backend"),
      frontend: baseAgent("frontend"),
    } as never,
  );
  const recover = lifecycle.recover.bind(lifecycle);
  lifecycle.recover = async (w, store, engine) => {
    let now = Date.now();
    return recover(
      w,
      store,
      engine,
      async (ms) => {
        now += ms;
      },
      () => now,
    );
  };
  const router = {
    getThreadId: () => "frontend",
    routeTask: async () => report,
  };
  const runner = new WorkflowRunner(
    f.engine,
    f.store,
    architect as never,
    router as never,
    f.ownership,
    f.workspace,
  );
  const runtime = new ProjectRuntime(
    "p",
    lifecycle,
    f.store,
    f.engine,
    runner,
    f.workspace,
    path.join(f.root, "execution"),
  );
  const workflow = await f.engine.create("p", "task");
  assert.equal((await runtime.execute(workflow.id)).state, "APPROVED");
  assert.equal(starts, 2);
  assert.equal(
    (await f.store.get("p", workflow.id)).threadIds.backend,
    "backend",
  );
  await assert.rejects(
    access(path.join(f.repo, ".orchestrator-repository.lock")),
  );
});
test("runtime cancellation interrupts live developer and safely releases non-Git lock", async () => {
  const f = await fixture();
  let rejectTurn: (error: Error) => void = () => {};
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let interrupted = 0;
  const workflow = await f.engine.create("p", "task");
  const client = {
    interruptTurn: async () => {
      assert.ok((await f.store.get("p", workflow.id)).cancellationRequestedAt);
      interrupted++;
      rejectTurn(new Error("cancelled"));
      return {};
    },
  };
  const architect = {
    getThreadId: () => "architect",
    sendStructured: async () => ({ data: assignment }),
  };
  const router = {
    getThreadId: () => "frontend",
    routeTask: async (_: unknown, options: TurnOptions) => {
      await options.beforeStart!();
      await options.onStarted!("frontend", "turn");
      const pending = new Promise<never>((_, reject) => {
        rejectTurn = reject;
      });
      signalStarted();
      return pending;
    },
  };
  const lifecycle = { client, start: async () => {}, stop: () => {} };
  const runner = new WorkflowRunner(
    f.engine,
    f.store,
    architect as never,
    router as never,
    f.ownership,
    f.workspace,
  );
  const runtime = new ProjectRuntime(
    "p",
    lifecycle as never,
    f.store,
    f.engine,
    runner,
    f.workspace,
    path.join(f.root, "execution"),
  );
  const execution = runtime.execute(workflow.id);
  await started;
  const cancelled = await runtime.cancel(workflow.id);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal((await execution).state, "CANCELLED");
  assert.ok(interrupted > 0);
  assert.equal(cancelled.attempts.at(-1)!.status, "CANCELLED");
  await assert.rejects(
    access(path.join(f.repo, ".orchestrator-repository.lock")),
  );
});
