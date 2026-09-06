import { atomicReplace } from "../state/atomic-file";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  ProjectIdSchema,
  WorkflowIdSchema,
  WorkflowSchema,
  type Workflow,
  isTerminal,
} from "./workflow-schema";

export class WorkflowStore {
  constructor(private readonly root: string) {}
  private dir(projectId: string) {
    return path.resolve(
      this.root,
      ".orchestrator",
      "workflows",
      ProjectIdSchema.parse(projectId),
    );
  }
  private file(projectId: string, id: string) {
    return path.join(this.dir(projectId), `${WorkflowIdSchema.parse(id)}.json`);
  }
  private async atomicWrite(file: string, value: unknown): Promise<string> {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  }
  async save(workflow: Workflow): Promise<void> {
    let value = WorkflowSchema.parse(workflow);
    const file = this.file(value.projectId, value.id);
    await mkdir(this.dir(value.projectId), { recursive: true });
    try {
      const parsed = WorkflowSchema.safeParse(
        JSON.parse(await readFile(file, "utf8")),
      );
      if (parsed.success) {
        const latest = parsed.data;
        if (isTerminal(latest.state)) return;
        if (await this.cancellationTime(value.projectId, value.id)) {
          value =
            value.state === "CANCELLED"
              ? {
                  ...latest,
                  state: "CANCELLED",
                  cancellationRequestedAt: await this.cancellationTime(
                    value.projectId,
                    value.id,
                  ),
                  activeTurn: null,
                  attempts: latest.attempts.map((a) =>
                    a.reportPersisted
                      ? a
                      : {
                          ...a,
                          status: "CANCELLED",
                          completedAt: new Date().toISOString(),
                        },
                  ),
                }
              : {
                  ...latest,
                  worktrees: [
                    ...new Map(
                      [...latest.worktrees, ...value.worktrees].map((w) => [
                        w.worktreePath,
                        w,
                      ]),
                    ).values(),
                  ],
                };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = await this.atomicWrite(file, value);
    await atomicReplace(temporary, file);
  }

  /**
   * Delivery is the only mutable part of an approved workflow. Keeping it in a
   * narrow store operation prevents late runtime events from replacing a
   * terminal workflow while still making result commits durable before cleanup.
   */
  async saveApprovedDeliveries(
    projectId: string,
    id: string,
    deliveries: Workflow["deliveries"],
  ): Promise<Workflow> {
    const latest = await this.get(projectId, id);
    if (latest.state !== "APPROVED") {
      throw new Error(
        "Only an approved workflow can persist delivery metadata",
      );
    }
    const merged = new Map(
      latest.deliveries.map((delivery) => [
        `${delivery.repositoryId}:${delivery.taskId}`,
        delivery,
      ]),
    );
    for (const delivery of deliveries) {
      merged.set(`${delivery.repositoryId}:${delivery.taskId}`, delivery);
    }
    const value = WorkflowSchema.parse({
      ...latest,
      deliveries: [...merged.values()],
      updatedAt: new Date().toISOString(),
    });
    const temporary = await this.atomicWrite(this.file(projectId, id), value);
    await atomicReplace(temporary, this.file(projectId, id));
    return this.get(projectId, id);
  }
  private async cancellationTime(
    projectId: string,
    id: string,
  ): Promise<string | null> {
    try {
      return (
        JSON.parse(
          await readFile(this.file(projectId, id) + ".cancel", "utf8"),
        ) as { at: string }
      ).at;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async get(projectId: string, id: string): Promise<Workflow> {
    const workflow = await this.readAndMigrate(this.file(projectId, id));
    workflow.cancellationRequestedAt =
      (await this.cancellationTime(projectId, id)) ??
      workflow.cancellationRequestedAt;
    try {
      await readFile(this.file(projectId, id) + ".cancelled");
      workflow.state = "CANCELLED";
      workflow.activeTurn = null;
      workflow.attempts = workflow.attempts.map((a) =>
        a.reportPersisted
          ? a
          : {
              ...a,
              status: "CANCELLED",
              completedAt: a.completedAt ?? workflow.cancellationRequestedAt,
            },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return workflow;
  }
  async finishCancellation(projectId: string, id: string): Promise<Workflow> {
    await this.requestCancellation(projectId, id);
    const file = this.file(projectId, id) + ".cancelled";
    const temporary = await this.atomicWrite(file, {
      at: new Date().toISOString(),
    });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary);
    }
    const workflow = await this.get(projectId, id);
    await this.save(workflow);
    return this.get(projectId, id);
  }
  async requestCancellation(projectId: string, id: string): Promise<Workflow> {
    const latest = await this.get(projectId, id);
    if (isTerminal(latest.state)) return latest;
    const file = this.file(projectId, id) + ".cancel";
    const temporary = await this.atomicWrite(file, {
      at: new Date().toISOString(),
    });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary);
    }
    return this.get(projectId, id);
  }
  async list(projectId: string): Promise<Workflow[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(projectId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.get(projectId, name.slice(0, -5))),
    );
  }
  async recoverable(projectId: string) {
    return (await this.list(projectId)).filter(
      (workflow) => !isTerminal(workflow.state),
    );
  }
  private async readAndMigrate(file: string): Promise<Workflow> {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    const parsed = WorkflowSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    const legacy = value as Record<string, unknown>;
    if (legacy.version !== 1)
      throw new Error(`Unsupported workflow format: ${file}`);
    await copyFile(file, `${file}.v1.${crypto.randomUUID()}.bak`);
    const workflow = WorkflowSchema.parse({
      ...legacy,
      version: 2,
      transient: null,
      ownerInput: null,
      baselines: [],
      allowedScopes: [],
      forbiddenScopes: [],
    });
    await this.save(workflow);
    return workflow;
  }
}
