import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { recoverProjectWorkflows } from "../runtime/startup";
import { newWorkflow } from "../workflows/workflow-schema";

test("startup installs shutdown handlers before recoverable workflow discovery", async () => {
  const signals = new EventEmitter();
  const events: string[] = [];
  const workflow = newWorkflow("p", "recover");
  await recoverProjectWorkflows(
    {
      projectId: "p",
      store: {
        recoverable: async () => {
          assert.equal(signals.listenerCount("SIGINT"), 1);
          assert.equal(signals.listenerCount("SIGTERM"), 1);
          signals.emit("SIGINT");
          return [workflow];
        },
      },
      execute: async () => {
        events.push("execute");
        return workflow;
      },
      stop: () => {
        events.push("stop");
      },
    },
    signals as never,
    (message) => events.push(message),
  );
  assert.deepEqual(events, ["stop"]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("startup executes recoverable workflows after handlers are installed", async () => {
  const signals = new EventEmitter();
  const events: string[] = [];
  const workflow = newWorkflow("p", "recover", "workflow");
  await recoverProjectWorkflows(
    {
      projectId: "p",
      store: { recoverable: async () => [workflow] },
      execute: async (id) => {
        events.push(`execute:${id}`);
        return { ...workflow, state: "APPROVED" };
      },
      stop: () => {
        events.push("stop");
      },
    },
    signals as never,
    (message) => events.push(message),
  );
  assert.deepEqual(events, ["execute:workflow", "workflow: APPROVED"]);
});
