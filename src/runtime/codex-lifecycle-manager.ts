import { ArchitectAgent } from "../agents/architect";
import { BackendAgent } from "../agents/backend";
import { FrontendAgent } from "../agents/frontend";
import { projectInstructions } from "../agents/agent-context";
import { CodexAppServerClient } from "../codex/app-server-client";
import type { ProjectDefinition } from "../projects/project-registry";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import type { Workflow } from "../workflows/workflow-schema";
import { WorkflowStore } from "../workflows/workflow-store";
import { WorkflowEngine } from "../workflows/workflow-engine";
import {
  abortableTimeout,
  sleepUntil,
  throwIfShutdown,
} from "./shutdown";

/** Owns transport readiness and the persistent role agents across server generations. */
export class CodexLifecycleManager {
  readonly architect: ArchitectAgent;
  readonly backend: BackendAgent;
  readonly frontend: FrontendAgent;
  private ready = false;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly project: ProjectDefinition,
    private readonly stateStore: OrchestratorStateStore,
    readonly client = new CodexAppServerClient(),
    agents?: {
      architect: ArchitectAgent;
      backend: BackendAgent;
      frontend: FrontendAgent;
    },
  ) {
    const context = (role: string) => projectInstructions(project, role);
    this.architect =
      agents?.architect ??
      new ArchitectAgent(
        client,
        context("architect").cwd,
        context("architect").instructions,
      );
    this.backend =
      agents?.backend ??
      new BackendAgent(
        client,
        context("backend").cwd,
        context("backend").instructions,
      );
    this.frontend =
      agents?.frontend ??
      new FrontendAgent(
        client,
        context("frontend").cwd,
        context("frontend").instructions,
      );
    client.onExit(() => {
      this.ready = false;
    });
  }

  async start(signal?: AbortSignal): Promise<void> {
    throwIfShutdown(signal);
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.initialize(signal);
    try {
      await this.starting;
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    throwIfShutdown(signal);
    // Client.start performs initialize and initialized before resolving.
    await this.client.start();
    throwIfShutdown(signal);
    const state = await this.stateStore.load();
    for (const [role, agent] of [
      ["architect", this.architect],
      ["backend", this.backend],
      ["frontend", this.frontend],
    ] as const) {
      throwIfShutdown(signal);
      const persisted = this.stateStore.getProjectState(state, this.project.id)
        .agents[role]?.threadId;
      const started = await agent.start(persisted);
      throwIfShutdown(signal);
      await this.stateStore.saveAgent(state, this.project.id, role, {
        threadId: started.response.thread.id,
      });
    }
    this.ready = true;
  }

  stop(): void {
    this.ready = false;
    this.client.stop();
  }

  async restart(signal?: AbortSignal): Promise<void> {
    throwIfShutdown(signal);
    this.stop();
    throwIfShutdown(signal);
    await this.start(signal);
  }

  async recover(
    workflow: Workflow,
    store: WorkflowStore,
    engine: WorkflowEngine,
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void> =
      abortableTimeout,
    now = () => Date.now(),
    signal?: AbortSignal,
  ): Promise<Workflow> {
    throwIfShutdown(signal);
    let latest = await store.get(workflow.projectId, workflow.id);
    while (
      latest.state === "PAUSED_TRANSIENT" &&
      !latest.cancellationRequestedAt
    ) {
      throwIfShutdown(signal);
      const remaining = Date.parse(latest.transient!.retryAt) - now();
      if (remaining > 0) {
        await sleepUntil(sleep, Math.min(remaining, 1000), signal);
        latest = await store.get(workflow.projectId, workflow.id);
        continue;
      }
      await this.restart(signal);
      throwIfShutdown(signal);
      latest = await store.get(workflow.projectId, workflow.id);
      if (latest.state !== "PAUSED_TRANSIENT" || latest.cancellationRequestedAt)
        return latest;
      const threadIds = {
        architect: this.architect.getThreadId(),
        backend: this.backend.getThreadId(),
        frontend: this.frontend.getThreadId(),
      };
      await store.save({ ...latest, threadIds });
      return engine.resumePaused(
        await store.get(workflow.projectId, workflow.id),
      );
    }
    return latest;
  }
}
