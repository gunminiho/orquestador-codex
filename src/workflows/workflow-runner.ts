import type { ArchitectAgent } from "../agents/architect";
import type { TeamRouter } from "../orchestration/team-router";
import { ArchitectActionSchema, type OwnerInputRequest } from "../protocol/team-messages";
import type { OwnershipVerifier } from "../projects/ownership";
import { WorkflowEngine } from "./workflow-engine";
import type { Workflow } from "./workflow-schema";

/** Drives only persisted checkpoints. A restart can call run() with the stored workflow. */
export class WorkflowRunner {
  constructor(private readonly engine: WorkflowEngine, private readonly architect: ArchitectAgent, private readonly router: TeamRouter, private readonly ownership: OwnershipVerifier) {}
  async run(workflow: Workflow): Promise<Workflow> {
    try {
      switch (workflow.state) {
        case "PENDING": return this.plan(await this.engine.transition(workflow, "PLANNING", "Planning started"));
        case "PLANNING": return this.plan(workflow);
        case "ASSIGNED": return this.implement(await this.engine.transition(workflow, "IMPLEMENTING", "Developer turn started"));
        case "IMPLEMENTING": return this.implement(workflow);
        case "READY_FOR_REVIEW": return this.review(await this.engine.transition(workflow, "REVIEWING", "Architect review started"));
        case "REVIEWING": return this.review(workflow);
        case "CHANGES_REQUESTED": return this.implement(await this.engine.transition(workflow, "IMPLEMENTING", "Correction turn started"));
        case "PAUSED_RATE_LIMIT": case "PAUSED_TRANSIENT": return this.engine.resumePaused(workflow);
        default: return workflow;
      }
    } catch (error) { return this.engine.pauseForError(workflow, error); }
  }
  async answer(workflow: Workflow, answer: string) { return this.engine.answerOwnerInput(workflow, answer); }
  private async plan(workflow: Workflow): Promise<Workflow> {
    const ownerAnswer = workflow.ownerInput?.answer ? `\nOwner answer: ${workflow.ownerInput.answer}` : "";
    const response = await this.architect.sendStructured(`Create exactly one TASK_ASSIGNMENT or OWNER_INPUT_REQUIRED for workflow ${workflow.id}. Owner request: ${workflow.ownerRequest}${ownerAnswer}`, ArchitectActionSchema);
    if (response.data.type === "OWNER_INPUT_REQUIRED") return this.engine.requestOwnerInput(workflow, response.data as OwnerInputRequest);
    if (response.data.type !== "TASK_ASSIGNMENT") throw new Error("Architect returned a review while planning");
    return this.engine.assign(workflow, response.data);
  }
  private async implement(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment) throw new Error("Implementation has no persisted assignment");
    const baseline = await this.ownership.captureBaseline();
    const checkpointed = await this.engine.transition({ ...workflow, baselines: baseline }, "IMPLEMENTING", "Task change baseline persisted before developer turn");
    const report = await this.router.routeTask(checkpointed.assignment!);
    const verification = await this.ownership.validateTaskDelta(checkpointed.assignment!, report, baseline);
    return this.engine.report(checkpointed, report, verification);
  }
  private async review(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment || !workflow.reports.length) throw new Error("Review has no persisted report");
    const report = workflow.reports.at(-1)!;
    const response = await this.architect.sendStructured(`Review this developer report and return REVIEW_RESULT or OWNER_INPUT_REQUIRED. Assignment: ${JSON.stringify(workflow.assignment)} Report: ${JSON.stringify(report)}`, ArchitectActionSchema);
    if (response.data.type === "OWNER_INPUT_REQUIRED") return this.engine.requestOwnerInput(workflow, response.data);
    if (response.data.type !== "REVIEW_RESULT") throw new Error("Architect returned assignment while reviewing");
    return this.engine.review(workflow, response.data);
  }
}
