import { atomicReplace } from "../state/atomic-file";
import {
  acquireDurableClaim,
  DurableClaimBusyError,
} from "../state/reconciliation-claim";
import { open, readFile, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RepositoryLease = {
  projectId: string;
  repositoryId: string;
  physicalRoot: string;
  workflowId: string;
  taskId: string;
  attemptId: string;
  acquiredAt: string;
  owner: {
    sessionId: string;
    pid: number;
    hostname: string;
    serverPid: number | null;
  };
};
export class RepositoryBusyError extends Error {
  readonly codexErrorInfo = "serverOverloaded";
}
/** A dead foreign owner is an ownership ambiguity, never an App Server retry. */
export class StaleForeignRepositoryLockError extends Error {
  constructor(readonly lease: RepositoryLease) {
    super(
      `Stale repository lock requires owner action: workflow ${lease.workflowId}, task ${lease.taskId}, root ${lease.physicalRoot}`,
    );
  }
}
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Atomic physical-root lock. Time alone is never evidence that an owner is dead. */
export class RepositoryLock {
  readonly sessionId = crypto.randomUUID();
  constructor(private readonly serverPid: () => number | null = () => null) {}
  private file(root: string) {
    return path.join(root, ".orchestrator-repository.lock");
  }

  async acquire(
    input: Omit<RepositoryLease, "owner" | "acquiredAt">,
  ): Promise<RepositoryLease> {
    const physicalRoot = await realpath(input.physicalRoot);
    const lease: RepositoryLease = {
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
      const handle = await open(this.file(physicalRoot), "wx");
      try {
        await handle.writeFile(JSON.stringify(lease));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await this.inspect(physicalRoot);
    if (
      existing.owner.sessionId === this.sessionId &&
      existing.workflowId === input.workflowId &&
      existing.taskId === input.taskId
    ) {
      const updated = {
        ...existing,
        attemptId: input.attemptId,
        owner: { ...existing.owner, serverPid: this.serverPid() },
      };
      const temporary =
        this.file(physicalRoot) + "." + crypto.randomUUID() + ".tmp";
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(JSON.stringify(updated));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await atomicReplace(temporary, this.file(physicalRoot));
      return updated;
    }
    // Recovery can adopt only the same durable task after BOTH processes died.
    if (
      existing.workflowId === input.workflowId &&
      existing.taskId === input.taskId &&
      this.isDead(existing)
    ) {
      const claim = this.file(physicalRoot) + ".reconcile";
      let release: () => Promise<void>;
      try {
        release = await acquireDurableClaim(claim, {
          targetPath: this.file(physicalRoot),
          targetIdentity: this.leaseIdentity(existing),
        });
      } catch (error) {
        if (!(error instanceof DurableClaimBusyError)) throw error;
        if (error.owner.hostname !== os.hostname()) {
          throw new StaleForeignRepositoryLockError(existing);
        }
        throw new RepositoryBusyError(
          "Repository lock reconciliation is already owned",
        );
      }
      try {
        let latest: RepositoryLease;
        try {
          latest = await this.inspect(physicalRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return this.acquire(input);
          }
          throw error;
        }
        if (
          !this.isDead(latest) ||
          this.leaseIdentity(latest) !== this.leaseIdentity(existing)
        )
          throw new RepositoryBusyError("Repository owner changed");
        await unlink(this.file(physicalRoot));
        return await this.acquire(input);
      } finally {
        await release();
      }
    }
    if (this.isDead(existing)) {
      throw new StaleForeignRepositoryLockError(existing);
    }
    throw new RepositoryBusyError(
      `Repository is locked by workflow ${existing.workflowId}`,
    );
  }

  async inspect(root: string): Promise<RepositoryLease> {
    const lease = JSON.parse(
      await readFile(this.file(root), "utf8"),
    ) as RepositoryLease;
    if (
      !lease.owner?.sessionId ||
      !Number.isInteger(lease.owner.pid) ||
      lease.physicalRoot !== (await realpath(root))
    )
      throw new Error("Ambiguous repository lock; refusing takeover");
    return lease;
  }

  private isDead(lease: RepositoryLease): boolean {
    return (
      lease.owner.hostname === os.hostname() &&
      !processAlive(lease.owner.pid) &&
      (lease.owner.serverPid === null || !processAlive(lease.owner.serverPid))
    );
  }

  private leaseIdentity(lease: RepositoryLease): string {
    return `${lease.owner.sessionId}:${lease.owner.pid}:${lease.owner.serverPid}`;
  }

  async release(lease: RepositoryLease): Promise<boolean> {
    let actual: RepositoryLease;
    try {
      actual = await this.inspect(lease.physicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      actual.owner.sessionId !== this.sessionId ||
      lease.owner.sessionId !== this.sessionId ||
      actual.workflowId !== lease.workflowId ||
      actual.taskId !== lease.taskId
    )
      return false;
    await unlink(this.file(lease.physicalRoot));
    return true;
  }
}
