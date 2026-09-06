import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskAssignment, TaskReport } from "../protocol/team-messages";
import { TopologyService, matchPath, toPortablePath } from "./project-topology";

const execFileAsync = promisify(execFile);
export type OwnershipValidation = { ok: boolean; violations: string[]; verifiedFiles: string[]; source: "report" | "git" | "none" };

export class OwnershipVerifier {
  constructor(private readonly topology: TopologyService) {}

  validateReport(assignment: TaskAssignment, report: TaskReport): OwnershipValidation {
    const violations: string[] = [];
    for (const rawPath of report.filesChanged) {
      try {
        const candidate = this.resolveReportedPath(rawPath);
        if (!candidate || !this.topology.may(report.agent, candidate.repository.id, candidate.relativePath, "write")) violations.push(`${rawPath}: not writable by ${report.agent}`);
        else if (!assignment.allowedPaths.some((pattern) => matchPath(pattern, candidate.relativePath)) || assignment.forbiddenPaths.some((pattern) => matchPath(pattern, candidate.relativePath))) violations.push(`${rawPath}: outside TASK_ASSIGNMENT`);
      } catch (error) { violations.push(`${rawPath}: ${error instanceof Error ? error.message : "invalid path"}`); }
    }
    return { ok: violations.length === 0, violations, verifiedFiles: report.filesChanged, source: "report" };
  }

  async validateGitDiff(assignment: TaskAssignment, report: TaskReport): Promise<OwnershipValidation> {
    const allFiles: string[] = [];
    for (const repository of this.topology.topology.repositories) {
      try {
        const { stdout } = await execFileAsync("git", ["-C", repository.root, "status", "--porcelain", "-z"], { windowsHide: true });
        allFiles.push(...stdout.split("\0").filter(Boolean).map((line) => line.slice(3)).filter(Boolean).map((file) => `${repository.id}:${file}`));
      } catch { /* not a git repository; reported paths remain the fallback */ }
    }
    if (!allFiles.length) return this.validateReport(assignment, report);
    return this.validateReport(assignment, { ...report, filesChanged: allFiles });
  }

  private resolveReportedPath(raw: string) {
    const prefixed = /^([a-z0-9-]+):(.*)$/i.exec(raw);
    if (prefixed) return this.topology.resolveProjectPath(prefixed[1]!, prefixed[2]!);
    const relative = toPortablePath(raw);
    const repositories = this.topology.topology.repositories.filter((repository) => {
      try { this.topology.resolveProjectPath(repository.id, relative); return true; } catch { return false; }
    });
    if (repositories.length !== 1) throw new Error("ambiguous repository path; use repositoryId:path");
    return this.topology.resolveProjectPath(repositories[0]!.id, relative);
  }
}
