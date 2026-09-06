import { ArchitectAgent } from "./agents/architect";
import { BackendAgent } from "./agents/backend";
import { FrontendAgent } from "./agents/frontend";
import { projectInstructions } from "./agents/agent-context";
import { CodexAppServerClient } from "./codex/app-server-client";
import { ProjectRegistryStore } from "./projects/project-registry";
import { TopologyService } from "./projects/project-topology";
import { OwnershipVerifier } from "./projects/ownership";
import { OrchestratorStateStore } from "./state/orchestrator-state";
import { WorkflowStore } from "./workflows/workflow-store";

const root = process.cwd();
const index = process.argv.indexOf("--project");
if (index < 0 || !process.argv[index + 1]) throw new Error("Missing project. Use: npm run dev -- --project <project-id>");
const projectId = process.argv[index + 1]!.trim().toLowerCase();
const registry = new ProjectRegistryStore(root); const project = await registry.getProject(projectId);
const topology = new TopologyService(project.topology); const architectContext = projectInstructions(project, "architect"); const backendContext = projectInstructions(project, "backend"); const frontendContext = projectInstructions(project, "frontend");
const workflows = new WorkflowStore(root); const recoverable = await workflows.recoverable(project.id);
console.log(`Project ${project.name} (${project.id})`); console.log(`Workspace: ${project.topology.workspaceRoot}`); console.log(`Repositories: ${project.topology.repositories.map((item) => item.id).join(", ")}`); console.log(`Recoverable workflows: ${recoverable.length}`);
// Initialization intentionally does not create turns or dispatch developer work.
const client = new CodexAppServerClient(); const stateStore = new OrchestratorStateStore(root);
void [client, stateStore, topology, new OwnershipVerifier(topology), new ArchitectAgent(client, architectContext.cwd, architectContext.instructions), new BackendAgent(client, backendContext.cwd, backendContext.instructions), new FrontendAgent(client, frontendContext.cwd, frontendContext.instructions)];
