import type { ArchitectAgent } from "../agents/architect";
import type { TeamRouter } from "../orchestration/team-router";
import { ArchitectActionSchema, type OwnerInputRequest } from "../protocol/team-messages";
import type { TaskAssignment } from "../protocol/team-messages";
import type { OwnershipVerifier } from "../projects/ownership";
import { WorkflowEngine } from "./workflow-engine";
import { WorkflowStore } from "./workflow-store";
import type { Workflow } from "./workflow-schema";

/** Advances durable checkpoints until a real external wait or terminal state. */
export class WorkflowRunner {
  constructor(private readonly engine: WorkflowEngine, private readonly store: WorkflowStore, private readonly architect: ArchitectAgent, private readonly router: TeamRouter, private readonly ownership: OwnershipVerifier) {}

  async runUntilPauseOrTerminal(initial: Workflow): Promise<Workflow> {
    let current = initial;
    for (let iterations = 0; iterations < 100; iterations += 1) {
      if (["APPROVED", "FAILED", "CANCELLED", "WAITING_FOR_OWNER_INPUT", "BLOCKED", "PAUSED_MANUAL", "PAUSED_RATE_LIMIT"].includes(current.state)) return current;
      if (current.state === "PAUSED_TRANSIENT" && current.transient && Date.now() < Date.parse(current.transient.retryAt)) return current;
      try { current = await this.step(current); }
      catch (error) { current = await this.store.get(current.projectId, current.id); return this.engine.pauseForError(current, error); }
    }
    return this.engine.transition(current, "PAUSED_MANUAL", "Execution iteration guard reached");
  }

  private async step(workflow: Workflow): Promise<Workflow> {
    switch (workflow.state) {
      case "PENDING": return this.engine.transition(workflow, "PLANNING", "Planning started");
      case "PLANNING": return this.plan(workflow);
      case "ASSIGNED": return this.engine.transition(workflow, "IMPLEMENTING", "Developer turn checkpointed");
      case "IMPLEMENTING": return this.implement(workflow);
      case "READY_FOR_REVIEW": return this.engine.transition(workflow, "REVIEWING", "Architect review checkpointed");
      case "REVIEWING": return this.review(workflow);
      case "CHANGES_REQUESTED": return this.engine.transition(workflow, "IMPLEMENTING", "Correction turn checkpointed");
      case "PAUSED_TRANSIENT": return this.engine.resumePaused(workflow);
      default: return workflow;
    }
  }

  private async plan(workflow: Workflow): Promise<Workflow> {
    const answer = workflow.ownerInput?.answer ? `\nOwner answer: ${workflow.ownerInput.answer}` : "";
    const response = await this.architect.sendStructured(`Create exactly one TASK_ASSIGNMENT or OWNER_INPUT_REQUIRED for workflow ${workflow.id}. Owner request: ${workflow.ownerRequest}${answer}`, ArchitectActionSchema);
    if (response.data.type === "OWNER_INPUT_REQUIRED") return this.engine.requestOwnerInput(workflow, response.data as OwnerInputRequest);
    if (response.data.type !== "TASK_ASSIGNMENT") throw new Error("Architect returned an invalid planning action");
    return this.engine.assign(workflow, response.data);
  }

  private async implement(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment) throw new Error("Implementation has no assignment");
    // A persisted baseline means a previous developer turn may be ambiguous: never replay it.
    if (workflow.baselines.length > 0 && workflow.pendingAction === "implement") return this.engine.transition(workflow, "PAUSED_MANUAL", "Ambiguous implementation requires REPORT/CONTINUE reconciliation");
    const baseline = await this.ownership.captureBaseline();
    const checkpoint = await this.engine.transition({ ...workflow, baselines: baseline, pendingAction: "implement" }, "IMPLEMENTING", "Baseline persisted before developer turn");
    const assigned = checkpoint.assignment as TaskAssignment;
    const correction = checkpoint.reviews.at(-1)?.decision === "CHANGES_REQUESTED" ? `\nCORRECTION TURN. Required changes: ${JSON.stringify(checkpoint.reviews.at(-1))}` : "";
    const report = await this.router.routeTask({ ...assigned, context: `${assigned.context}${correction}` });
    const verification = await this.ownership.validateTaskDelta(assigned, report, baseline);
    return this.engine.report(checkpoint, report, verification);
  }

  private async review(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment || !workflow.reports.length) throw new Error("Review has no report");
    const response = await this.architect.sendStructured(`Review and return REVIEW_RESULT or OWNER_INPUT_REQUIRED. Assignment: ${JSON.stringify(workflow.assignment)} Report: ${JSON.stringify(workflow.reports.at(-1))}`, ArchitectActionSchema);
    if (response.data.type === "OWNER_INPUT_REQUIRED") return this.engine.requestOwnerInput(workflow, response.data);
    if (response.data.type !== "REVIEW_RESULT") throw new Error("Architect returned invalid review action");
    return this.engine.review(workflow, response.data);
  }
}
