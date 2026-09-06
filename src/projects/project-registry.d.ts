import { z } from "zod";
declare const ProjectSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    root: z.ZodString;
    createdAt: z.ZodString;
}, z.core.$strip>;
export type ProjectDefinition = z.infer<typeof ProjectSchema>;
declare const ProjectRegistrySchema: z.ZodObject<{
    projects: z.ZodRecord<z.ZodString, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        root: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;
export declare class ProjectRegistryStore {
    private readonly directory;
    private readonly file;
    constructor(orchestratorRoot: string);
    listProjects(): Promise<ProjectDefinition[]>;
    load(): Promise<ProjectRegistry>;
    save(registry: ProjectRegistry): Promise<void>;
    addProject(input: {
        id: string;
        name: string;
        root: string;
    }): Promise<ProjectDefinition>;
    removeProject(id: string): Promise<ProjectDefinition>;
    private assertDirectoryExists;
}
export {};
//# sourceMappingURL=project-registry.d.ts.map