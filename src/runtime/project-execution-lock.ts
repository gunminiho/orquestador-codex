import { open, readFile, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireDurableClaim, DurableClaimBusyError } from "../state/reconciliation-claim";
import { atomicReplace } from "../state/atomic-file";
import { processAlive } from "../workflows/repository-lock";

export type ProjectExecutionLease = {
  projectId: string;
  workflowId: string;
  physicalRoot: string;
  acquiredAt: string;
  owner: {
    sessionId: string;
    pid: number;
    hostname: string;
    serverPid: number | null;
  };
};

/** The scheduler can wait for a live peer, but never takes an ambiguous lock. */
export class ProjectExecutionBusyError extends Error {}

/**
 * Serializes orchestrator scheduling only. Unlike RepositoryLock this owns no
 * user checkout, so a proven-dead local owner may be reclaimed across workflow
 * ids. Application-repository locking remains deliberately more conservative.
 */
export class ProjectExecutionLock {
  readonly sessionId = crypto.randomUUID();

  constructor(private readonly serverPid: () => number | null = () => null) {}

  private file(root: string): string {
    return path.join(root, ".orchestrator-repository.lock");
  }

  async acquire(
    input: Pick<ProjectExecutionLease, "projectId" | "workflowId" | "physicalRoot">,
  ): Promise<ProjectExecutionLease> {
    const physicalRoot = await realpath(input.physicalRoot);
    const lease: ProjectExecutionLease = {
      ...input,
      physicalRoot,
      acquiredAt: new Date().toISOString(),
      owner: {
        sessionId: this.sessionId,
        pid: process.pid,
        hostname: os.hostname(),
        serverPid: this.serverPid(),
      },
    };

    try {
      await this.create(lease);
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await this.inspect(physicalRoot);
    if (
      existing.owner.sessionId === this.sessionId &&
      existing.projectId === input.projectId &&
      existing.workflowId === input.workflowId
    ) {
      const renewed = {
        ...existing,
        owner: { ...existing.owner, serverPid: this.serverPid() },
      };
      await this.replace(physicalRoot, renewed);
      return renewed;
    }

    if (!this.isDead(existing)) {
      throw new ProjectExecutionBusyError(
        `Project execution is owned by workflow ${existing.workflowId}`,
      );
    }

    const file = this.file(physicalRoot);
    let releaseClaim: () => Promise<void>;
    try {
      releaseClaim = await acquireDurableClaim(`${file}.reconcile`, {
        targetPath: file,
        targetIdentity: this.identity(existing),
      });
    } catch (error) {
      if (error instanceof DurableClaimBusyError) {
        throw new ProjectExecutionBusyError(
          `Project execution reconciliation is owned by ${error.owner.hostname}:${error.owner.pid}`,
        );
      }
      throw error;
    }

    try {
      let latest: ProjectExecutionLease;
      try {
        latest = await this.inspect(physicalRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return this.acquire(input);
        throw error;
      }
      if (!this.isDead(latest) || this.identity(latest) !== this.identity(existing))
        throw new ProjectExecutionBusyError("Project execution owner changed");
      await unlink(file);
      return this.acquire(input);
    } finally {
      await releaseClaim();
    }
  }

  async inspect(root: string): Promise<ProjectExecutionLease> {
    const physicalRoot = await realpath(root);
    const lease = JSON.parse(
      await readFile(this.file(physicalRoot), "utf8"),
    ) as Partial<ProjectExecutionLease>;
    if (
      !lease.projectId ||
      !lease.workflowId ||
      !lease.owner?.sessionId ||
      !Number.isInteger(lease.owner.pid) ||
      !lease.owner.hostname ||
      lease.physicalRoot !== physicalRoot
    ) {
      throw new Error("Ambiguous project execution lock; refusing takeover");
    }
    return lease as ProjectExecutionLease;
  }

  async release(lease: ProjectExecutionLease): Promise<boolean> {
    let actual: ProjectExecutionLease;
    try {
      actual = await this.inspect(lease.physicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      actual.owner.sessionId !== this.sessionId ||
      lease.owner.sessionId !== this.sessionId ||
      actual.projectId !== lease.projectId ||
      actual.workflowId !== lease.workflowId
    ) {
      return false;
    }
    await unlink(this.file(lease.physicalRoot));
    return true;
  }

  private async create(lease: ProjectExecutionLease): Promise<void> {
    const handle = await open(this.file(lease.physicalRoot), "wx");
    try {
      await handle.writeFile(JSON.stringify(lease));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replace(
    root: string,
    lease: ProjectExecutionLease,
  ): Promise<void> {
    const temporary = `${this.file(root)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(lease));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicReplace(temporary, this.file(root));
  }

  private isDead(lease: ProjectExecutionLease): boolean {
    return (
      lease.owner.hostname === os.hostname() &&
      !processAlive(lease.owner.pid) &&
      (lease.owner.serverPid === null || !processAlive(lease.owner.serverPid))
    );
  }

  private identity(lease: ProjectExecutionLease): string {
    return `${lease.owner.sessionId}:${lease.owner.pid}:${lease.owner.serverPid}`;
  }
}
