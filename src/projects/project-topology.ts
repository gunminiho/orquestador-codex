import path from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";

export const RoleSchema = z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/);
export type Role = z.infer<typeof RoleSchema>;

export const OwnershipRuleSchema = z.object({
  pattern: z.string().min(1),
  readableBy: z.array(RoleSchema).default([]),
  writableBy: z.array(RoleSchema).default([]),
  architectControlled: z.boolean().default(false),
});

export const RepositorySchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  root: z.string().min(1),
  metadata: z.record(z.string(), z.string()).default({}),
  ownership: z.array(OwnershipRuleSchema).default([]),
});

export const ProjectTopologySchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().min(1),
  repositories: z.array(RepositorySchema).min(1),
  agentWorkspaces: z.record(RoleSchema, z.object({ repositoryId: z.string().min(1).optional(), cwd: z.string().min(1).optional() })).default({}),
});
export type ProjectTopology = z.infer<typeof ProjectTopologySchema>;

export function normalizeAbsolutePath(input: string): string {
  return path.resolve(input).replace(/[\\/]+$/, "");
}

export function toPortablePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe repository-relative path: ${input}`);
  }
  return normalized;
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(normalizeAbsolutePath(root), normalizeAbsolutePath(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function matchPath(pattern: string, relativePath: string): boolean {
  const escaped = toPortablePath(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::GLOBSTAR::").replace(/\*/g, "[^/]*").replace(/::GLOBSTAR::/g, ".*");
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "i" : "").test(toPortablePath(relativePath));
}

export class TopologyService {
  constructor(readonly topology: ProjectTopology) {}

  repositoryForPath(filePath: string): { repository: ProjectTopology["repositories"][number]; relativePath: string } | null {
    const absolute = normalizeAbsolutePath(filePath);
    const matches = this.topology.repositories
      .filter((repository) => isPathWithin(repository.root, absolute))
      .sort((a, b) => b.root.length - a.root.length);
    const repository = matches[0];
    if (!repository) return null;
    return { repository, relativePath: toPortablePath(path.relative(repository.root, absolute)) };
  }

  resolveProjectPath(repositoryId: string, suppliedPath: string): { repository: ProjectTopology["repositories"][number]; absolutePath: string; relativePath: string } {
    const repository = this.topology.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error(`Unknown repository: ${repositoryId}`);
    const relativePath = toPortablePath(suppliedPath);
    const absolutePath = path.resolve(repository.root, relativePath);
    if (!isPathWithin(repository.root, absolutePath)) throw new Error(`Path escapes repository root: ${suppliedPath}`);
    return { repository, absolutePath, relativePath };
  }

  rulesFor(repositoryId: string, relativePath: string) {
    const repository = this.topology.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error(`Unknown repository: ${repositoryId}`);
    return repository.ownership.filter((rule) => matchPath(rule.pattern, relativePath));
  }

  may(role: Role, repositoryId: string, relativePath: string, action: "read" | "write"): boolean {
    if (role === "architect" && action === "read") return true;
    const rules = this.rulesFor(repositoryId, relativePath);
    if (action === "write" && role !== "architect" && rules.some((rule) => rule.architectControlled)) return false;
    return rules.some((rule) => (action === "read" ? rule.readableBy : rule.writableBy).includes(role));
  }

  isArchitectControlled(repositoryId: string, relativePath: string): boolean {
    return this.rulesFor(repositoryId, relativePath).some((rule) => rule.architectControlled);
  }

  readableRepositories(role: Role): string[] {
    return this.topology.repositories.filter((repository) => repository.ownership.some((rule) => rule.readableBy.includes(role)) || role === "architect").map((repository) => repository.id);
  }

  workspaceFor(role: Role): string {
    const selection = this.topology.agentWorkspaces[role];
    if (selection?.cwd) {
      const cwd = normalizeAbsolutePath(selection.cwd);
      if (!isPathWithin(this.topology.workspaceRoot, cwd)) throw new Error(`Agent cwd escapes workspace: ${cwd}`);
      return cwd;
    }
    if (selection?.repositoryId) {
      const repository = this.topology.repositories.find((item) => item.id === selection.repositoryId);
      if (!repository) throw new Error(`Unknown agent repository: ${selection.repositoryId}`);
      return repository.root;
    }
    return role === "architect" ? this.topology.workspaceRoot : this.topology.repositories[0]!.root;
  }

  async assertNoSymlinkEscape(absolutePath: string): Promise<void> {
    const location = this.repositoryForPath(absolutePath);
    if (!location) throw new Error(`Path is outside configured repositories: ${absolutePath}`);
    try {
      const resolved = await realpath(absolutePath);
      if (!isPathWithin(location.repository.root, resolved)) throw new Error(`Symlink escapes repository root: ${absolutePath}`);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
