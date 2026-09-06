import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  RepositoryLock,
  processAlive,
  type RepositoryLease,
} from "../workflows/repository-lock";
import { WorkflowCancellation } from "./workflow-cancellation";
import { CodexLifecycleManager } from "./codex-lifecycle-manager";
import { TeamRouter } from "../orchestration/team-router";
import { OwnershipVerifier } from "../projects/ownership";
import { ProjectRegistryStore } from "../projects/project-registry";
import { TopologyService } from "../projects/project-topology";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import { RateLimitScheduler } from "../workflows/rate-limit-scheduler";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { WorkflowStore } from "../workflows/workflow-store";
import { TaskWorkspace } from "../workflows/task-workspace";
import { isTerminal } from "../workflows/workflow-schema";

export class ProjectRuntime {
  readonly scheduler: RateLimitScheduler;
  readonly cancellation: WorkflowCancellation;
  private readonly executionLock = new RepositoryLock(
    () => this.client.processId,
  );
  private executionLease: RepositoryLease | null = null;
  get client() {
    return this.lifecycle.client;
  }

  constructor(
    readonly projectId: string,
    readonly lifecycle: CodexLifecycleManager,
    readonly store: WorkflowStore,
    readonly engine: WorkflowEngine,
    readonly runner: WorkflowRunner,
    readonly workspace: TaskWorkspace,
    private readonly executionRoot: string,
  ) {
    this.scheduler = new RateLimitScheduler(engine, lifecycle.client);
    this.cancellation = new WorkflowCancellation(
      store,
      engine,
      lifecycle.client,
      (workflow) => workspace.cleanup(workflow),
    );
  }

  async execute(workflowId: string) {
    await mkdir(this.executionRoot, { recursive: true });
    this.executionLease = await this.executionLock.acquire({
      projectId: this.projectId,
      repositoryId: "runtime",
      physicalRoot: this.executionRoot,
      workflowId,
      taskId: "runtime",
      attemptId: crypto.randomUUID(),
    });
    let checking = false;
    const watcher = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.store
        .get(this.projectId, workflowId)
        .then(async (workflow) => {
          if (
            workflow.cancellationRequestedAt &&
            !isTerminal(workflow.state) &&
            workflow.activeTurn?.turnId
          ) {
            await this.client.interruptTurn(
              workflow.activeTurn.threadId,
              workflow.activeTurn.turnId,
            );
          }
        })
        .catch(() => {
          /* The execute loop retries durable cancellation. */
        })
        .finally(() => {
          checking = false;
        });
    }, 100);
    try {
      return await this.executeLoop(workflowId);
    } finally {
      clearInterval(watcher);
      if (this.executionLease)
        await this.executionLock.release(this.executionLease);
      this.executionLease = null;
    }
  }

  private async executeLoop(workflowId: string) {
    for (;;) {
      let workflow = await this.store.get(this.projectId, workflowId);
      if (isTerminal(workflow.state)) {
        return this.finalizeTerminal(workflow);
      }
      if (workflow.cancellationRequestedAt) {
        if (workflow.activeTurn?.turnId) await this.lifecycle.start();
        return this.cancellation.cancel(this.projectId, workflowId);
      }
      if (workflow.state === "FINALIZING_DELIVERY") {
        return this.finalizeDelivery(workflow);
      }
      try {
        if (workflow.state === "PAUSED_TRANSIENT") {
          await this.lifecycle.recover(workflow, this.store, this.engine);
          continue;
        }
        await this.lifecycle.start();
        if (this.executionLease)
          this.executionLease = await this.executionLock.acquire(
            this.executionLease,
          );
        if (workflow.activeTurn?.turnId) {
          await this.client.interruptTurn(
            workflow.activeTurn.threadId,
            workflow.activeTurn.turnId,
          );
          workflow = await this.store.get(this.projectId, workflowId);
          workflow = {
            ...workflow,
            activeTurn: null,
            attempts: workflow.attempts.map((a) =>
              a.status === "RUNNING"
                ? { ...a, status: "INTERRUPTED" as const }
                : a,
            ),
          };
          await this.store.save(workflow);
        }
        if (workflow.state === "PAUSED_RATE_LIMIT") {
          await this.scheduler.waitForAvailability(workflow);
          continue;
        }
        workflow = await this.runner.runUntilPauseOrTerminal(workflow);
      } catch (error) {
        workflow = await this.store.get(this.projectId, workflowId);
        if (!isTerminal(workflow.state) && !workflow.cancellationRequestedAt)
          workflow = await this.engine.pauseForError(workflow, error);
      }
      if (workflow.cancellationRequestedAt)
        return this.cancellation.cancel(this.projectId, workflowId);
      if (
        workflow.state === "PAUSED_RATE_LIMIT" ||
        workflow.state === "PAUSED_TRANSIENT"
      )
        continue;
      if (workflow.state === "FINALIZING_DELIVERY") {
        return this.finalizeDelivery(workflow);
      }
      if (isTerminal(workflow.state)) return this.finalizeTerminal(workflow);
      return workflow;
    }
  }

  async cancel(workflowId: string) {
    let workflow = await this.store.requestCancellation(
      this.projectId,
      workflowId,
    );
    // A separate CLI process signals the owner through durable intent. Only that
    // process can interrupt its live stdio transport and safely clean its resources.
    for (;;) {
      if (isTerminal(workflow.state)) return workflow;
      let owner: RepositoryLease | null = null;
      try {
        owner = await this.executionLock.inspect(this.executionRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        !owner ||
        owner.workflowId !== workflowId ||
        !processAlive(owner.owner.pid)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      workflow = await this.store.get(this.projectId, workflowId);
    }
    if (workflow.activeTurn?.turnId) await this.lifecycle.start();
    return this.cancellation.cancel(this.projectId, workflowId);
  }

  async integrate(workflowId: string) {
    const workflow = await this.store.get(this.projectId, workflowId);
    return this.workspace.integrateApproved(workflow);
  }

  private async finalizeTerminal(
    workflow: Awaited<ReturnType<WorkflowStore["get"]>>,
  ) {
    if (workflow.state === "APPROVED") {
      const delivered = await this.workspace.finalizeApproved(workflow);
      await this.workspace.cleanup(delivered);
      return delivered;
    }
    await this.workspace.cleanup(workflow);
    return workflow;
  }

  /** Finalization is recoverable until every result is durable and cleanup succeeds. */
  private async finalizeDelivery(
    workflow: Awaited<ReturnType<WorkflowStore["get"]>>,
  ) {
    const delivered = await this.workspace.finalizeApproved(workflow);
    await this.workspace.cleanup(delivered);
    return this.engine.completeApprovedDelivery(delivered);
  }

  async stop() {
    this.lifecycle.stop();
  }

  static async create(
    root: string,
    projectId: string,
  ): Promise<ProjectRuntime> {
    const project = await new ProjectRegistryStore(root).getProject(projectId);
    const lifecycle = new CodexLifecycleManager(
      project,
      new OrchestratorStateStore(root),
    );
    const store = new WorkflowStore(root);
    const engine = new WorkflowEngine(store);
    const ownership = new OwnershipVerifier(
      new TopologyService(project.topology),
    );
    const workspace = new TaskWorkspace(
      root,
      ownership,
      store,
      () => lifecycle.client.processId,
    );
    const runner = new WorkflowRunner(
      engine,
      store,
      lifecycle.architect,
      new TeamRouter(lifecycle.backend, lifecycle.frontend),
      ownership,
      workspace,
    );
    return new ProjectRuntime(
      project.id,
      lifecycle,
      store,
      engine,
      runner,
      workspace,
      path.join(root, ".orchestrator", "runtime", project.id),
    );
  }
}
