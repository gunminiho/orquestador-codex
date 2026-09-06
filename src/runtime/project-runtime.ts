import { ArchitectAgent } from "../agents/architect";
import { BackendAgent } from "../agents/backend";
import { FrontendAgent } from "../agents/frontend";
import { projectInstructions } from "../agents/agent-context";
import { CodexAppServerClient } from "../codex/app-server-client";
import { TeamRouter } from "../orchestration/team-router";
import { OwnershipVerifier } from "../projects/ownership";
import { ProjectRegistryStore } from "../projects/project-registry";
import { TopologyService } from "../projects/project-topology";
import { OrchestratorStateStore } from "../state/orchestrator-state";
import { RateLimitScheduler } from "../workflows/rate-limit-scheduler";
import { WorkflowEngine } from "../workflows/workflow-engine";
import { WorkflowRunner } from "../workflows/workflow-runner";
import { WorkflowStore } from "../workflows/workflow-store";

export class ProjectRuntime {
  readonly scheduler: RateLimitScheduler;
  private constructor(readonly projectId: string, readonly client: CodexAppServerClient, readonly store: WorkflowStore, readonly engine: WorkflowEngine, readonly runner: WorkflowRunner) { this.scheduler = new RateLimitScheduler(engine, client); }
  async execute(workflowId: string) { let workflow = await this.store.get(this.projectId, workflowId); if (workflow.state === "PAUSED_RATE_LIMIT") workflow = await this.scheduler.waitForAvailability(workflow); return this.runner.runUntilPauseOrTerminal(workflow); }
  async stop() { this.client.stop(); }
  static async create(root: string, projectId: string): Promise<ProjectRuntime> {
    const project = await new ProjectRegistryStore(root).getProject(projectId); const client = new CodexAppServerClient(); const stateStore = new OrchestratorStateStore(root); const state = await stateStore.load(); await client.start();
    const architect = new ArchitectAgent(client, projectInstructions(project, "architect").cwd, projectInstructions(project, "architect").instructions); const backend = new BackendAgent(client, projectInstructions(project, "backend").cwd, projectInstructions(project, "backend").instructions); const frontend = new FrontendAgent(client, projectInstructions(project, "frontend").cwd, projectInstructions(project, "frontend").instructions);
    for (const [role, agent] of [["architect", architect], ["backend", backend], ["frontend", frontend]] as const) { const started = await agent.start(stateStore.getProjectState(state, project.id).agents[role]?.threadId); await stateStore.saveAgent(state, project.id, role, { threadId: started.response.thread.id }); }
    const store = new WorkflowStore(root); const engine = new WorkflowEngine(store); const ownership = new OwnershipVerifier(new TopologyService(project.topology)); const runner = new WorkflowRunner(engine, store, architect, new TeamRouter(backend, frontend), ownership); return new ProjectRuntime(project.id, client, store, engine, runner);
  }
}
