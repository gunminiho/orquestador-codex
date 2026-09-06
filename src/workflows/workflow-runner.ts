import { fileSnapshot } from "./file-snapshot";
import type { ArchitectAgent } from "../agents/architect";
import type { TurnOptions } from "../codex/app-server-client";
import type { TeamRouter } from "../orchestration/team-router";
import { ArchitectActionSchema } from "../protocol/team-messages";
import type { OwnershipVerifier } from "../projects/ownership";
import { WorkflowEngine } from "./workflow-engine";
import { WorkflowStore } from "./workflow-store";
import {
  isTerminal,
  type Workflow,
  type ImplementationAttempt,
} from "./workflow-schema";
import { TaskWorkspace } from "./task-workspace";
import { readGitDelta } from "./git-worktree-manager";

/** Each side effect follows a durable checkpoint; recovery reconciles existing implementation. */
export class WorkflowRunner {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly store: WorkflowStore,
    private readonly architect: ArchitectAgent,
    private readonly router: TeamRouter,
    private readonly ownership: OwnershipVerifier,
    private readonly workspace?: TaskWorkspace,
  ) {}

  async runUntilPauseOrTerminal(initial: Workflow): Promise<Workflow> {
    let current = initial;
    for (;;) {
      current = await this.store.get(current.projectId, current.id);
      if (
        isTerminal(current.state) ||
        current.cancellationRequestedAt ||
        [
          "WAITING_FOR_OWNER_INPUT",
          "BLOCKED",
          "PAUSED_MANUAL",
          "PAUSED_RATE_LIMIT",
          "PAUSED_TRANSIENT",
          "FINALIZING_DELIVERY",
        ].includes(current.state)
      )
        return current;
      try {
        current = await this.step(current);
      } catch (error) {
        current = await this.store.get(current.projectId, current.id);
        if (isTerminal(current.state) || current.cancellationRequestedAt)
          return current;
        return this.engine.pauseForError(current, error);
      }
    }
  }

  private async step(workflow: Workflow): Promise<Workflow> {
    switch (workflow.state) {
      case "PENDING":
        return this.engine.transition(workflow, "PLANNING", "Planning started");
      case "PLANNING":
        return this.plan(workflow);
      case "ASSIGNED":
        return this.engine.transition(
          workflow,
          "IMPLEMENTING",
          "Developer turn checkpointed",
        );
      case "IMPLEMENTING":
        return this.implement(workflow);
      case "READY_FOR_REVIEW":
        return this.engine.transition(
          workflow,
          "REVIEWING",
          "Architect review checkpointed",
        );
      case "REVIEWING":
        return this.review(workflow);
      case "CHANGES_REQUESTED":
        return this.engine.transition(
          workflow,
          "IMPLEMENTING",
          "Correction turn checkpointed",
        );
      default:
        return workflow;
    }
  }

  private turnOptions(
    workflow: Workflow,
    role: string,
    threadId: string,
    attemptId: string | null,
  ): TurnOptions {
    return {
      readOnly: role === "architect",
      beforeStart: async () => {
        const latest = await this.store.get(workflow.projectId, workflow.id);
        if (isTerminal(latest.state) || latest.cancellationRequestedAt)
          throw new Error("Workflow cancelled");
        await this.store.save({
          ...latest,
          activeTurn: {
            workflowId: latest.id,
            attemptId,
            role,
            threadId,
            turnId: null,
            startedAt: new Date().toISOString(),
          },
        });
      },
      onStarted: async (thread, turnId) => {
        const latest = await this.store.get(workflow.projectId, workflow.id);
        if (isTerminal(latest.state) || latest.cancellationRequestedAt)
          throw new Error("Workflow cancelled");
        await this.store.save({
          ...latest,
          activeTurn: {
            workflowId: latest.id,
            attemptId,
            role,
            threadId: thread,
            turnId,
            startedAt: latest.activeTurn?.startedAt ?? new Date().toISOString(),
          },
          attempts: latest.attempts.map((a) =>
            a.attemptId === attemptId ? { ...a, turnId } : a,
          ),
        });
      },
    };
  }

  private async plan(workflow: Workflow): Promise<Workflow> {
    const answer = workflow.ownerInput?.answer
      ? `\nOwner answer: ${workflow.ownerInput.answer}`
      : "";
    const options = this.turnOptions(
      workflow,
      "architect",
      this.architect.getThreadId(),
      null,
    );
    const response = await this.architect.sendStructured(
      `Create exactly one TASK_ASSIGNMENT or OWNER_INPUT_REQUIRED for workflow ${workflow.id}. Owner request: ${workflow.ownerRequest}${answer}`,
      ArchitectActionSchema,
      options,
    );
    workflow = await this.store.get(workflow.projectId, workflow.id);
    if (isTerminal(workflow.state) || workflow.cancellationRequestedAt)
      return workflow;
    workflow.activeTurn = null;
    if (response.data.type === "OWNER_INPUT_REQUIRED")
      return this.engine.requestOwnerInput(workflow, response.data);
    if (response.data.type !== "TASK_ASSIGNMENT")
      throw new Error("Architect returned an invalid planning action");
    return this.engine.assign(workflow, response.data);
  }

  private async implement(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment)
      throw new Error("Implementation has no assignment");
    const assigned = workflow.assignment;
    const previous = [...workflow.attempts]
      .reverse()
      .find(
        (a) =>
          a.taskId === assigned.taskId &&
          a.correctionAttempt === workflow.retryCount &&
          a.completedAt === null &&
          !a.reportPersisted &&
          a.status !== "CANCELLED",
      );
    if (
      !previous &&
      !workflow.attempts.length &&
      workflow.baselines.length &&
      !workflow.worktrees.length &&
      workflow.pendingAction === "implement"
    ) {
      return this.engine.transition(
        workflow,
        "PAUSED_MANUAL",
        "Legacy implementation has no isolated attempt metadata; original-checkout attribution is ambiguous",
      );
    }
    let attemptId = previous?.attemptId ?? (crypto.randomUUID() as string);
    const prepared = await this.workspace?.prepare(workflow, attemptId);
    workflow = prepared?.workflow ?? workflow;
    const verifier = prepared?.ownership ?? this.ownership;
    const baseline = prepared
      ? workflow.baselines
      : await verifier.captureBaseline();
    let recovery = "";
    let reconciliation: ImplementationAttempt["reconciliationState"] = "NONE";
    if (previous) {
      let evidence = false;
      for (const before of baseline) {
        if (
          before.head &&
          before.worktreePath &&
          (await readGitDelta(before.worktreePath, before.head)).length
        )
          evidence = true;
      }
      for (const before of baseline.filter((b) => !b.head)) {
        const repo = verifier.topology.topology.repositories.find(
          (r) => r.id === before.repositoryId,
        )!;
        const currentFiles = await fileSnapshot(repo.root);
        if (JSON.stringify(currentFiles) !== JSON.stringify(before.files))
          evidence = true;
      }
      if (evidence) {
        attemptId = previous.attemptId;
        reconciliation = "REPORT_CONTINUE";
        recovery =
          "\nREPORT/CONTINUE: Inspect the existing task delta in these SAME task workspaces. Do NOT redo completed work or blindly replay the assignment. Finish unfinished work only, run validation, and return TASK_REPORT.";
      } else {
        attemptId = crypto.randomUUID();
        reconciliation = "SAFE_RETRY";
        recovery =
          "\nSAFE RETRY: The interrupted attempt has no implementation evidence. Execute the assignment in this explicit new attempt.";
        workflow.attempts = workflow.attempts.map((a) =>
          a.attemptId === previous.attemptId
            ? {
                ...a,
                status: "INTERRUPTED",
                completedAt: new Date().toISOString(),
                reconciliationState: "SAFE_RETRY",
              }
            : a,
        );
      }
    }
    const threadId = this.router.getThreadId(assigned.assignedTo);
    const attempts: ImplementationAttempt[] = baseline.map((b) => ({
      attemptId,
      workflowId: workflow.id,
      taskId: assigned.taskId,
      assignedAgent: assigned.assignedTo,
      threadId,
      turnId: null,
      repositoryId: b.repositoryId,
      worktreePath: b.worktreePath,
      baseCommitSha: b.head,
      startedAt:
        previous && attemptId === previous.attemptId
          ? previous.startedAt
          : new Date().toISOString(),
      completedAt: null,
      status: "RUNNING",
      correctionAttempt: workflow.retryCount,
      reportPersisted: false,
      reconciliationState: reconciliation,
    }));
    await this.workspace?.recordAttempt(workflow, attemptId);
    workflow = await this.engine.transition(
      {
        ...workflow,
        baselines: baseline,
        pendingAction: "implement",
        threadIds: { ...workflow.threadIds, [assigned.assignedTo]: threadId },
        attempts: [
          ...workflow.attempts.filter((a) => a.attemptId !== attemptId),
          ...attempts,
        ],
      },
      "IMPLEMENTING",
      reconciliation === "NONE"
        ? "Attempt persisted before developer turn"
        : reconciliation,
    );
    const correction =
      workflow.reviews.at(-1)?.decision === "CHANGES_REQUESTED"
        ? `\nCORRECTION: ${JSON.stringify(workflow.reviews.at(-1))}`
        : "";
    const options = this.turnOptions(
      workflow,
      assigned.assignedTo,
      threadId,
      attemptId,
    );
    if (prepared) {
      options.cwd = prepared.cwd;
      options.writableRoots = prepared.roots;
    }
    const report = await this.router.routeTask(
      {
        ...assigned,
        context: `${assigned.context}${correction}${recovery}\nAuthoritative execution repositories (use only these roots for writes): ${JSON.stringify(verifier.topology.topology.repositories.map((r) => ({ id: r.id, root: r.root })))}`,
      },
      options,
    );
    workflow = await this.store.get(workflow.projectId, workflow.id);
    if (isTerminal(workflow.state) || workflow.cancellationRequestedAt)
      return workflow;
    const verification = await verifier.validateTaskDelta(
      assigned,
      report,
      baseline,
    );
    return this.engine.report(
      {
        ...workflow,
        activeTurn: null,
        attempts: workflow.attempts.map((a) =>
          a.attemptId === attemptId
            ? {
                ...a,
                status: "COMPLETED",
                completedAt: new Date().toISOString(),
                reportPersisted: true,
                reconciliationState: "RECONCILED",
              }
            : a,
        ),
      },
      report,
      verification,
    );
  }

  private async review(workflow: Workflow): Promise<Workflow> {
    if (!workflow.assignment || !workflow.reports.length)
      throw new Error("Review has no report");
    const options = this.turnOptions(
      workflow,
      "architect",
      this.architect.getThreadId(),
      null,
    );
    const response = await this.architect.sendStructured(
      `Review and return REVIEW_RESULT or OWNER_INPUT_REQUIRED. Task worktrees: ${JSON.stringify(workflow.worktrees)} Assignment: ${JSON.stringify(workflow.assignment)} Report: ${JSON.stringify(workflow.reports.at(-1))}`,
      ArchitectActionSchema,
      options,
    );
    workflow = await this.store.get(workflow.projectId, workflow.id);
    if (isTerminal(workflow.state) || workflow.cancellationRequestedAt)
      return workflow;
    workflow.activeTurn = null;
    if (response.data.type === "OWNER_INPUT_REQUIRED")
      return this.engine.requestOwnerInput(workflow, response.data);
    if (response.data.type !== "REVIEW_RESULT")
      throw new Error("Architect returned invalid review action");
    return this.engine.review(workflow, response.data);
  }
}
