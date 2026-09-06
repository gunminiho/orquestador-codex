import type { CodexAppServerClient } from "../codex/app-server-client";
import { WorkflowEngine } from "./workflow-engine";
import type { Workflow } from "./workflow-schema";

/** Recovery is deliberately conservative: it returns work to the last checkpoint,
 * never replays a developer turn automatically after an interrupted implementation. */
export class WorkflowRecovery {
  constructor(private readonly engine: WorkflowEngine, private readonly client: CodexAppServerClient) {}
  async discover(projectId: string): Promise<Workflow[]> { return this.engine.recover(projectId); }
  async resumeRateLimited(workflow: Workflow): Promise<Workflow> {
    if (workflow.state !== "PAUSED_RATE_LIMIT") return workflow;
    const limits = await this.client.getAccountRateLimits();
    const reached = [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId ?? {})].some((snapshot) => snapshot?.rateLimitReachedType !== null);
    if (reached) return workflow;
    const checkpoint = workflow.phase === "planning" ? "PLANNING" : workflow.phase === "review" ? "READY_FOR_REVIEW" : "IMPLEMENTING";
    return this.engine.transition({ ...workflow, rateLimit: null }, checkpoint, "Rate-limit snapshot permits continuation; action remains checkpointed");
  }
}
