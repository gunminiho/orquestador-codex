import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RateLimitScheduler } from "../workflows/rate-limit-scheduler";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowStore } from "../workflows/workflow-store";

test("normalizes official resetsAt Unix seconds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scheduler-"));
  const engine = new WorkflowEngine(new WorkflowStore(root));
  let workflow = await engine.create("project", "request", "rate-reset");
  workflow = await engine.transition(workflow, "PLANNING", "start");
  workflow = await engine.pauseForError(workflow, new Error("rate limit"));
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  let calls = 0;
  const limited = {
    rateLimits: {
      rateLimitReachedType: "primary",
      primary: {
        resetsAt: 1_700_000_120,
        usedPercent: 100,
        windowDurationMins: 1,
      },
      secondary: null,
    },
    rateLimitsByLimitId: null,
  };
  const available = {
    rateLimits: { rateLimitReachedType: null, primary: null, secondary: null },
    rateLimitsByLimitId: null,
  };
  const scheduler = new RateLimitScheduler(
    engine,
    {
      getAccountRateLimits: async () => (++calls === 1 ? limited : available),
    } as never,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    () => now,
  );
  const result = await scheduler.waitForAvailability(workflow);
  assert.equal(result.state, "PLANNING");
  assert.equal(
    sleeps.reduce((a, b) => a + b, 0),
    120_000,
  );
});
