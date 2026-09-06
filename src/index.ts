import { ArchitectAgent } from "./agents/architect";
import { BackendAgent } from "./agents/backend";
import { FrontendAgent } from "./agents/frontend";
import { projectInstructions } from "./agents/agent-context";
import { CodexAppServerClient } from "./codex/app-server-client";
import { TeamRouter } from "./orchestration/team-router";
import { OwnershipVerifier } from "./projects/ownership";
import { ProjectRegistryStore } from "./projects/project-registry";
import { TopologyService } from "./projects/project-topology";
import { OrchestratorStateStore } from "./state/orchestrator-state";
import { WorkflowEngine } from "./workflows/workflow-engine";
import { WorkflowRecovery } from "./workflows/workflow-recovery";
import { WorkflowRunner } from "./workflows/workflow-runner";
import { WorkflowStore } from "./workflows/workflow-store";

const root = process.cwd(); const position = process.argv.indexOf("--project");
if (position < 0 || !process.argv[position + 1]) throw new Error("Missing project. Use: npm run dev -- --project <project-id>");
const projectId = process.argv[position + 1]!.trim().toLowerCase();
const registry = new ProjectRegistryStore(root); const project = await registry.getProject(projectId);
const topology = new TopologyService(project.topology); const client = new CodexAppServerClient(); const stateStore = new OrchestratorStateStore(root); const state = await stateStore.load();
await client.start();
const architect = new ArchitectAgent(client, projectInstructions(project, "architect").cwd, projectInstructions(project, "architect").instructions);
const backend = new BackendAgent(client, projectInstructions(project, "backend").cwd, projectInstructions(project, "backend").instructions);
const frontend = new FrontendAgent(client, projectInstructions(project, "frontend").cwd, projectInstructions(project, "frontend").instructions);
for (const [role, agent] of [["architect", architect], ["backend", backend], ["frontend", frontend]] as const) { const result = await agent.start(stateStore.getProjectState(state, project.id).agents[role]?.threadId); await stateStore.saveAgent(state, project.id, role, { threadId: result.response.thread.id }); }
const store = new WorkflowStore(root); const engine = new WorkflowEngine(store); const ownership = new OwnershipVerifier(topology); const router = new TeamRouter(backend, frontend); const runner = new WorkflowRunner(engine, store, architect, router, ownership); const recovery = new WorkflowRecovery(engine, client);
const recoverable = await recovery.discover(project.id);
console.log(`Project ${project.name} (${project.id}); recoverable workflows: ${recoverable.length}`);
for (const workflow of recoverable) { if (workflow.state === "WAITING_FOR_OWNER_INPUT" || workflow.state === "PAUSED_MANUAL" || workflow.state === "BLOCKED") { console.log(`${workflow.id}: ${workflow.state} needs intervention`); continue; } const eligible = workflow.state === "PAUSED_RATE_LIMIT" ? await recovery.resumeRateLimited(workflow) : workflow; if (eligible.state === "PAUSED_RATE_LIMIT") continue; await runner.runUntilPauseOrTerminal(eligible); }
