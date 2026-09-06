import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DurableClaim = {
  sessionId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  targetPath: string;
  targetIdentity: string;
};

export class DurableClaimBusyError extends Error {
  constructor(
    readonly file: string,
    readonly owner: DurableClaim,
  ) {
    super(
      `Durable reconciliation claim is owned by ${owner.hostname}:${owner.pid} for ${owner.targetPath}`,
    );
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isProvenDead(claim: DurableClaim): boolean {
  return claim.hostname === os.hostname() && !processAlive(claim.pid);
}

function sameClaim(left: DurableClaim, right: DurableClaim): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.acquiredAt === right.acquiredAt
  );
}

async function readClaim(file: string): Promise<DurableClaim> {
  const value = JSON.parse(
    await readFile(file, "utf8"),
  ) as Partial<DurableClaim>;
  if (
    !value.sessionId ||
    !Number.isInteger(value.pid) ||
    !value.hostname ||
    !value.acquiredAt ||
    !value.targetPath ||
    !value.targetIdentity
  ) {
    throw new Error(`Ambiguous durable reconciliation claim: ${file}`);
  }
  return value as DurableClaim;
}

async function waitForClaimWriter(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

async function removeAbandonedOrphans(file: string): Promise<void> {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.orphan.`;
  const entries = await readdir(directory);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const orphan = path.join(directory, entry);
        try {
          const existing = await readClaim(orphan);
          if (isProvenDead(existing)) await unlink(orphan);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
  );
}

/**
 * Acquires a durable, crash-recoverable claim. A proven-dead same-host claim is
 * atomically renamed away before a fresh contender creates the shared name.
 * Renaming, rather than unlinking, prevents a delayed contender from deleting
 * a newer claim that won the recovery race.
 */
export async function acquireDurableClaim(
  file: string,
  target: Pick<DurableClaim, "targetPath" | "targetIdentity">,
): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  await removeAbandonedOrphans(file);
  const claim: DurableClaim = {
    sessionId: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    ...target,
  };

  for (;;) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(claim));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = await readClaim(file);
          if (sameClaim(current, claim)) await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
          await waitForClaimWriter();
          continue;
        }
        throw error;
      }
    }

    let existing: DurableClaim;
    try {
      existing = await readClaim(file);
    } catch (error) {
      if (
        ["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        error instanceof SyntaxError
      ) {
        await waitForClaimWriter();
        continue;
      }
      throw error;
    }
    if (!isProvenDead(existing))
      throw new DurableClaimBusyError(file, existing);

    const orphan = `${file}.orphan.${crypto.randomUUID()}`;
    try {
      await rename(file, orphan);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (
        ["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        await waitForClaimWriter();
        continue;
      }
      throw error;
    }
    let moved: DurableClaim;
    try {
      moved = await readClaim(orphan);
    } catch (error) {
      // A competing recovery may have observed the vacant shared name and
      // completed the target reconciliation first. Re-read the shared claim
      // rather than treating a transient orphan lookup as a permanent lock.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!sameClaim(existing, moved)) {
      throw new Error(`Reconciliation claim changed during recovery: ${file}`);
    }
    await unlink(orphan);
  }
}
