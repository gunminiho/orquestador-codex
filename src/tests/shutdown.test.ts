import assert from "node:assert/strict";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TurnOptions } from "../codex/app-server-client";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
import { ProjectRuntime } from "../runtime/project-runtime";
import { RuntimeShutdownError } from "../runtime/shutdown";
import { recoverProjectWorkflows } from "../runtime/startup";
import { TaskWorkspace } from "../workflows/task-workspace";
import { RateLimitScheduler } from "../workflows/rate-limit-scheduler";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { WorkflowStore } from "../workflows/workflow-store";

const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "shutdown-task",
  assignedTo: "frontend" as const,
  title: "shutdown",
  objective: "prove runtime checkpointing",
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
  summary: "complete",
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-shutdown-"));
  const repository = path.join(root, "plain-repository");
  await mkdir(repository);
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: root,
      repositories: [
        {
          id: "repo",
          root: repository,
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
  const workspace = new TaskWorkspace(root, ownership, store);
  return { root, repository, store, engine, ownership, workspace };
}

function runtime(
  fixture: Fixture,
  lifecycle: object,
  architect: object,
  router: object,
) {
  const runner = new WorkflowRunner(
    fixture.engine,
    fixture.store,
    architect as never,
    router as never,
    fixture.ownership,
    fixture.workspace,
  );
  return new ProjectRuntime(
    "p",
    lifecycle as never,
    fixture.store,
    fixture.engine,
    runner,
    fixture.workspace,
    path.join(fixture.root, "execution"),
  );
}

async function assertExecutionLockReleased(fixture: Fixture) {
  await assert.rejects(
    access(path.join(fixture.root, "execution", ".orchestrator-repository.lock")),
  );
}

async function resumeCheckpoint(fixture: Fixture, workflowId: string) {
  const checkpoint = await fixture.store.get("p", workflowId);
  let assignmentPending = checkpoint.state === "PLANNING";
  const resumed = runtime(
    fixture,
    {
      client: {
        processId: null,
        interruptTurn: async () => ({}),
        getAccountRateLimits: async () => ({}),
      },
      start: async () => {},
      stop: () => {},
    },
    {
      getThreadId: () => "architect",
      sendStructured: async () => {
        if (assignmentPending) {
          assignmentPending = false;
          return { data: assignment };
        }
        return { data: approval };
      },
    },
    {
      getThreadId: () => "frontend",
      routeTask: async () => report,
    },
  );
  return resumed.execute(workflowId);
}

async function shutdownDuringActiveTurn(
  role: "architect" | "developer",
  signalName: "SIGINT" | "SIGTERM",
) {
  const f = await fixture();
  const workflow = await f.engine.create("p", "shutdown test");
  let rejectTurn: (error: Error) => void = () => {};
  let turnStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    turnStarted = resolve;
  });
  let starts = 0;
  let stops = 0;
  let recoveries = 0;
  const lifecycle = {
    client: {
      processId: null,
      interruptTurn: async () => ({}),
      getAccountRateLimits: async () => ({}),
    },
    start: async () => {
      starts++;
    },
    stop: () => {
      stops++;
      rejectTurn(new Error("transport intentionally stopped"));
    },
    recover: async () => {
      recoveries++;
      throw new Error("shutdown must not recover");
    },
  };
  const blockTurn = async (options: TurnOptions, threadId: string) => {
    await options.beforeStart!();
    await options.onStarted!(threadId, "turn");
    turnStarted();
    return new Promise<never>((_, reject) => {
      rejectTurn = reject;
    });
  };
  const active = runtime(
    f,
    lifecycle,
    {
      getThreadId: () => "architect",
      sendStructured: async (_: string, _schema: unknown, options: TurnOptions) => {
        if (role !== "architect") return { data: assignment };
        return blockTurn(options, "architect");
      },
    },
    {
      getThreadId: () => "frontend",
      routeTask: async (_: unknown, options: TurnOptions) => {
        if (role !== "developer") return report;
        return blockTurn(options, "frontend");
      },
    },
  );
  const signals = new EventEmitter();
  const recovery = recoverProjectWorkflows(active, signals as never, () => {});
  await started;
  signals.emit(signalName);
  await recovery;

  const checkpoint = await f.store.get("p", workflow.id);
  assert.equal(checkpoint.cancellationRequestedAt, null);
  assert.equal(checkpoint.activeTurn, null);
  assert.ok(!["CANCELLED", "FAILED", "PAUSED_TRANSIENT"].includes(checkpoint.state));
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(recoveries, 0);
  assert.ok(
    (await f.store.recoverable("p")).some((item) => item.id === workflow.id),
  );
  if (role === "developer") {
    assert.equal(checkpoint.state, "IMPLEMENTING");
    assert.equal(checkpoint.attempts.at(-1)!.status, "INTERRUPTED");
    await assert.rejects(access(path.join(f.repository, ".orchestrator-repository.lock")));
  } else {
    assert.equal(checkpoint.state, "PLANNING");
  }
  await assertExecutionLockReleased(f);
  assert.equal((await resumeCheckpoint(f, workflow.id)).state, "APPROVED");
}

test("SIGINT checkpoints an active Architect turn without reconnecting", async () => {
  await shutdownDuringActiveTurn("architect", "SIGINT");
});

test("SIGINT checkpoints an active developer turn and releases execution locks", async () => {
  await shutdownDuringActiveTurn("developer", "SIGINT");
});

test("SIGTERM checkpoints an active developer turn without cancelling it", async () => {
  await shutdownDuringActiveTurn("developer", "SIGTERM");
});

test("shutdown aborts a persisted rate-limit wait before starting the App Server", async () => {
  const f = await fixture();
  const workflow = await f.engine.create("p", "rate wait");
  await f.store.save({
    ...workflow,
    state: "PAUSED_RATE_LIMIT",
    rateLimit: {
      pausedAt: new Date().toISOString(),
      retryAfter: null,
      snapshot: null,
      previousState: "PENDING",
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      pendingAction: "plan",
      agentRole: null,
    },
  });
  let waitStarted: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    waitStarted = resolve;
  });
  let starts = 0;
  const active = runtime(
    f,
    {
      client: {
        processId: null,
        interruptTurn: async () => ({}),
        getAccountRateLimits: async () => ({}),
      },
      start: async () => {
        starts++;
      },
      stop: () => {},
    },
    {},
    {},
  );
  Object.defineProperty(active, "scheduler", {
    value: new RateLimitScheduler(
      f.engine,
      { getAccountRateLimits: async () => ({}) } as never,
      async () => {
        waitStarted();
        return new Promise<void>(() => {});
      },
    ),
  });
  const execution = active.execute(workflow.id);
  await waiting;
  await active.shutdown();
  assert.equal((await execution).state, "PAUSED_RATE_LIMIT");
  assert.equal(starts, 0);
  await assertExecutionLockReleased(f);
});

test("shutdown aborts transient backoff without restarting the App Server", async () => {
  const f = await fixture();
  const workflow = await f.engine.create("p", "transient wait");
  await f.store.save({
    ...workflow,
    state: "PAUSED_TRANSIENT",
    transient: {
      previousState: "PLANNING",
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
    },
  });
  let waiting: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let starts = 0;
  const active = runtime(
    f,
    {
      client: {
        processId: null,
        interruptTurn: async () => ({}),
        getAccountRateLimits: async () => ({}),
      },
      start: async () => {
        starts++;
      },
      stop: () => {},
      recover: async (
        _workflow: unknown,
        _store: unknown,
        _engine: unknown,
        _sleep: unknown,
        _now: unknown,
        signal: AbortSignal,
      ) => {
        waiting();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new RuntimeShutdownError()),
            { once: true },
          );
        });
      },
    },
    {},
    {},
  );
  const execution = active.execute(workflow.id);
  await entered;
  await active.shutdown();
  assert.equal((await execution).state, "PAUSED_TRANSIENT");
  assert.equal(starts, 0);
  await assertExecutionLockReleased(f);
});
