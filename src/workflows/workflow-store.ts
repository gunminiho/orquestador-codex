import { mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowSchema, type Workflow, isTerminal } from "./workflow-schema";
export class WorkflowStore {
 constructor(private readonly root: string) {}
 private dir(projectId: string) { return path.join(this.root, ".orchestrator", "workflows", projectId); }
 private file(projectId: string, id: string) { return path.join(this.dir(projectId), `${id}.json`); }
 async save(workflow: Workflow) { const value = WorkflowSchema.parse(workflow); const directory = this.dir(value.projectId); await mkdir(directory, { recursive: true }); const file = this.file(value.projectId, value.id); const temporary = `${file}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, file); }
 async get(projectId: string, id: string) { return WorkflowSchema.parse(JSON.parse(await readFile(this.file(projectId,id), "utf8"))); }
 async list(projectId: string): Promise<Workflow[]> { try { const names = await readdir(this.dir(projectId)); return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => WorkflowSchema.parse(JSON.parse(await readFile(path.join(this.dir(projectId), name), "utf8"))))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
 async recoverable(projectId: string) { return (await this.list(projectId)).filter((workflow) => !isTerminal(workflow.state)); }
}
