import { mkdir, readFile, writeFile, stat, } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
const ProjectSchema = z.object({
    id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Project ID must use lowercase letters, numbers and hyphens only."),
    name: z.string().min(1),
    root: z.string().min(1),
    createdAt: z.string(),
});
const ProjectRegistrySchema = z.object({
    projects: z.record(z.string(), ProjectSchema),
});
const EMPTY_REGISTRY = {
    projects: {},
};
export class ProjectRegistryStore {
    directory;
    file;
    constructor(orchestratorRoot) {
        this.directory = path.join(orchestratorRoot, ".orchestrator");
        this.file = path.join(this.directory, "projects.json");
    }
    async listProjects() {
        const registry = await this.load();
        return Object.values(registry.projects).sort((a, b) => a.name.localeCompare(b.name));
    }
    async load() {
        try {
            const content = await readFile(this.file, "utf8");
            return ProjectRegistrySchema.parse(JSON.parse(content));
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT") {
                return structuredClone(EMPTY_REGISTRY);
            }
            throw error;
        }
    }
    async save(registry) {
        await mkdir(this.directory, {
            recursive: true,
        });
        await writeFile(this.file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    }
    async addProject(input) {
        const id = input.id
            .trim()
            .toLowerCase();
        const name = input.name.trim();
        const root = path.resolve(input.root.trim());
        const project = ProjectSchema.parse({
            id,
            name,
            root,
            createdAt: new Date().toISOString(),
        });
        await this.assertDirectoryExists(project.root);
        const registry = await this.load();
        if (registry.projects[id]) {
            throw new Error(`Project "${id}" is already registered.`);
        }
        registry.projects[id] =
            project;
        await this.save(registry);
        return project;
    }
    async removeProject(id) {
        const normalizedId = id.trim().toLowerCase();
        const registry = await this.load();
        const project = registry.projects[normalizedId];
        if (!project) {
            throw new Error(`Project "${normalizedId}" is not registered.`);
        }
        delete registry.projects[normalizedId];
        await this.save(registry);
        return project;
    }
    async assertDirectoryExists(root) {
        try {
            const info = await stat(root);
            if (!info.isDirectory()) {
                throw new Error(`"${root}" exists but is not a directory.`);
            }
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT") {
                throw new Error(`Project directory does not exist: ${root}`);
            }
            throw error;
        }
    }
}
//# sourceMappingURL=project-registry.js.map