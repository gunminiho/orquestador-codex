import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../codex/app-server-client";
import { ArchitectAgent } from "../agents/architect";
import { BackendAgent } from "../agents/backend";
import { FrontendAgent } from "../agents/frontend";
import { CodexLifecycleManager } from "../runtime/codex-lifecycle-manager";
import { OrchestratorStateStore } from "../state/orchestrator-state";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-app-server-"));
  const script = path.join(root, "server.cjs");
  const log = path.join(root, "events.jsonl");
  await writeFile(
    script,
    `
    const readline = require("node:readline");
    const fs = require("node:fs");
    let initialized = false, next = 0;
    function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
    readline.createInterface({input: process.stdin}).on("line", line => {
      const message = JSON.parse(line);
      fs.appendFileSync(process.argv[2], JSON.stringify(message) + "\\n");
      if (message.method === "initialized") { initialized = true; return; }
      if (message.method === "initialize") { send({id: message.id, result: {userAgent: "fixture"}}); return; }
      if (!initialized) { send({id: message.id, error: {code: -1, message: "not initialized"}}); return; }
      if (message.method.startsWith("thread/")) {
        send({id: message.id, result: {thread: {id: message.params.threadId || "thread-" + (++next)}}}); return;
      }
      if (message.method === "turn/interrupt") { send({id: message.id, result: {}}); return; }
      if (message.method === "turn/start") {
        const turn = {id: "turn-" + process.pid + "-" + (++next), status: "completed", error: null, items: []};
        send({id: message.id, result: {turn}});
        if (message.params.input[0].text !== "hang") send({method: "turn/completed", params: {threadId: message.params.threadId, turn}});
      }
    }).on("close", () => process.exit(0));
  `,
  );
  const client = new CodexAppServerClient();
  (client as any).spawnCodexAppServer = () =>
    spawn(process.execPath, [script, log], {
      windowsHide: true,
      stdio: "pipe",
    });
  return { root, log, client };
}
test("real client initializes each restarted child and restores all persisted role threads", async () => {
  const f = await fixture();
  const stateStore = new OrchestratorStateStore(f.root);
  const agents = {
    architect: new ArchitectAgent(f.client, f.root),
    backend: new BackendAgent(f.client, f.root),
    frontend: new FrontendAgent(f.client, f.root),
  };
  const manager = new CodexLifecycleManager(
    { id: "p" } as never,
    stateStore,
    f.client,
    agents,
  );
  try {
    await manager.start();
    const before = await stateStore.load();
    await manager.restart();
    assert.deepEqual(await stateStore.load(), before);
    const messages = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages.filter((m) => m.method === "initialize").length, 2);
    assert.equal(messages.filter((m) => m.method === "initialized").length, 2);
    assert.equal(
      messages.filter((m) => m.method === "thread/resume").length,
      3,
    );
  } finally {
    manager.stop();
  }
});
test("real child exit rejects an active turn and restart accepts a new turn", async () => {
  const f = await fixture();
  try {
    await f.client.start();
    const started = new Promise<void>((resolve) => {
      void f.client
        .runTurn("thread", "hang", undefined, {
          onStarted: async () => {
            resolve();
          },
        })
        .then(
          () => assert.fail("hanging turn must reject"),
          (error) => {
            assert.match(error.message, /App Server exited/);
          },
        );
    });
    await started;
    const child = (f.client as any).child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    await f.client.start();
    const result = await f.client.runTurn("thread", "complete");
    assert.equal(result.turn.status, "completed");
  } finally {
    f.client.stop();
  }
});
