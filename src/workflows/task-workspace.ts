import { createHash } from "node:crypto";
import path from "node:path";
import { RepositoryLock, type RepositoryLease } from "./repository-lock";
import { OwnershipVerifier } from "../projects/ownership";
import { TopologyService, isPathWithin } from "../projects/project-topology";
import { GitWorktreeManager } from "./git-worktree-manager";
import { type Delivery, type Workflow } from "./workflow-schema";
import { WorkflowStore } from "./workflow-store";

/** Maps repository identities to isolated task roots for every developer turn. */
export class TaskWorkspace {
  readonly git: GitWorktreeManager;
  readonly locks: RepositoryLock;
  private readonly leases = new Map<string, RepositoryLease>();

  constructor(
    private readonly root: string,
    readonly ownership: OwnershipVerifier,
    private readonly store: WorkflowStore,
    serverPid: () => number | null = () => null,
  ) {
    this.locks = new RepositoryLock(serverPid);
    this.git = new GitWorktreeManager(root);
  }

  async prepare(
    workflow: Workflow,
    attemptId = crypto.randomUUID() as string,
  ): Promise<{
    workflow: Workflow;
    ownership: OwnershipVerifier;
    cwd: string;
    roots: string[];
  }> {
    workflow = await this.store.get(workflow.projectId, workflow.id);
    if (workflow.cancellationRequestedAt) throw new Error("Workflow cancelled");
    if (!workflow.assignment)
      throw new Error("Task workspace requires assignment");

    const assignment = workflow.assignment;
    const selected = assignment.allowedScopes?.length
      ? new Set(assignment.allowedScopes.map((scope) => scope.repositoryId))
      : new Set(
          this.ownership.topology.topology.repositories.map((repo) => repo.id),
        );
    const repositories = [];

    for (const repository of this.ownership.topology.topology.repositories) {
      if (!selected.has(repository.id)) continue;
      if (
        (await this.store.get(workflow.projectId, workflow.id))
          .cancellationRequestedAt
      ) {
        throw new Error("Workflow cancelled");
      }

      let worktree = workflow.worktrees.find(
        (item) =>
          item.repositoryId === repository.id &&
          item.taskId === assignment.taskId,
      );
      if (!worktree) {
        const resourceId = createHash("sha256")
          .update(assignment.taskId)
          .digest("hex")
          .slice(0, 20);
        worktree =
          (await this.git.create(
            repository.id,
            repository.root,
            workflow.id,
            assignment.taskId,
            resourceId,
          )) ?? undefined;
        if (worktree) {
          workflow = {
            ...workflow,
            worktrees: [...workflow.worktrees, worktree],
          };
          await this.store.save(workflow);
        }
      }

      if (!worktree) {
        const lease = await this.locks.acquire({
          projectId: workflow.projectId,
          repositoryId: repository.id,
          physicalRoot: repository.root,
          workflowId: workflow.id,
          taskId: assignment.taskId,
          attemptId,
        });
        this.leases.set(repository.id, lease);
      }
      repositories.push({
        ...repository,
        root: worktree?.worktreePath ?? repository.root,
      });
    }

    if (!repositories.length)
      throw new Error("Assignment has no configured repositories");
    const ownership = new OwnershipVerifier(
      new TopologyService({
        ...this.ownership.topology.topology,
        repositories,
      }),
    );
    const preferred =
      this.ownership.topology.topology.agentWorkspaces[assignment.assignedTo]
        ?.repositoryId;
    let cwd = (repositories.find((repo) => repo.id === preferred) ??
      repositories[0])!.root;
    const requestedCwd =
      this.ownership.topology.topology.agentWorkspaces[assignment.assignedTo]
        ?.cwd;
    if (requestedCwd) {
      const original = this.ownership.topology.topology.repositories
        .filter((repo) => isPathWithin(repo.root, requestedCwd))
        .sort((a, b) => b.root.length - a.root.length)[0];
      const mapped = repositories.find((repo) => repo.id === original?.id);
      if (original && mapped)
        cwd = path.join(
          mapped.root,
          path.relative(original.root, requestedCwd),
        );
    }

    const baselines = await ownership.captureBaseline();
    for (const baseline of baselines) {
      const worktree = workflow.worktrees.find(
        (item) =>
          item.repositoryId === baseline.repositoryId &&
          item.taskId === assignment.taskId,
      );
      if (worktree) {
        baseline.head = worktree.baseCommitSha;
        baseline.worktreePath = worktree.worktreePath;
      } else {
        const persisted = workflow.baselines.find(
          (item) => item.repositoryId === baseline.repositoryId,
        );
        if (persisted) baseline.files = persisted.files;
      }
    }
    workflow = { ...workflow, baselines };
    await this.store.save(workflow);
    return {
      workflow,
      ownership,
      cwd,
      roots: repositories.map((repo) => repo.root),
    };
  }

  async recordAttempt(workflow: Workflow, attemptId: string): Promise<void> {
    for (const [id, lease] of this.leases) {
      if (lease.workflowId === workflow.id) {
        this.leases.set(id, await this.locks.acquire({ ...lease, attemptId }));
      }
    }
  }

  /**
   * Turns reviewed task work into an auditable result commit before any approved
   * worktree is removable. Every delivery is persisted independently so a crash
   * cannot make an approved result unreachable.
   */
  async finalizeApproved(workflow: Workflow): Promise<Workflow> {
    if (workflow.state !== "APPROVED")
      throw new Error("Only approved work can be finalized");
    if (!workflow.assignment || !workflow.reports.length) {
      throw new Error("Approved workflow has no assignment/report to verify");
    }

    const pending = workflow.worktrees.filter(
      (worktree) =>
        !workflow.deliveries.some(
          (delivery) =>
            delivery.repositoryId === worktree.repositoryId &&
            delivery.taskId === worktree.taskId,
        ),
    );
    if (!pending.length) return workflow;

    const verifier = this.verifierForWorktrees(pending);
    const baselines = pending.map((worktree) => ({
      repositoryId: worktree.repositoryId,
      head: worktree.baseCommitSha,
      files: {},
      worktreePath: worktree.worktreePath,
    }));
    const verification = await verifier.validateTaskDelta(
      workflow.assignment,
      workflow.reports.at(-1)!,
      baselines,
    );
    if (!verification.ok) {
      throw new Error(
        `Approved delta failed final ownership verification: ${verification.violations.join("; ")}`,
      );
    }

    for (const worktree of pending) {
      const finalized = await this.git.finalizeApproved(worktree);
      const delivery: Delivery = {
        repositoryId: worktree.repositoryId,
        taskId: worktree.taskId,
        baseCommitSha: finalized.baseCommitSha,
        resultCommitSha: finalized.resultCommitSha,
        branch: finalized.branch,
        originalRepositoryRoot: worktree.originalRepositoryRoot,
        originalBranch: worktree.originalBranch,
        status: "READY_TO_INTEGRATE",
        finalizedAt: new Date().toISOString(),
        integratedAt: null,
        integrationReason: null,
      };
      workflow = await this.store.saveApprovedDeliveries(
        workflow.projectId,
        workflow.id,
        [delivery],
      );
    }

    return workflow;
  }

  /** Attempts only a clean fast-forward integration; unsafe checkouts stay untouched. */
  async integrateApproved(workflow: Workflow): Promise<Workflow> {
    if (workflow.state !== "APPROVED")
      throw new Error("Only approved workflows can be integrated");
    for (const delivery of workflow.deliveries) {
      if (delivery.status === "INTEGRATED") continue;
      const outcome = await this.git.integrateApproved(delivery);
      const updated: Delivery = {
        ...delivery,
        status: outcome.ok ? "INTEGRATED" : "OWNER_ACTION_REQUIRED",
        integratedAt: outcome.ok ? new Date().toISOString() : null,
        integrationReason: outcome.ok ? null : outcome.reason,
      };
      workflow = await this.store.saveApprovedDeliveries(
        workflow.projectId,
        workflow.id,
        [updated],
      );
    }
    return workflow;
  }

  async cleanup(workflow: Workflow): Promise<void> {
    const preserveApprovedBranches = workflow.state === "APPROVED";
    if (preserveApprovedBranches) {
      const missing = workflow.worktrees.filter(
        (worktree) =>
          !workflow.deliveries.some(
            (delivery) =>
              delivery.repositoryId === worktree.repositoryId &&
              delivery.taskId === worktree.taskId,
          ),
      );
      if (missing.length) {
        throw new Error(
          "Refusing approved cleanup before delivery metadata is durable",
        );
      }
    }

    for (const worktree of workflow.worktrees) {
      await this.git.cleanup(worktree, {
        preserveBranch: preserveApprovedBranches,
      });
    }
    await this.releaseOwnedLeases(workflow);
  }

  private verifierForWorktrees(
    worktrees: Workflow["worktrees"],
  ): OwnershipVerifier {
    const roots = new Map(
      worktrees.map((worktree) => [
        worktree.repositoryId,
        worktree.worktreePath,
      ]),
    );
    const repositories = this.ownership.topology.topology.repositories
      .filter((repository) => roots.has(repository.id))
      .map((repository) => ({
        ...repository,
        root: roots.get(repository.id)!,
      }));
    return new OwnershipVerifier(
      new TopologyService({
        ...this.ownership.topology.topology,
        repositories,
      }),
    );
  }

  private async releaseOwnedLeases(workflow: Workflow): Promise<void> {
    for (const repository of this.ownership.topology.topology.repositories) {
      if (this.leases.has(repository.id)) continue;
      try {
        const previous = await this.locks.inspect(repository.root);
        if (previous.workflowId !== workflow.id) continue;
        const lease = await this.locks.acquire(previous);
        this.leases.set(repository.id, lease);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const [repositoryId, lease] of this.leases) {
      if (
        lease.workflowId === workflow.id &&
        (await this.locks.release(lease))
      ) {
        this.leases.delete(repositoryId);
      }
    }
  }
}
