import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPathWithin } from "../projects/project-topology";

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
  createdByOrchestrator: true;
};
export type GitDelta =
  | { kind: "modified" | "added" | "deleted"; path: string }
  | { kind: "renamed"; oldPath: string; newPath: string };

export function parseGitDelta(output: string): GitDelta[] {
  const fields = output.split("\0");
  const changes: GitDelta[] = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i++]!;
    const first = fields[i++];
    if (!first) throw new Error("Malformed Git delta");
    if (status.startsWith("R")) {
      const second = fields[i++];
      if (!second) throw new Error("Malformed Git rename");
      changes.push({ kind: "renamed", oldPath: first, newPath: second });
    } else {
      if (!/^[AMDT]$/.test(status))
        throw new Error(`Unsupported Git status: ${status}`);
      changes.push({
        kind:
          status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        path: first,
      });
    }
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
  const results = await Promise.all([
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
    ...parseGitDelta(results[0].stdout),
    ...results[1].stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => ({ kind: "added" as const, path: file })),
  ];
}

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
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
        throw new Error("Unsafe worktree identifier");
    }
    const { stdout } = await exec(
      "git",
      ["-C", repositoryRoot, "rev-parse", "HEAD"],
      { windowsHide: true },
    );
    let baseCommitSha = stdout.trim();
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
    // Deterministic paths let recovery adopt a creation interrupted before its checkpoint.
    try {
      await stat(worktreePath);
      const actual = await exec(
        "git",
        ["-C", worktreePath, "symbolic-ref", "--short", "HEAD"],
        { windowsHide: true },
      );
      if (actual.stdout.trim() !== branch)
        throw new Error("Worktree ownership mismatch");
      const originalBase = await exec(
        "git",
        ["-C", worktreePath, "rev-parse", "HEAD"],
        { windowsHide: true },
      );
      baseCommitSha = originalBase.stdout.trim();
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
      createdByOrchestrator: true,
    };
  }

  async changedFiles(worktree: TaskWorktree): Promise<string[]> {
    return deltaPaths(
      await readGitDelta(worktree.worktreePath, worktree.baseCommitSha),
    );
  }

  async cleanup(worktree: TaskWorktree): Promise<void> {
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
    )
      throw new Error("Refusing unowned worktree cleanup");
    const branch = `orchestrator/${worktree.workflowId}-${worktree.repositoryId}-${worktree.attemptId}`;
    if (branch !== worktree.branch)
      throw new Error("Refusing unowned branch cleanup");
    try {
      await stat(expected);
      const actual = await exec(
        "git",
        ["-C", expected, "symbolic-ref", "--short", "HEAD"],
        { windowsHide: true },
      );
      if (actual.stdout.trim() !== branch)
        throw new Error("Worktree ownership mismatch");
      await exec(
        "git",
        [
          "-C",
          worktree.originalRepositoryRoot,
          "worktree",
          "remove",
          "--force",
          expected,
        ],
        { windowsHide: true },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const refs = await exec(
      "git",
      ["-C", worktree.originalRepositoryRoot, "branch", "--list", branch],
      { windowsHide: true },
    );
    if (refs.stdout.trim())
      await exec(
        "git",
        ["-C", worktree.originalRepositoryRoot, "branch", "-D", branch],
        { windowsHide: true },
      );
  }
}
