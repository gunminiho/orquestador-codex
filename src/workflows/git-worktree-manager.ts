import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPathWithin } from "../projects/project-topology";
import type { Delivery } from "./workflow-schema";

const exec = promisify(execFile);

export type TaskWorktree = {
  repositoryId: string;
  originalRepositoryRoot: string;
  baseCommitSha: string;
  branch: string;
  worktreePath: string;
  workflowId: string;
  taskId: string;
  attemptId: string;
  originalBranch: string;
  createdByOrchestrator: true;
};

export type FinalizedWorktree = {
  baseCommitSha: string;
  resultCommitSha: string;
  branch: string;
};
export type IntegrationOutcome = { ok: true } | { ok: false; reason: string };

export type GitDelta =
  | { kind: "modified" | "added" | "deleted"; path: string }
  | { kind: "renamed"; oldPath: string; newPath: string };

export function parseGitDelta(output: string): GitDelta[] {
  const fields = output.split("\0");
  const changes: GitDelta[] = [];

  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index++]!;
    const first = fields[index++];
    if (!first) throw new Error("Malformed Git delta");

    if (status.startsWith("R")) {
      const second = fields[index++];
      if (!second) throw new Error("Malformed Git rename");
      changes.push({ kind: "renamed", oldPath: first, newPath: second });
      continue;
    }

    if (!/^[AMDT]$/.test(status)) {
      throw new Error(`Unsupported Git status: ${status}`);
    }
    changes.push({
      kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
      path: first,
    });
  }

  return changes;
}

export function deltaPaths(delta: GitDelta[]): string[] {
  return [
    ...new Set(
      delta.flatMap((change) =>
        change.kind === "renamed"
          ? [change.oldPath, change.newPath]
          : [change.path],
      ),
    ),
  ];
}

export async function readGitDelta(
  cwd: string,
  base: string,
): Promise<GitDelta[]> {
  const [tracked, untracked] = await Promise.all([
    exec(
      "git",
      ["-C", cwd, "diff", "--name-status", "-z", "--find-renames", base, "--"],
      { windowsHide: true },
    ),
    exec(
      "git",
      ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
      { windowsHide: true },
    ),
  ]);
  return [
    ...parseGitDelta(tracked.stdout),
    ...untracked.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => ({ kind: "added" as const, path: file })),
  ];
}

/** Owns isolated task worktrees and preserves an approved result branch. */
export class GitWorktreeManager {
  constructor(private readonly root: string) {}

  async create(
    repositoryId: string,
    repositoryRoot: string,
    workflowId: string,
    taskId: string,
    attemptId: string,
  ): Promise<TaskWorktree | null> {
    try {
      await stat(path.join(repositoryRoot, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    for (const id of [repositoryId, workflowId, attemptId]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
        throw new Error("Unsafe worktree identifier");
      }
    }

    const [{ stdout: head }, { stdout: branchName }] = await Promise.all([
      exec("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
        windowsHide: true,
      }),
      exec("git", ["-C", repositoryRoot, "symbolic-ref", "--short", "HEAD"], {
        windowsHide: true,
      }),
    ]);
    let baseCommitSha = head.trim();
    const originalBranch = branchName.trim();
    const branch = `orchestrator/${workflowId}-${repositoryId}-${attemptId}`;
    const worktreePath = path.resolve(
      this.root,
      ".orchestrator",
      "worktrees",
      workflowId,
      repositoryId,
      attemptId,
    );
    await mkdir(path.dirname(worktreePath), { recursive: true });

    try {
      await stat(worktreePath);
      const actual = await exec(
        "git",
        ["-C", worktreePath, "symbolic-ref", "--short", "HEAD"],
        { windowsHide: true },
      );
      if (actual.stdout.trim() !== branch)
        throw new Error("Worktree ownership mismatch");
      const persistedBase = await exec(
        "git",
        ["-C", worktreePath, "merge-base", branch, originalBranch],
        { windowsHide: true },
      );
      baseCommitSha = persistedBase.stdout.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await exec(
        "git",
        [
          "-C",
          repositoryRoot,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          baseCommitSha,
        ],
        { windowsHide: true },
      );
    }

    return {
      repositoryId,
      originalRepositoryRoot: repositoryRoot,
      baseCommitSha,
      branch,
      worktreePath,
      workflowId,
      taskId,
      attemptId,
      originalBranch,
      createdByOrchestrator: true,
    };
  }

  async changedFiles(worktree: TaskWorktree): Promise<string[]> {
    return deltaPaths(
      await readGitDelta(worktree.worktreePath, worktree.baseCommitSha),
    );
  }

  async finalizeApproved(worktree: TaskWorktree): Promise<FinalizedWorktree> {
    await this.assertOwned(worktree);
    await exec("git", ["-C", worktree.worktreePath, "add", "-A"], {
      windowsHide: true,
    });
    const { stdout: status } = await exec(
      "git",
      ["-C", worktree.worktreePath, "status", "--porcelain"],
      { windowsHide: true },
    );

    if (status.trim()) {
      await exec(
        "git",
        [
          "-C",
          worktree.worktreePath,
          "-c",
          "user.name=Codex Orchestrator",
          "-c",
          "user.email=codex-orchestrator@invalid",
          "commit",
          "--no-verify",
          "-m",
          `orchestrator: approve ${worktree.workflowId}/${worktree.taskId}`,
        ],
        { windowsHide: true },
      );
    }

    const [{ stdout: result }, { stdout: clean }] = await Promise.all([
      exec("git", ["-C", worktree.worktreePath, "rev-parse", "HEAD"], {
        windowsHide: true,
      }),
      exec("git", ["-C", worktree.worktreePath, "status", "--porcelain"], {
        windowsHide: true,
      }),
    ]);
    if (clean.trim())
      throw new Error("Approved worktree remains dirty after finalization");

    const resultCommitSha = result.trim();
    try {
      await exec(
        "git",
        [
          "-C",
          worktree.worktreePath,
          "merge-base",
          "--is-ancestor",
          worktree.baseCommitSha,
          resultCommitSha,
        ],
        { windowsHide: true },
      );
    } catch {
      throw new Error("Approved result does not descend from task base commit");
    }
    return {
      baseCommitSha: worktree.baseCommitSha,
      resultCommitSha,
      branch: worktree.branch,
    };
  }

  async integrateApproved(delivery: Delivery): Promise<IntegrationOutcome> {
    try {
      await stat(path.join(delivery.originalRepositoryRoot, ".git"));
    } catch {
      return { ok: false, reason: "Original Git repository no longer exists" };
    }

    const [head, branch, status] = await Promise.all([
      this.gitValue(delivery.originalRepositoryRoot, ["rev-parse", "HEAD"]),
      this.gitValue(delivery.originalRepositoryRoot, [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]),
      this.gitValue(delivery.originalRepositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
      ]),
    ]);
    if (!delivery.originalBranch || branch !== delivery.originalBranch) {
      return {
        ok: false,
        reason: `Original checkout is on ${branch || "a detached HEAD"}; expected ${delivery.originalBranch || "the recorded branch"}`,
      };
    }
    if (head !== delivery.baseCommitSha) {
      return {
        ok: false,
        reason: `Original HEAD is ${head}; expected task base ${delivery.baseCommitSha}`,
      };
    }
    if (status) {
      return { ok: false, reason: "Original checkout or index is dirty" };
    }

    const branchCommit = await this.gitValue(delivery.originalRepositoryRoot, [
      "rev-parse",
      `refs/heads/${delivery.branch}`,
    ]).catch(() => null);
    if (!branchCommit) {
      return {
        ok: false,
        reason: `Durable result branch ${delivery.branch} is missing`,
      };
    }
    if (branchCommit !== delivery.resultCommitSha) {
      return {
        ok: false,
        reason: `Durable result branch no longer identifies ${delivery.resultCommitSha}`,
      };
    }
    const resultExists = await this.gitValue(delivery.originalRepositoryRoot, [
      "rev-parse",
      "--verify",
      `${delivery.resultCommitSha}^{commit}`,
    ]).catch(() => null);
    if (resultExists !== delivery.resultCommitSha) {
      return {
        ok: false,
        reason: `Result commit ${delivery.resultCommitSha} is missing`,
      };
    }

    try {
      await exec(
        "git",
        [
          "-C",
          delivery.originalRepositoryRoot,
          "merge",
          "--ff-only",
          delivery.resultCommitSha,
        ],
        { windowsHide: true },
      );
    } catch {
      return { ok: false, reason: "Fast-forward integration was not possible" };
    }
    const integrated = await this.gitValue(delivery.originalRepositoryRoot, [
      "rev-parse",
      "HEAD",
    ]);
    if (integrated !== delivery.resultCommitSha) {
      return {
        ok: false,
        reason: "Fast-forward did not reach the approved result commit",
      };
    }
    return { ok: true };
  }

  async cleanup(
    worktree: TaskWorktree,
    options: { preserveBranch?: boolean } = {},
  ): Promise<void> {
    await this.assertOwned(worktree);
    const preserveBranch = options.preserveBranch ?? false;
    const expected = path.resolve(worktree.worktreePath);

    try {
      await stat(expected);
      const removeArgs = [
        "-C",
        worktree.originalRepositoryRoot,
        "worktree",
        "remove",
      ];
      if (!preserveBranch) removeArgs.push("--force");
      removeArgs.push(expected);
      await exec("git", removeArgs, { windowsHide: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (preserveBranch) return;

    const refs = await exec(
      "git",
      [
        "-C",
        worktree.originalRepositoryRoot,
        "branch",
        "--list",
        worktree.branch,
      ],
      { windowsHide: true },
    );
    if (refs.stdout.trim()) {
      await exec(
        "git",
        [
          "-C",
          worktree.originalRepositoryRoot,
          "branch",
          "-D",
          worktree.branch,
        ],
        { windowsHide: true },
      );
    }
  }

  private async assertOwned(worktree: TaskWorktree): Promise<void> {
    const expected = path.resolve(
      this.root,
      ".orchestrator",
      "worktrees",
      worktree.workflowId,
      worktree.repositoryId,
      worktree.attemptId,
    );
    const ownedRoot = path.resolve(this.root, ".orchestrator", "worktrees");
    if (
      !worktree.createdByOrchestrator ||
      !isPathWithin(ownedRoot, expected) ||
      expected !== path.resolve(worktree.worktreePath)
    ) {
      throw new Error("Refusing unowned worktree cleanup");
    }
    const expectedBranch = `orchestrator/${worktree.workflowId}-${worktree.repositoryId}-${worktree.attemptId}`;
    if (worktree.branch !== expectedBranch)
      throw new Error("Refusing unowned branch cleanup");
  }

  private async gitValue(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      windowsHide: true,
    });
    return stdout.trim();
  }
}
