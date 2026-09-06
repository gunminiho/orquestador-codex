import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { ProjectIdSchema, WorkflowIdSchema, WorkflowSchema, type Workflow, isTerminal } from "./workflow-schema";

export class WorkflowStore {
  constructor(private readonly root: string) {}
  private dir(projectId: string) { return path.resolve(this.root, ".orchestrator", "workflows", ProjectIdSchema.parse(projectId)); }
  private file(projectId: string, id: string) { const directory = this.dir(projectId); const file = path.resolve(directory, `${WorkflowIdSchema.parse(id)}.json`); const relative = path.relative(directory, file); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workflow path escapes store"); return file; }
  async save(workflow: Workflow) { const value = WorkflowSchema.parse(workflow); const directory = this.dir(value.projectId); await mkdir(directory, { recursive: true }); const file = this.file(value.projectId, value.id); const temporary = `${file}.${process.pid}.${Date.now()}.tmp`; const handle = await open(temporary, "w"); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  async get(projectId: string, id: string) { return WorkflowSchema.parse(JSON.parse(await readFile(this.file(projectId, id), "utf8"))); }
  async list(projectId: string): Promise<Workflow[]> { const directory = this.dir(projectId); try { const names = await readdir(directory); return await Promise.all(names.filter((name) => name.endsWith(".json") && !name.includes(".tmp")).map(async (name) => WorkflowSchema.parse(JSON.parse(await readFile(path.join(directory, name), "utf8"))))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  async recoverable(projectId: string) { return (await this.list(projectId)).filter((workflow) => !isTerminal(workflow.state)); }
}
