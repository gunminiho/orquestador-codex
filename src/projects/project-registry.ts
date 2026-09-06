import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectTopologySchema, type ProjectTopology, normalizeAbsolutePath } from "./project-topology";

const LegacyProjectSchema = z.object({ id: z.string(), name: z.string(), root: z.string(), createdAt: z.string() });
const ProjectSchema = z.object({ id: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().min(1), createdAt: z.string(), topology: ProjectTopologySchema });
export type ProjectDefinition = z.infer<typeof ProjectSchema>;
const RegistrySchema = z.object({ version: z.literal(1), projects: z.record(z.string(), ProjectSchema) });
const LegacyRegistrySchema = z.object({ projects: z.record(z.string(), LegacyProjectSchema) });
export type ProjectRegistry = z.infer<typeof RegistrySchema>;
const EMPTY: ProjectRegistry = { version: 1, projects: {} };

export class ProjectRegistryStore {
  private readonly directory: string;
  private readonly file: string;
  constructor(root: string) { this.directory = path.join(root, ".orchestrator"); this.file = path.join(this.directory, "projects.json"); }
  async listProjects(): Promise<ProjectDefinition[]> { return Object.values((await this.load()).projects).sort((a, b) => a.name.localeCompare(b.name)); }
  async load(): Promise<ProjectRegistry> {
    try {
      const raw = await readFile(this.file, "utf8"); const parsed: unknown = JSON.parse(raw);
      const current = RegistrySchema.safeParse(parsed); if (current.success) return current.data;
      const legacy = LegacyRegistrySchema.safeParse(parsed); if (!legacy.success) throw new Error("Unsupported project registry format.");
      const migrated: ProjectRegistry = { version: 1, projects: Object.fromEntries(Object.entries(legacy.data.projects).map(([id, project]) => [id, this.fromLegacy(project)])) };
      await this.backupThenSave(raw, migrated, "projects.legacy"); return migrated;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY); throw error; }
  }
  async save(registry: ProjectRegistry): Promise<void> { RegistrySchema.parse(registry); await this.atomicWrite(`${JSON.stringify(registry, null, 2)}\n`); }
  async addProject(input: { id: string; name: string; root: string }): Promise<ProjectDefinition> {
    const root = normalizeAbsolutePath(input.root.trim()); await this.assertDirectory(root);
    return this.addTopology({ id: input.id, name: input.name, topology: { version: 1, workspaceRoot: root, repositories: [{ id: "main", root, metadata: {}, ownership: defaultOwnership() }], agentWorkspaces: { architect: { cwd: root }, backend: { repositoryId: "main" }, frontend: { repositoryId: "main" } } } });
  }
  async addTopology(input: { id: string; name: string; topology: ProjectTopology }): Promise<ProjectDefinition> {
    const id = input.id.trim().toLowerCase(); const topology = this.normalizeTopology(input.topology); for (const repository of topology.repositories) await this.assertDirectory(repository.root);
    const project = ProjectSchema.parse({ id, name: input.name.trim(), createdAt: new Date().toISOString(), topology }); const registry = await this.load(); if (registry.projects[id]) throw new Error(`Project "${id}" is already registered.`); registry.projects[id] = project; await this.save(registry); return project;
  }
  async removeProject(id: string): Promise<ProjectDefinition> { const registry = await this.load(); const key = id.trim().toLowerCase(); const project = registry.projects[key]; if (!project) throw new Error(`Project "${key}" is not registered.`); delete registry.projects[key]; await this.save(registry); return project; }
  async getProject(id: string): Promise<ProjectDefinition> { const project = (await this.load()).projects[id.trim().toLowerCase()]; if (!project) throw new Error(`Project "${id}" is not registered.`); return project; }
  private fromLegacy(project: z.infer<typeof LegacyProjectSchema>): ProjectDefinition { const root = normalizeAbsolutePath(project.root); return { id: project.id, name: project.name, createdAt: project.createdAt, topology: { version: 1, workspaceRoot: root, repositories: [{ id: "main", root, metadata: { migratedFrom: "legacy-single-root" }, ownership: defaultOwnership() }], agentWorkspaces: { architect: { cwd: root }, backend: { repositoryId: "main" }, frontend: { repositoryId: "main" } } } }; }
  private normalizeTopology(topology: ProjectTopology): ProjectTopology { const parsed = ProjectTopologySchema.parse(topology); const workspaceRoot = normalizeAbsolutePath(parsed.workspaceRoot); return { ...parsed, workspaceRoot, repositories: parsed.repositories.map((repository) => ({ ...repository, root: normalizeAbsolutePath(repository.root) })) }; }
  private async assertDirectory(target: string): Promise<void> { const info = await stat(target); if (!info.isDirectory()) throw new Error(`Project directory is not a directory: ${target}`); }
  private async backupThenSave(original: string, registry: ProjectRegistry, prefix: string): Promise<void> { await mkdir(this.directory, { recursive: true }); await writeFile(path.join(this.directory, `${prefix}.${Date.now()}.json`), original, "utf8"); await this.save(registry); }
  private async atomicWrite(content: string): Promise<void> { await mkdir(this.directory, { recursive: true }); const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, content, "utf8"); await rename(temporary, this.file); }
}
function defaultOwnership() { return [{ pattern: "**", readableBy: ["architect", "backend", "frontend"], writableBy: ["backend", "frontend"], architectControlled: false }]; }
