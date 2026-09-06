import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowCancellation } from "../runtime/workflow-cancellation";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cancel-"));
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  let workflow = await engine.create("p", "task");
  workflow = await engine.transition(workflow, "PLANNING", "test");
  return { root, store, engine, workflow };
}
test("active turn interrupted after durable cancellation intent and before cleanup", async () => {
  const { store, engine, workflow } = await fixture();
  workflow.activeTurn = {
    workflowId: workflow.id,
    attemptId: "a",
    role: "backend",
    threadId: "thread",
    turnId: "turn",
    startedAt: workflow.createdAt,
  };
  await store.save(workflow);
  const events: string[] = [];
  const client = {
    interruptTurn: async (thread: string, turn: string) => {
      assert.ok((await store.get("p", workflow.id)).cancellationRequestedAt);
      assert.equal(thread, "thread");
      assert.equal(turn, "turn");
      events.push("interrupt");
      return {};
    },
  };
  const cancellation = new WorkflowCancellation(
    store,
    engine,
    client,
    async () => {
      events.push("cleanup");
    },
  );
  assert.equal(
    (await cancellation.cancel("p", workflow.id)).state,
    "CANCELLED",
  );
  assert.deepEqual(events, ["interrupt", "cleanup"]);
});
for (const late of ["TASK_REPORT", "REVIEW_RESULT", "turn completion"])
  test(`CANCELLED plus late ${late} remains CANCELLED`, async () => {
    const { root, store, engine, workflow } = await fixture();
    await new WorkflowCancellation(
      store,
      engine,
      { interruptTurn: async () => ({}) },
      async () => {},
    ).cancel("p", workflow.id);
    await store.save({
      ...workflow,
      state:
        late === "TASK_REPORT"
          ? "READY_FOR_REVIEW"
          : late === "REVIEW_RESULT"
            ? "APPROVED"
            : "IMPLEMENTING",
    });
    assert.equal(
      (await new WorkflowStore(root).get("p", workflow.id)).state,
      "CANCELLED",
    );
  });
test("failed interrupt preserves intent and prevents premature cleanup", async () => {
  const { store, engine, workflow } = await fixture();
  workflow.activeTurn = {
    workflowId: workflow.id,
    attemptId: null,
    role: "architect",
    threadId: "t",
    turnId: "u",
    startedAt: workflow.createdAt,
  };
  await store.save(workflow);
  let cleaned = false;
  const cancellation = new WorkflowCancellation(
    store,
    engine,
    {
      interruptTurn: async () => {
        throw new Error("App Server exited");
      },
    },
    async () => {
      cleaned = true;
    },
  );
  await assert.rejects(cancellation.cancel("p", workflow.id), /exited/);
  assert.equal(cleaned, false);
  assert.ok((await store.get("p", workflow.id)).cancellationRequestedAt);
});
test("concurrent cancellation requests persist one complete intent", async () => {
  const { store, workflow } = await fixture();
  const requests = await Promise.all(
    Array.from({ length: 10 }, () =>
      store.requestCancellation("p", workflow.id),
    ),
  );
  assert.equal(new Set(requests.map((w) => w.cancellationRequestedAt)).size, 1);
});
test("same-workflow cancellation deduplicates the cleanup operation", async () => {
  const { store, engine, workflow } = await fixture();
  let cleanups = 0;
  const cancellation = new WorkflowCancellation(
    store,
    engine,
    { interruptTurn: async () => ({}) },
    async () => {
      cleanups += 1;
    },
  );
  const [first, second] = await Promise.all([
    cancellation.cancel("p", workflow.id),
    cancellation.cancel("p", workflow.id),
  ]);
  assert.equal(first.id, workflow.id);
  assert.equal(second.id, workflow.id);
  assert.equal(cleanups, 1);
});
test("different workflow cancellations remain independent", async () => {
  const { store, engine, workflow } = await fixture();
  const other = await engine.create("p", "other task");
  const cleaned: string[] = [];
  const cancellation = new WorkflowCancellation(
    store,
    engine,
    { interruptTurn: async () => ({}) },
    async (current) => {
      cleaned.push(current.id);
    },
  );
  const [first, second] = await Promise.all([
    cancellation.cancel("p", workflow.id),
    cancellation.cancel("p", other.id),
  ]);
  assert.equal(first.id, workflow.id);
  assert.equal(second.id, other.id);
  assert.deepEqual(new Set(cleaned), new Set([workflow.id, other.id]));
});
test("late error cannot replace cancelled state", async () => {
  const { store, engine, workflow } = await fixture();
  await engine.cancel(workflow);
  assert.equal(
    (await engine.pauseForError(workflow, new Error("429 rate limit"))).state,
    "CANCELLED",
  );
  assert.equal((await store.get("p", workflow.id)).state, "CANCELLED");
});
