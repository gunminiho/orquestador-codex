import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexLifecycleManager } from "../runtime/codex-lifecycle-manager";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { ArchitectAgent } from "../agents/architect";
import { BackendAgent } from "../agents/backend";
import { FrontendAgent } from "../agents/frontend";

test("unavailable restarted server cannot resume paused workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reconnect-failure-"));
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  const workflow = await engine.pauseForError(
    await engine.create("p", "task"),
    new Error("App Server exited"),
  );
  const client = {
    onExit: () => () => {},
    stop: () => {},
    start: async () => {
      throw new Error("App Server exited");
    },
  };
  const agent = {
    start: async () =>
      assert.fail("thread restoration must wait for initialization"),
  };
  const manager = new CodexLifecycleManager(
    { id: "p" } as never,
    new OrchestratorStateStore(root),
    client as never,
    { architect: agent, backend: agent, frontend: agent } as never,
  );
  await assert.rejects(
    manager.recover(
      workflow,
      store,
      engine,
      async () => {},
      () => Date.parse(workflow.transient!.retryAt),
    ),
    /exited/,
  );
  assert.equal((await store.get("p", workflow.id)).state, "PAUSED_TRANSIENT");
});

test("legitimate ghost replacements persist for the next process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ghost-persist-"));
  const stateStore = new OrchestratorStateStore(root);
  await stateStore.save({
    version: 2,
    projects: { p: { agents: { architect: { threadId: "old" } } } },
  });
  const client = {
    onExit: () => () => {},
    stop: () => {},
    start: async () => {},
  };
  const agent = {
    start: async () => ({ response: { thread: { id: "replacement" } } }),
  };
  const manager = new CodexLifecycleManager(
    { id: "p" } as never,
    stateStore,
    client as never,
    { architect: agent, backend: agent, frontend: agent } as never,
  );
  await manager.start();
  assert.equal(
    (await new OrchestratorStateStore(root).load()).projects.p!.agents
      .architect!.threadId,
    "replacement",
  );
});

test("server exit persists transient retry; restart initializes and restores every thread before resuming", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reconnect-"));
  const state = new OrchestratorStateStore(root);
  await state.save({
    version: 2,
    projects: {
      p: {
        agents: {
          architect: { threadId: "a" },
          backend: { threadId: "b" },
          frontend: { threadId: "f" },
        },
      },
    },
  });
  const events: string[] = [];
  const client = {
    onExit: () => () => {},
    stop: () => events.push("stop"),
    start: async () => {
      events.push("start", "initialize");
    },
  };
  const agent = (role: string, id: string) => ({
    start: async (thread: string) => {
      assert.equal(thread, id);
      events.push(role);
      return { response: { thread: { id } } };
    },
    getThreadId: () => id,
  });
  const manager = new CodexLifecycleManager(
    { id: "p" } as never,
    state,
    client as never,
    {
      architect: agent("architect", "a"),
      backend: agent("backend", "b"),
      frontend: agent("frontend", "f"),
    } as never,
  );
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  let workflow = await engine.create("p", "task");
  workflow = await engine.transition(workflow, "PLANNING", "test");
  workflow = await engine.pauseForError(
    workflow,
    new Error("App Server exited"),
  );
  assert.equal(workflow.state, "PAUSED_TRANSIENT");
  const retryAt = Date.parse(workflow.transient!.retryAt);
  let now = retryAt - 2000;
  const recovered = await manager.recover(
    workflow,
    store,
    engine,
    async (ms) => {
      assert.deepEqual(events, []);
      now += ms;
    },
    () => now,
  );
  assert.equal(now, retryAt);
  assert.deepEqual(events, [
    "stop",
    "start",
    "initialize",
    "architect",
    "backend",
    "frontend",
  ]);
  assert.equal(recovered.state, "PLANNING");
  assert.deepEqual(recovered.threadIds, {
    architect: "a",
    backend: "b",
    frontend: "f",
  });
});

for (const Agent of [ArchitectAgent, BackendAgent, FrontendAgent]) {
  test(`${Agent.name} replaces only a no-rollout ghost thread`, async () => {
    let created = 0;
    const client = {
      resumeThread: async () => {
        throw new Error("no rollout found for thread id old");
      },
      startThread: async () => {
        created++;
        return { thread: { id: "replacement" } };
      },
      runTurn: async () => ({}),
    };
    const agent = new Agent(client as never, os.tmpdir());
    await agent.start("old");
    assert.equal(created, 1);
    assert.equal(agent.getThreadId(), "replacement");
  });
  test(`${Agent.name} preserves thread on other resume failures`, async () => {
    let created = 0;
    const client = {
      resumeThread: async () => {
        throw new Error("App Server exited");
      },
      startThread: async () => {
        created++;
      },
    };
    await assert.rejects(
      new Agent(client as never, os.tmpdir()).start("old"),
      /exited/,
    );
    assert.equal(created, 0);
  });
}
test("repeated transient failures retain original checkpoint with bounded exponential backoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backoff-"));
  const engine = new WorkflowEngine(new WorkflowStore(root));
  let w = await engine.create("p", "task");
  w = await engine.transition(w, "PLANNING", "test");
  for (let i = 0; i < 12; i++)
    w = await engine.pauseForError(w, new Error("App Server exited"));
  assert.equal(w.transient!.previousState, "PLANNING");
  assert.equal(w.transient!.attempts, 12);
  assert.ok(Date.parse(w.transient!.retryAt) - Date.now() <= 300000);
});
