import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { RateLimitScheduler } from "../workflows/rate-limit-scheduler";
import { TopologyService } from "../projects/project-topology";
import { OwnershipVerifier } from "../projects/ownership";
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
const available = {
  rateLimits: { rateLimitReachedType: null, primary: null, secondary: null },
  rateLimitsByLimitId: null,
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rate-phases-"));
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: root,
      repositories: [
        {
          id: "repo",
          root,
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
  return { root, store, engine, ownership };
}
for (const phase of ["PLANNING", "IMPLEMENTING", "REVIEWING"])
  test(`rate limit during ${phase} resumes automatically after quota availability`, async () => {
    const { store, engine, ownership } = await fixture();
    let failed = false;
    const failOnce = (current: string) => {
      if (phase === current && !failed) {
        failed = true;
        throw new Error("429 rate limit");
      }
    };
    let assigned = false;
    const architect = {
      getThreadId: () => "architect",
      sendStructured: async () => {
        failOnce(assigned ? "REVIEWING" : "PLANNING");
        if (!assigned) {
          assigned = true;
          return { data: assignment };
        }
        return { data: review };
      },
    };
    const router = {
      getThreadId: () => "frontend",
      routeTask: async () => {
        failOnce("IMPLEMENTING");
        return report;
      },
    };
    const runner = new WorkflowRunner(
      engine,
      store,
      architect as never,
      router as never,
      ownership,
    );
    let workflow = await runner.runUntilPauseOrTerminal(
      await engine.create("p", "task"),
    );
    assert.equal(workflow.state, "PAUSED_RATE_LIMIT");
    assert.equal(workflow.rateLimit!.previousState, phase);
    workflow = await new RateLimitScheduler(engine, {
      getAccountRateLimits: async () => available,
    } as never).waitForAvailability(workflow);
    assert.equal(workflow.state, phase);
    assert.equal(
      (await runner.runUntilPauseOrTerminal(workflow)).state,
      "FINALIZING_DELIVERY",
    );
  });
test("fallback backoff persists nextCheckAt before waiting", async () => {
  const { store, engine } = await fixture();
  let workflow = await engine.create("p", "task");
  workflow = await engine.pauseForError(workflow, new Error("rate limit"));
  let now = 1700000000000;
  let calls = 0;
  const sleeps: number[] = [];
  const scheduler = new RateLimitScheduler(
    engine,
    {
      getAccountRateLimits: async () =>
        ++calls < 3
          ? {
              rateLimits: {
                rateLimitReachedType: "primary",
                primary: null,
                secondary: null,
              },
            }
          : available,
    } as never,
    async (ms) => {
      const persisted = await store.get("p", workflow.id);
      assert.ok(Date.parse(persisted.rateLimit!.nextCheckAt!) >= now + ms);
      sleeps.push(ms);
      now += ms;
    },
    () => now,
  );
  await scheduler.waitForAvailability(workflow);
  assert.equal(
    sleeps.reduce((a, b) => a + b, 0),
    15000,
  );
});
test("process restart honors persisted nextCheckAt before quota query", async () => {
  const { store, engine } = await fixture();
  let workflow = await engine.pauseForError(
    await engine.create("p", "task"),
    new Error("rate limit"),
  );
  workflow = await engine.updateRateLimit(
    workflow,
    null,
    new Date(1700000009000).toISOString(),
    2,
  );
  let waited = false;
  let now = 1700000000000;
  const scheduler = new RateLimitScheduler(
    engine,
    {
      getAccountRateLimits: async () => {
        assert.equal(waited, true);
        return available;
      },
    } as never,
    async (ms) => {
      now += ms;
      waited = now === 1700000009000;
    },
    () => now,
  );
  assert.equal(
    (await scheduler.waitForAvailability(await store.get("p", workflow.id)))
      .state,
    "PENDING",
  );
});
test("cancellation during quota wait prevents resume", async () => {
  const { store, engine } = await fixture();
  let workflow = await engine.pauseForError(
    await engine.create("p", "task"),
    new Error("rate limit"),
  );
  workflow = await engine.updateRateLimit(
    workflow,
    null,
    new Date(1700000009000).toISOString(),
    2,
  );
  let queried = false;
  const scheduler = new RateLimitScheduler(
    engine,
    {
      getAccountRateLimits: async () => {
        queried = true;
        return available;
      },
    } as never,
    async () => {
      await store.requestCancellation("p", workflow.id);
    },
    () => 1700000000000,
  );
  assert.ok(
    (await scheduler.waitForAvailability(workflow)).cancellationRequestedAt,
  );
  assert.equal(queried, false);
});
