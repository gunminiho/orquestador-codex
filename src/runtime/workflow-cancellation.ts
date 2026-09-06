import type { CodexAppServerClient } from "../codex/app-server-client";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { isTerminal, type Workflow } from "../workflows/workflow-schema";

/** Cancellation intent is durable before any interrupt or cleanup side effect. */
export class WorkflowCancellation {
  private pending: Promise<Workflow> | null = null;
  constructor(
    private readonly store: WorkflowStore,
    private readonly engine: WorkflowEngine,
    private readonly client: Pick<CodexAppServerClient, "interruptTurn">,
    private readonly cleanup: (workflow: Workflow) => Promise<void>,
  ) {}
  async cancel(projectId: string, workflowId: string): Promise<Workflow> {
    if (this.pending) return this.pending;
    this.pending = this.perform(projectId, workflowId);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  private async perform(
    projectId: string,
    workflowId: string,
  ): Promise<Workflow> {
    let workflow = await this.store.requestCancellation(projectId, workflowId);
    if (isTerminal(workflow.state)) return workflow;
    if (workflow.activeTurn?.turnId) {
      await this.client.interruptTurn(
        workflow.activeTurn.threadId,
        workflow.activeTurn.turnId,
      );
    }
    workflow = await this.store.get(projectId, workflowId);
    await this.cleanup(workflow);
    return this.engine.cancel(workflow);
  }
}
