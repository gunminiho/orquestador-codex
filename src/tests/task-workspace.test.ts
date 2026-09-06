import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { gitFixture } from "./fixtures";
import { TaskWorkspace } from "../workflows/task-workspace";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
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
  filesChanged: ["repo:modified.txt"],
  testsChanged: [],
  validations: [],
  risks: [],
  blockers: [],
  notes: [],
};
const approved = {
  type: "REVIEW_RESULT",
  taskId: "t",
  reviewedAgent: "frontend",
  decision: "APPROVED",
  summary: "ok",
  findings: [],
  requiredChanges: [],
  validationRequired: [],
};
const repository = (id: string, root: string) => ({
  id,
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
});

test("correction includes requiredChanges findings validationRequired and reuses worktree cwd", async () => {
  const f = await gitFixture();
  const store = new WorkflowStore(f.root);
  const engine = new WorkflowEngine(store);
  const ownership = new OwnershipVerifier(
    new TopologyService({
      version: 1,
      workspaceRoot: f.root,
      repositories: [repository("repo", f.repo)],
      agentWorkspaces: {},
    }),
  );
  const workspace = new TaskWorkspace(f.root, ownership, store);
  let reviews = 0;
  const cwds: string[] = [];
  const prompts: string[] = [];
  const architect = {
    getThreadId: () => "architect",
    sendStructured: async () => ({
      data:
        reviews++ === 0
          ? {
              ...approved,
              decision: "CHANGES_REQUESTED",
              requiredChanges: ["fix edge case"],
              findings: ["missing guard"],
              validationRequired: ["npm test"],
            }
          : approved,
    }),
  };
  const router = {
    getThreadId: () => "same",
    routeTask: async (task: typeof assignment, options: TurnOptions) => {
      cwds.push(options.cwd!);
      prompts.push(task.context);
      await writeFile(
        path.join(options.cwd!, "modified.txt"),
        "implementation " + cwds.length,
      );
      return report;
    },
  };
  let workflow = await engine.transition(
    await engine.create("p", "task"),
    "PLANNING",
    "test",
  );
  workflow = await engine.assign(workflow, assignment);
  workflow = await new WorkflowRunner(
    engine,
    store,
    architect as never,
    router as never,
    ownership,
    workspace,
  ).runUntilPauseOrTerminal(workflow);
  assert.equal(workflow.state, "FINALIZING_DELIVERY");
  assert.equal(cwds.length, 2);
  assert.equal(cwds[0], cwds[1]);
  for (const required of [
    "requiredChanges",
    "findings",
    "validationRequired",
    "fix edge case",
    "missing guard",
    "npm test",
  ])
    assert.ok(prompts[1]!.includes(required));
  assert.equal(workflow.attempts.at(-1)!.correctionAttempt, 1);
  assert.equal(
    await readFile(path.join(f.repo, "modified.txt"), "utf8"),
    "original\n",
  );
  await workspace.cleanup(await workspace.finalizeApproved(workflow));
});

for (const hybrid of [false, true])
  test(`${hybrid ? "hybrid" : "multi-repo"} task maps every repository to an independent execution root`, async () => {
    const a = await gitFixture();
    const b = await gitFixture();
    const nonGit = path.join(a.root, "plain");
    await mkdir(nonGit);
    const repos = [
      repository("first", a.repo),
      repository("second", b.repo),
      ...(hybrid ? [repository("plain", nonGit)] : []),
    ];
    const store = new WorkflowStore(a.root);
    const engine = new WorkflowEngine(store);
    const ownership = new OwnershipVerifier(
      new TopologyService({
        version: 1,
        workspaceRoot: a.root,
        repositories: repos,
        agentWorkspaces: { frontend: { repositoryId: "second" } },
      }),
    );
    const workspace = new TaskWorkspace(a.root, ownership, store);
    let workflow = await engine.transition(
      await engine.create("p", "task"),
      "PLANNING",
      "test",
    );
    workflow = await engine.assign(workflow, {
      ...assignment,
      allowedScopes: repos.map((r) => ({
        repositoryId: r.id,
        patterns: ["**"],
      })),
    });
    const prepared = await workspace.prepare(workflow);
    assert.equal(prepared.roots.length, repos.length);
    assert.equal(prepared.cwd, prepared.roots[1]);
    assert.notEqual(prepared.roots[0], a.repo);
    assert.notEqual(prepared.roots[1], b.repo);
    assert.equal(new Set(prepared.roots).size, repos.length);
    if (hybrid) {
      await writeFile(path.join(nonGit, "new.txt"), "new");
      const result = await prepared.ownership.validateTaskDelta(
        prepared.workflow.assignment!,
        { ...report, filesChanged: ["plain:new.txt"] },
        prepared.workflow.baselines,
      );
      assert.equal(result.source, "mixed");
      assert.equal(result.ok, true);
    }
    await workspace.cleanup(prepared.workflow);
  });
