import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TopologyService } from "../projects/project-topology";
import { OwnershipVerifier } from "../projects/ownership";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { WorkflowStore } from "../workflows/workflow-store";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-"));
  await mkdir(path.join(root, "web", "app"), { recursive: true });
  return root;
}
function topology(root: string) {
  return {
    version: 1 as const,
    workspaceRoot: root,
    repositories: [
      {
        id: "web",
        root: path.join(root, "web"),
        metadata: {},
        ownership: [
          {
            pattern: "app/**",
            readableBy: ["architect", "frontend"],
            writableBy: ["frontend"],
            architectControlled: false,
          },
          {
            pattern: "**",
            readableBy: ["architect"],
            writableBy: [],
            architectControlled: true,
          },
        ],
      },
    ],
    agentWorkspaces: {},
  };
}
const assignment = {
  type: "TASK_ASSIGNMENT" as const,
  taskId: "t",
  assignedTo: "frontend" as const,
  title: "x",
  objective: "x",
  context: "",
  requirements: [],
  acceptanceCriteria: [],
  allowedPaths: ["app/**"],
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
  filesChanged: ["web:app/x.tsx"],
  testsChanged: [],
  validations: [],
  risks: [],
  blockers: [],
  notes: [],
};
test("runner advances all executable states", async () => {
  const root = await fixture();
  const store = new WorkflowStore(root);
  const engine = new WorkflowEngine(store);
  let calls = 0;
  const architect = {
    getThreadId: () => "architect",
    sendStructured: async () => ({
      data:
        calls++ === 0
          ? assignment
          : {
              type: "REVIEW_RESULT",
              taskId: "t",
              reviewedAgent: "frontend",
              decision: "APPROVED",
              summary: "ok",
              findings: [],
              requiredChanges: [],
              validationRequired: [],
            },
    }),
  };
  const router = {
    getThreadId: () => "frontend",
    routeTask: async () => report,
  };
  const runner = new WorkflowRunner(
    engine,
    store,
    architect as never,
    router as never,
    new OwnershipVerifier(new TopologyService(topology(root))),
  );
  const result = await runner.runUntilPauseOrTerminal(
    await engine.create("project", "x", "loop"),
  );
  assert.equal(result.state, "FINALIZING_DELIVERY");
});
test("rate limit remains paused and ids are safe", async () => {
  const root = await fixture();
  const e = new WorkflowEngine(new WorkflowStore(root));
  let w = await e.create("project", "x", "safe");
  w = await e.transition(w, "PLANNING", "x");
  w = await e.pauseForError(w, new Error("429 rate limit"));
  assert.equal(w.state, "PAUSED_RATE_LIMIT");
  await assert.rejects(() => e.create("../x", "x", "safe"));
});
