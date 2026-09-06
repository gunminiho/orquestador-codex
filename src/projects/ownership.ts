import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskAssignment, TaskReport } from "../protocol/team-messages";
import { TopologyService, matchPath, toPortablePath } from "./project-topology";

const execFileAsync = promisify(execFile);
export type ChangeBaseline = { repositoryId: string; head: string | null; files: Record<string, string>; worktreePath: string | null };
export type OwnershipValidation = { ok: boolean; violations: string[]; verifiedFiles: string[]; source: "report" | "git" | "none" };

/** Parses porcelain v1 -z records, including rename/copy's second NUL path. */
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split("\0"); const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]; if (!record) continue;
    if (record.length < 4) continue;
    const status = record.slice(0, 2); paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) { const old = fields[++index]; if (old) paths.push(old); }
  }
  return paths.filter(Boolean);
}

export class OwnershipVerifier {
  constructor(private readonly topology: TopologyService) {}
  async captureBaseline(): Promise<ChangeBaseline[]> {
    return Promise.all(this.topology.topology.repositories.map(async (repository) => {
      try { const [{ stdout: head }, { stdout: status }] = await Promise.all([execFileAsync("git", ["-C", repository.root, "rev-parse", "HEAD"], { windowsHide: true }), execFileAsync("git", ["-C", repository.root, "status", "--porcelain=v1", "-z"], { windowsHide: true })]); return { repositoryId: repository.id, head: head.trim(), files: Object.fromEntries(parsePorcelainZ(status).map((file) => [file, "dirty"])), worktreePath: null }; } catch { return { repositoryId: repository.id, head: null, files: {}, worktreePath: null }; }
    }));
  }
  validateReport(assignment: TaskAssignment, report: TaskReport, actualFiles = report.filesChanged, source: OwnershipValidation["source"] = "report"): OwnershipValidation {
    const violations: string[] = [];
    for (const rawPath of actualFiles) {
      try { const candidate = this.resolveReportedPath(rawPath); const allowed = this.inAssignment(assignment, candidate.repository.id, candidate.relativePath, "allowed"); const forbidden = this.inAssignment(assignment, candidate.repository.id, candidate.relativePath, "forbidden");
        if (this.topology.isArchitectControlled(candidate.repository.id, candidate.relativePath)) violations.push(`${rawPath}: architect-controlled`);
        else if (!this.topology.may(report.agent, candidate.repository.id, candidate.relativePath, "write")) violations.push(`${rawPath}: not writable by ${report.agent}`);
        else if (!allowed || forbidden) violations.push(`${rawPath}: outside TASK_ASSIGNMENT`);
      } catch (error) { violations.push(`${rawPath}: ${error instanceof Error ? error.message : "invalid path"}`); }
    }
    const reportSet = new Set(report.filesChanged); for (const actual of actualFiles) if (!reportSet.has(actual)) violations.push(`${actual}: changed but omitted from TASK_REPORT`);
    return { ok: violations.length === 0, violations, verifiedFiles: actualFiles, source };
  }
  async validateTaskDelta(assignment: TaskAssignment, report: TaskReport, baseline: ChangeBaseline[]): Promise<OwnershipValidation> {
    const changed: string[] = [];
    for (const repository of this.topology.topology.repositories) {
      const before = baseline.find((item) => item.repositoryId === repository.id)?.files ?? {};
      try { const { stdout } = await execFileAsync("git", ["-C", repository.root, "status", "--porcelain=v1", "-z"], { windowsHide: true }); for (const file of parsePorcelainZ(stdout)) if (!(file in before)) changed.push(`${repository.id}:${file}`); } catch { /* report-only fallback for non-git projects */ }
    }
    const actual = changed.length ? changed : report.filesChanged;
    const result = this.validateReport(assignment, report, actual, changed.length ? "git" : "report");
    for (const raw of actual) {
      try { const candidate = this.resolveReportedPath(raw); await this.assertSafePath(candidate.repository.id, candidate.relativePath); }
      catch (error) { result.violations.push(`${raw}: ${error instanceof Error ? error.message : "unsafe path"}`); }
    }
    result.ok = result.violations.length === 0;
    return result;
  }
  private inAssignment(assignment: TaskAssignment, repositoryId: string, relativePath: string, kind: "allowed" | "forbidden"): boolean {
    const scopes = kind === "allowed" ? assignment.allowedScopes : assignment.forbiddenScopes;
    if (scopes?.length) return scopes.filter((scope) => scope.repositoryId === repositoryId).some((scope) => scope.patterns.some((pattern) => matchPath(pattern, relativePath)));
    return (kind === "allowed" ? assignment.allowedPaths : assignment.forbiddenPaths).some((pattern) => matchPath(pattern, relativePath));
  }
  private resolveReportedPath(raw: string) { const prefixed = /^([a-z0-9-]+):(.*)$/i.exec(raw); const candidate = prefixed ? this.topology.resolveProjectPath(prefixed[1]!, prefixed[2]!) : (() => { const relative = toPortablePath(raw); if (this.topology.topology.repositories.length !== 1) throw new Error("ambiguous repository path; use repositoryId:path"); return this.topology.resolveProjectPath(this.topology.topology.repositories[0]!.id, relative); })(); return candidate; }
  async assertSafePath(repositoryId: string, relativePath: string): Promise<void> { const candidate = this.topology.resolveProjectPath(repositoryId, relativePath); let probe = candidate.absolutePath; while (true) { try { await lstat(probe); const resolved = await realpath(probe); if (!this.topology.repositoryForPath(resolved)) throw new Error(`Symlink/junction escapes repository root: ${relativePath}`); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const next = path.dirname(probe); if (next === probe) throw error; probe = next; } } }
}
