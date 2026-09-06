import type { TaskAssignment, TaskReport, ReviewResult } from "../protocol/team-messages";
import { classifyCodexError } from "../codex/codex-error";
import type { OwnershipValidation } from "../projects/ownership";
import { WorkflowStore } from "./workflow-store";
import { newWorkflow, transition, type Workflow, type WorkflowState } from "./workflow-schema";

export class WorkflowEngine {
 constructor(private readonly store: WorkflowStore) {}
 async create(projectId: string, request: string, id?: string) { const workflow = newWorkflow(projectId, request, id); await this.store.save(workflow); return workflow; }
 async transition(workflow: Workflow, next: WorkflowState, detail: string) { const changed = transition(workflow, next, detail); await this.store.save(changed); return changed; }
 async assign(workflow: Workflow, assignment: TaskAssignment) { const changed = transition({ ...workflow, assignment, assignedAgent: assignment.assignedTo, phase: "implementation", pendingAction: "implement" }, "ASSIGNED", "Architect assignment persisted before developer turn"); await this.store.save(changed); return changed; }
 async report(workflow: Workflow, report: TaskReport, verification: OwnershipValidation) {
   const common = { ...workflow, reports: [...workflow.reports, report], ownershipValidations: [...workflow.ownershipValidations, { at: new Date().toISOString(), ok: verification.ok, violations: verification.violations, source: verification.source }] };
   const next = report.status === "READY_FOR_REVIEW" && verification.ok ? "READY_FOR_REVIEW" : report.status === "BLOCKED" || !verification.ok ? "BLOCKED" : "FAILED";
   const changed = transition({ ...common, phase: next === "READY_FOR_REVIEW" ? "review" : "implementation", pendingAction: next === "READY_FOR_REVIEW" ? "review" : null }, next, verification.ok ? "Developer report accepted" : `Ownership violation: ${verification.violations.join("; ")}`); await this.store.save(changed); return changed;
 }
 async review(workflow: Workflow, review: ReviewResult) { const next = review.decision === "APPROVED" ? "APPROVED" : review.decision === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "BLOCKED"; const changed = transition({ ...workflow, reviews: [...workflow.reviews, review], retryCount: next === "CHANGES_REQUESTED" ? workflow.retryCount + 1 : workflow.retryCount, phase: next === "CHANGES_REQUESTED" ? "implementation" : "complete", pendingAction: next === "CHANGES_REQUESTED" ? "implement-correction" : null }, next, `Architect review: ${review.decision}`); await this.store.save(changed); return changed; }
 async pauseForError(workflow: Workflow, error: unknown, rateLimitSnapshot: unknown = null) { const classified = classifyCodexError(error); const state = classified.kind === "RATE_LIMIT" ? "PAUSED_RATE_LIMIT" : classified.kind === "TRANSIENT_SERVER" ? "PAUSED_MANUAL" : "FAILED"; const changed = transition({ ...workflow, lastError: classified.message, rateLimit: state === "PAUSED_RATE_LIMIT" ? { pausedAt: new Date().toISOString(), retryAfter: null, snapshot: rateLimitSnapshot } : workflow.rateLimit }, state, classified.kind); await this.store.save(changed); return changed; }
 async recover(projectId: string) { return this.store.recoverable(projectId); }
}
