import type {
  OwnerInputRequest,
  ReviewResult,
  TaskAssignment,
  TaskReport,
} from "../protocol/team-messages";
import { classifyCodexError } from "../codex/codex-error";
import { StaleForeignRepositoryLockError } from "./repository-lock";
import type { OwnershipValidation } from "../projects/ownership";
import { WorkflowStore } from "./workflow-store";
import {
  isTerminal,
  newWorkflow,
  transition,
  type Workflow,
  type WorkflowState,
} from "./workflow-schema";

export class WorkflowEngine {
  constructor(private readonly store: WorkflowStore) {}

  async create(
    projectId: string,
    request: string,
    id?: string,
  ): Promise<Workflow> {
    const workflow = newWorkflow(projectId, request, id);
    await this.store.save(workflow);
    return this.reload(workflow);
  }

  private async persist(workflow: Workflow): Promise<Workflow> {
    const latest = await this.reload(workflow);
    if (isTerminal(latest.state) || latest.cancellationRequestedAt)
      return latest;
    await this.store.save(workflow);
    return this.reload(workflow);
  }

  async transition(
    workflow: Workflow,
    next: WorkflowState,
    detail: string,
  ): Promise<Workflow> {
    const latest = await this.reload(workflow);
    if (isTerminal(latest.state) || latest.cancellationRequestedAt)
      return latest;
    return this.persist(transition(workflow, next, detail));
  }

  async assign(
    workflow: Workflow,
    assignment: TaskAssignment,
  ): Promise<Workflow> {
    return this.transition(
      {
        ...workflow,
        assignment,
        assignedAgent: assignment.assignedTo,
        phase: "implementation",
        pendingAction: "implement",
        allowedScopes: assignment.allowedScopes ?? [],
        forbiddenScopes: assignment.forbiddenScopes ?? [],
      },
      "ASSIGNED",
      "Architect assignment checkpointed",
    );
  }

  async report(
    workflow: Workflow,
    report: TaskReport,
    verification: OwnershipValidation,
  ): Promise<Workflow> {
    const next =
      report.status === "READY_FOR_REVIEW" && verification.ok
        ? "READY_FOR_REVIEW"
        : "BLOCKED";
    return this.transition(
      {
        ...workflow,
        reports: [...workflow.reports, report],
        ownershipValidations: [
          ...workflow.ownershipValidations,
          {
            at: new Date().toISOString(),
            ok: verification.ok,
            violations: verification.violations,
            source: verification.source,
          },
        ],
        phase: next === "READY_FOR_REVIEW" ? "review" : "implementation",
        pendingAction:
          next === "READY_FOR_REVIEW" ? "review" : "owner-intervention",
      },
      next,
      verification.ok
        ? "Developer report accepted after verification"
        : `Developer report rejected: ${verification.violations.join("; ")}`,
    );
  }

  async review(workflow: Workflow, review: ReviewResult): Promise<Workflow> {
    const next =
      review.decision === "APPROVED"
        ? "APPROVED"
        : review.decision === "CHANGES_REQUESTED"
          ? "CHANGES_REQUESTED"
          : "BLOCKED";
    return this.transition(
      {
        ...workflow,
        reviews: [...workflow.reviews, review],
        retryCount:
          next === "CHANGES_REQUESTED"
            ? workflow.retryCount + 1
            : workflow.retryCount,
        phase: next === "CHANGES_REQUESTED" ? "implementation" : "complete",
        pendingAction:
          next === "CHANGES_REQUESTED" ? "implement-correction" : null,
      },
      next,
      `Architect review: ${review.decision}`,
    );
  }

  async requestOwnerInput(
    workflow: Workflow,
    request: OwnerInputRequest,
  ): Promise<Workflow> {
    return this.transition(
      {
        ...workflow,
        ownerInput: { request, priorState: workflow.state, answer: null },
        pendingAction: "owner-answer",
      },
      "WAITING_FOR_OWNER_INPUT",
      "Architect requested owner input",
    );
  }

  async answerOwnerInput(
    workflow: Workflow,
    answer: string,
  ): Promise<Workflow> {
    if (workflow.state !== "WAITING_FOR_OWNER_INPUT" || !workflow.ownerInput)
      throw new Error("Workflow is not waiting for owner input");
    const prior = workflow.ownerInput.priorState;
    return this.transition(
      {
        ...workflow,
        ownerInput: { ...workflow.ownerInput, answer },
        pendingAction: prior === "REVIEWING" ? "review" : "plan",
      },
      prior,
      "Owner answer persisted",
    );
  }

  async pauseForError(
    workflow: Workflow,
    error: unknown,
    snapshot: unknown = null,
  ): Promise<Workflow> {
    const latest = await this.reload(workflow);
    if (isTerminal(latest.state) || latest.cancellationRequestedAt)
      return latest;
    workflow = {
      ...latest,
      activeTurn: null,
      attempts: latest.attempts.map((a) =>
        a.status === "RUNNING" ? { ...a, status: "INTERRUPTED" } : a,
      ),
    };
    if (error instanceof StaleForeignRepositoryLockError) {
      return this.transition(
        {
          ...workflow,
          lastError: error.message,
          manualReconciliation: {
            reason: "STALE_FOREIGN_REPOSITORY_LOCK",
            repositoryId: error.lease.repositoryId,
            physicalRoot: error.lease.physicalRoot,
            ownerWorkflowId: error.lease.workflowId,
            ownerTaskId: error.lease.taskId,
            detectedAt: new Date().toISOString(),
          },
        },
        "PAUSED_MANUAL",
        "STALE_FOREIGN_REPOSITORY_LOCK",
      );
    }
    const classified = classifyCodexError(error);
    const now = new Date();
    if (classified.kind === "RATE_LIMIT") {
      return this.transition(
        {
          ...workflow,
          lastError: classified.message,
          rateLimit: {
            pausedAt: now.toISOString(),
            retryAfter: null,
            snapshot,
            previousState:
              workflow.state === "PAUSED_RATE_LIMIT"
                ? workflow.rateLimit!.previousState
                : workflow.state,
            pendingAction: workflow.pendingAction,
            agentRole: workflow.assignedAgent,
          },
        },
        "PAUSED_RATE_LIMIT",
        "RATE_LIMIT",
      );
    }
    if (classified.kind === "TRANSIENT_SERVER") {
      const attempts = (workflow.transient?.attempts ?? 0) + 1;
      const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9));
      return this.transition(
        {
          ...workflow,
          lastError: classified.message,
          transient: {
            previousState:
              workflow.state === "PAUSED_TRANSIENT"
                ? workflow.transient!.previousState
                : workflow.state,
            attempts,
            retryAt: new Date(now.getTime() + delay).toISOString(),
          },
        },
        "PAUSED_TRANSIENT",
        "TRANSIENT_SERVER",
      );
    }
    return this.transition(
      { ...workflow, lastError: classified.message },
      "FAILED",
      classified.kind,
    );
  }

  async updateRateLimit(
    workflow: Workflow,
    snapshot: unknown,
    nextCheckAt: string,
    attempts: number,
  ): Promise<Workflow> {
    return this.persist({
      ...workflow,
      rateLimit: {
        ...(workflow.rateLimit ?? {
          pausedAt: new Date().toISOString(),
          retryAfter: null,
          snapshot: null,
        }),
        snapshot,
        nextCheckAt,
        attempts,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async resumePaused(workflow: Workflow): Promise<Workflow> {
    const next =
      workflow.state === "PAUSED_TRANSIENT"
        ? (workflow.transient?.previousState ?? "PLANNING")
        : workflow.state === "PAUSED_RATE_LIMIT"
          ? (workflow.rateLimit?.previousState ??
            (workflow.phase === "review"
              ? "READY_FOR_REVIEW"
              : workflow.assignment
                ? "ASSIGNED"
                : "PENDING"))
          : workflow.state;
    return this.transition(
      {
        ...workflow,
        rateLimit:
          workflow.state === "PAUSED_RATE_LIMIT" ? null : workflow.rateLimit,
      },
      next,
      "Resume persisted checkpoint",
    );
  }

  async cancel(workflow: Workflow): Promise<Workflow> {
    const latest = await this.store.requestCancellation(
      workflow.projectId,
      workflow.id,
    );
    if (isTerminal(latest.state)) return latest;
    return this.store.finishCancellation(latest.projectId, latest.id);
  }

  async reload(workflow: Workflow) {
    return this.store.get(workflow.projectId, workflow.id);
  }
  async recover(projectId: string) {
    return this.store.recoverable(projectId);
  }
}
