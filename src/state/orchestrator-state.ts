import { atomicReplace } from "./atomic-file";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AgentRole = "architect" | "backend" | "frontend";
export type AgentState = { threadId: string };
export type ProjectAgentState = {
  agents: Partial<Record<AgentRole, AgentState>>;
};
export type OrchestratorState = {
  version: 2;
  projects: Record<string, ProjectAgentState>;
};
type LegacyOrchestratorState = {
  agents?: Partial<Record<AgentRole, AgentState>>;
};
type MutationLease = { sessionId: string; pid: number; hostname: string };

const EMPTY_STATE: OrchestratorState = { version: 2, projects: {} };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * state.json remains compatible with existing installations. saveAgent performs
 * its read-modify-write inside an interprocess mutation lease, so a stale caller
 * snapshot can never erase another project's thread update.
 */
export class OrchestratorStateStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly mutationLock: string;
  private readonly mutationClaim: string;
  private readonly sessionId = crypto.randomUUID();

  constructor(rootDirectory: string) {
    this.directory = path.join(rootDirectory, ".orchestrator");
    this.file = path.join(this.directory, "state.json");
    this.mutationLock = path.join(this.directory, "state.mutation.lock");
    this.mutationClaim = path.join(this.directory, "state.mutation.reconcile");
  }

  async load(): Promise<OrchestratorState> {
    const state = await this.readCurrent();
    if (this.isV2State(state)) return state;
    if (!this.isLegacyState(state))
      throw new Error("Unsupported orchestrator state format.");

    return this.withMutationLock(async () => {
      const latest = await this.readCurrent();
      if (this.isV2State(latest)) return latest;
      if (!this.isLegacyState(latest))
        throw new Error("Unsupported orchestrator state format.");
      return this.migrateLegacyStateUnlocked(latest);
    });
  }

  async save(state: OrchestratorState): Promise<void> {
    await this.withMutationLock(() => this.writeState(state));
  }

  getProjectState(
    state: OrchestratorState,
    projectId: string,
  ): ProjectAgentState {
    return state.projects[projectId] ?? { agents: {} };
  }

  async saveAgent(
    _staleState: OrchestratorState,
    projectId: string,
    role: AgentRole,
    agent: AgentState,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      const latest = await this.loadLatestForMutation();
      const project = latest.projects[projectId] ?? { agents: {} };
      latest.projects[projectId] = {
        ...project,
        agents: { ...project.agents, [role]: agent },
      };
      await this.writeState(latest);
    });
  }

  private async loadLatestForMutation(): Promise<OrchestratorState> {
    const current = await this.readCurrent();
    if (this.isV2State(current)) return current;
    if (this.isLegacyState(current))
      return this.migrateLegacyStateUnlocked(current);
    throw new Error("Unsupported orchestrator state format.");
  }

  private async readCurrent(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  private async writeState(state: OrchestratorState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const value = this.parseState(state);
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicReplace(temporary, this.file);
  }

  private parseState(value: unknown): OrchestratorState {
    if (!this.isV2State(value))
      throw new Error("Unsupported orchestrator state format.");
    return value;
  }

  private isV2State(value: unknown): value is OrchestratorState {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
      candidate.version === 2 &&
      typeof candidate.projects === "object" &&
      candidate.projects !== null
    );
  }

  private isLegacyState(value: unknown): value is LegacyOrchestratorState {
    return typeof value === "object" && value !== null && "agents" in value;
  }

  private async migrateLegacyStateUnlocked(
    legacy: LegacyOrchestratorState,
  ): Promise<OrchestratorState> {
    await mkdir(this.directory, { recursive: true });
    const backup = path.join(
      this.directory,
      `state.legacy.${crypto.randomUUID()}.json`,
    );
    await rename(this.file, backup);
    const state: OrchestratorState = {
      version: 2,
      projects: { "legacy-unassigned": { agents: legacy.agents ?? {} } },
    };
    await this.writeState(state);
    console.log("[STATE] Legacy global-agent state detected.");
    console.log(`[STATE] Backup created: ${backup}`);
    return state;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutationLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireMutationLock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    for (;;) {
      const lease: MutationLease = {
        sessionId: this.sessionId,
        pid: process.pid,
        hostname: os.hostname(),
      };
      try {
        const handle = await open(this.mutationLock, "wx");
        try {
          await handle.writeFile(JSON.stringify(lease));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            const current = JSON.parse(
              await readFile(this.mutationLock, "utf8"),
            ) as MutationLease;
            if (
              current.sessionId === lease.sessionId &&
              current.pid === lease.pid
            ) {
              await unlink(this.mutationLock);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // On Windows an exclusive creator can temporarily prevent another
          // process from opening the just-created lock file at all. That is
          // ordinary contention, not evidence that the lease is corrupt.
          if (["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            continue;
          }
          throw error;
        }
      }

      let existing: MutationLease;
      try {
        existing = await this.readMutationLease();
      } catch (error) {
        // An exclusive lock is visible before its owner has finished writing the
        // small lease payload, or can disappear immediately after EEXIST.
        if (
          ["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          ) ||
          error instanceof SyntaxError
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        throw error;
      }
      if (this.isProvenDead(existing)) {
        await this.reconcileDeadMutationLock(existing);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async readMutationLease(): Promise<MutationLease> {
    const value = JSON.parse(
      await readFile(this.mutationLock, "utf8"),
    ) as Partial<MutationLease>;
    if (!value.sessionId || !Number.isInteger(value.pid) || !value.hostname) {
      throw new Error("Ambiguous orchestrator state mutation lock");
    }
    return value as MutationLease;
  }

  private isProvenDead(lease: MutationLease): boolean {
    return lease.hostname === os.hostname() && !processAlive(lease.pid);
  }

  private async reconcileDeadMutationLock(
    existing: MutationLease,
  ): Promise<void> {
    let claim;
    try {
      claim = await open(this.mutationClaim, "wx");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return;
    }
    try {
      const latest = await this.readMutationLease();
      if (
        latest.sessionId === existing.sessionId &&
        latest.pid === existing.pid &&
        this.isProvenDead(latest)
      ) {
        await unlink(this.mutationLock);
      }
    } finally {
      await claim.close();
      await unlink(this.mutationClaim);
    }
  }
}
