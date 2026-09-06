import type { CodexAppServerClient } from "../codex/app-server-client";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { isTerminal, type Workflow } from "../workflows/workflow-schema";

/** Cancellation intent is durable before any interrupt or cleanup side effect. */
export class WorkflowCancellation {
  private readonly pending = new Map<string, Promise<Workflow>>();
  constructor(
    private readonly store: WorkflowStore,
    private readonly engine: WorkflowEngine,
    private readonly client: Pick<CodexAppServerClient, "interruptTurn">,
    private readonly cleanup: (workflow: Workflow) => Promise<void>,
  ) {}
  async cancel(projectId: string, workflowId: string): Promise<Workflow> {
    const key = `${projectId}:${workflowId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.perform(projectId, workflowId);
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
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
