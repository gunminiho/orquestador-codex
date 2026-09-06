import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type TaskWorktree = { repositoryId: string; originalRepositoryRoot: string; baseCommitSha: string; branch: string; worktreePath: string; workflowId: string; taskId: string; attemptId: string; createdByOrchestrator: true };

export class GitWorktreeManager {
  constructor(private readonly root: string) {}
  async create(repositoryId: string, repositoryRoot: string, workflowId: string, taskId: string, attemptId: string): Promise<TaskWorktree | null> {
    try { await stat(path.join(repositoryRoot, ".git")); } catch { return null; }
    const { stdout } = await exec("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { windowsHide: true });
    const baseCommitSha = stdout.trim(); const branch = `orchestrator/${workflowId}-${attemptId}`.replace(/[^a-zA-Z0-9/_-]/g, "-");
    const worktreePath = path.resolve(this.root, ".orchestrator", "worktrees", workflowId, repositoryId, attemptId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await exec("git", ["-C", repositoryRoot, "worktree", "add", "-b", branch, worktreePath, baseCommitSha], { windowsHide: true });
    return { repositoryId, originalRepositoryRoot: repositoryRoot, baseCommitSha, branch, worktreePath, workflowId, taskId, attemptId, createdByOrchestrator: true };
  }
  async changedFiles(worktree: TaskWorktree): Promise<string[]> { const { stdout } = await exec("git", ["-C", worktree.worktreePath, "diff", "--name-only", "-z", worktree.baseCommitSha], { windowsHide: true }); return stdout.split("\0").filter(Boolean); }
  async cleanup(worktree: TaskWorktree): Promise<void> { if (!worktree.createdByOrchestrator || !worktree.worktreePath.includes(`${path.sep}.orchestrator${path.sep}`)) return; await exec("git", ["-C", worktree.originalRepositoryRoot, "worktree", "remove", "--force", worktree.worktreePath], { windowsHide: true }); await exec("git", ["-C", worktree.originalRepositoryRoot, "branch", "-D", worktree.branch], { windowsHide: true }); }
}
