import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../codex/app-server-client";
function fixture() {
  const client = new CodexAppServerClient();
  // Test only the transport boundary: no App Server or external project is started.
  const internal = client as any;
  internal.request = async () => ({ turn: { id: "turn" } });
  const complete = () =>
    internal.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "completed", error: null, items: [] },
      },
    });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { client, internal, complete, tick };
}
test("production turn has no default timeout", async () => {
  const f = fixture();
  let settled = false;
  const turn = f.client.runTurn("thread", "task").then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  f.complete();
  await turn;
});
test("App Server exit rejects waiter", async () => {
  const f = fixture();
  const turn = f.client.runTurn("thread", "task");
  await f.tick();
  for (const listener of f.internal.exitListeners)
    listener(new Error("App Server exited"));
  await assert.rejects(turn, /exited/);
  assert.equal(f.internal.turnWaiters.size, 0);
});
test("stop rejects waiter even without live child", async () => {
  const f = fixture();
  const turn = f.client.runTurn("thread", "task");
  await f.tick();
  f.client.stop();
  await assert.rejects(turn, /stopped/);
  assert.equal(f.internal.notificationListeners.size, 0);
});
test("interrupt cleans notification and exit listener state", async () => {
  const f = fixture();
  const turn = f.client.runTurn("thread", "task");
  await f.tick();
  await f.client.interruptTurn("thread", "turn");
  await assert.rejects(turn, /cancelled/);
  assert.equal(f.internal.notificationListeners.size, 0);
  assert.equal(f.internal.exitListeners.size, 0);
});
test("duplicate completion and late exit settle once", async () => {
  const f = fixture();
  let settled = 0;
  const turn = f.client.runTurn("thread", "task").then(
    () => settled++,
    () => settled++,
  );
  await f.tick();
  f.complete();
  f.complete();
  f.client.stop();
  await turn;
  assert.equal(settled, 1);
  assert.equal(f.internal.turnWaiters.size, 0);
});
test("late completion after interrupt cannot recreate cached state", async () => {
  const f = fixture();
  const turn = f.client.runTurn("thread", "task");
  await f.tick();
  await f.client.interruptTurn("thread", "turn");
  await assert.rejects(turn);
  f.complete();
  assert.equal(f.internal.completedTurns.size, 0);
});
test("explicit diagnostic timeout rejects and cleans listener", async () => {
  const f = fixture();
  await assert.rejects(
    f.client.runTurn("thread", "task", undefined, { timeoutMs: 5 }),
    /Timed out/,
  );
  assert.equal(f.internal.notificationListeners.size, 0);
});
test("turn-start persistence failure interrupts the just-started turn", async () => {
  const f = fixture();
  let interrupted = false;
  f.internal.request = async (method: string) => {
    if (method === "turn/interrupt") interrupted = true;
    return { turn: { id: "turn" } };
  };
  await assert.rejects(
    f.client.runTurn("thread", "task", undefined, {
      onStarted: async () => {
        throw new Error("cancelled");
      },
    }),
    /cancelled/,
  );
  assert.equal(interrupted, true);
  assert.equal(f.internal.turnWaiters.size, 0);
});
test("turn/start carries actual cwd and writable-root sandbox", async () => {
  const f = fixture();
  let params: any;
  f.internal.request = async (_: string, value: any) => {
    params = value;
    return { turn: { id: "turn" } };
  };
  const turn = f.client.runTurn("thread", "task", undefined, {
    cwd: "fixture-worktree",
    writableRoots: ["fixture-worktree"],
  });
  await f.tick();
  f.complete();
  await turn;
  assert.equal(params.cwd, "fixture-worktree");
  assert.deepEqual(params.sandboxPolicy.writableRoots, ["fixture-worktree"]);
  assert.equal(params.sandboxPolicy.type, "workspaceWrite");
});
