import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowStore } from "../workflows/workflow-store";
import { TaskWorkspace } from "../workflows/task-workspace";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService } from "../projects/project-topology";
import type { TurnOptions } from "../codex/app-server-client";
const exec = promisify(execFile);
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
  filesChanged: ["repo:app/file.txt"],
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

for (const changes of [true, false])
  test(`interrupted implementation ${changes ? "REPORT/CONTINUE reuses thread and cwd without replay" : "creates explicit safe retry without changes"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reconcile-"));
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, "app"), { recursive: true });
    const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
    await git("init");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(repo, "app/file.txt"), "original");
    await git("add", ".");
    await git("commit", "-m", "fixture");
    const store = new WorkflowStore(root);
    const engine = new WorkflowEngine(store);
    const ownership = new OwnershipVerifier(
      new TopologyService({
        version: 1,
        workspaceRoot: root,
        repositories: [
          {
            id: "repo",
            root: repo,
            metadata: {},
            ownership: [
              {
                pattern: "app/**",
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
    let calls = 0;
    const cwds: string[] = [];
    const prompts: string[] = [];
    const router = {
      getThreadId: () => "same-thread",
      routeTask: async (task: typeof assignment, options: TurnOptions) => {
        cwds.push(options.cwd!);
        prompts.push(task.context);
        await options.beforeStart!();
        await options.onStarted!("same-thread", `turn-${calls}`);
        if (calls++ === 0) {
          if (changes)
            await writeFile(
              path.join(options.cwd!, "app/file.txt"),
              "existing implementation",
            );
          throw new Error("429 rate limit");
        }
        if (changes)
          assert.equal(
            await readFile(path.join(options.cwd!, "app/file.txt"), "utf8"),
            "existing implementation",
          );
        else
          await writeFile(
            path.join(options.cwd!, "app/file.txt"),
            "retry implementation",
          );
        return report;
      },
    };
    const architect = {
      getThreadId: () => "architect",
      sendStructured: async () => ({ data: approved }),
    };
    let workflow = await engine.create("p", "task");
    workflow = await engine.transition(workflow, "PLANNING", "test");
    workflow = await engine.assign(workflow, assignment);
    const runner = new WorkflowRunner(
      engine,
      store,
      architect as never,
      router as never,
      ownership,
      workspace,
    );
    workflow = await runner.runUntilPauseOrTerminal(workflow);
    assert.equal(workflow.state, "PAUSED_RATE_LIMIT");
    const first = workflow.attempts[0]!.attemptId;
    workflow = await engine.resumePaused(workflow);
    const restoredRunner = new WorkflowRunner(
      engine,
      new WorkflowStore(root),
      architect as never,
      router as never,
      ownership,
      new TaskWorkspace(root, ownership, new WorkflowStore(root)),
    );
    workflow = await restoredRunner.runUntilPauseOrTerminal(workflow);
    assert.equal(workflow.state, "APPROVED");
    assert.equal(cwds[0], cwds[1]);
    assert.notEqual(cwds[0], repo);
    assert.equal(
      await readFile(path.join(repo, "app/file.txt"), "utf8"),
      "original",
    );
    assert.match(
      prompts[1]!,
      changes ? /REPORT\/CONTINUE.*Do NOT redo/ : /SAFE RETRY/,
    );
    assert.equal(workflow.attempts.at(-1)!.threadId, "same-thread");
    assert.equal(workflow.attempts.at(-1)!.attemptId === first, changes);
    assert.equal(workflow.ownershipValidations.at(-1)!.source, "git");
    await workspace.cleanup(workflow);
  });
