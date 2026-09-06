import { ProjectRegistryStore } from "../projects/project-registry";

const args = process.argv.slice(2); const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const command = args[0]; const projectId = value("--project"); const registry = new ProjectRegistryStore(process.cwd());
if (!command || !projectId) throw new Error("Usage: project:<action> --project <id> [options]");
if (command === "show") { console.log(JSON.stringify(await registry.getProject(projectId), null, 2)); }
else if (command === "repo:add") { const id = value("--repo"); const root = value("--root"); if (!id || !root) throw new Error("repo:add requires --repo and --root"); console.log(JSON.stringify(await registry.addRepository(projectId, { id, root, metadata: {}, ownership: [] }), null, 2)); }
else if (command === "repo:remove") { const id = value("--repo"); if (!id) throw new Error("repo:remove requires --repo"); await registry.removeRepository(projectId, id); }
else if (command === "ownership:list") { const project = await registry.getProject(projectId); console.log(JSON.stringify(project.topology.repositories.map((repo) => ({ repository: repo.id, ownership: repo.ownership })), null, 2)); }
else if (command === "ownership:add") { const repo = value("--repo"); const pattern = value("--pattern"); const write = value("--write")?.split(",").filter(Boolean) ?? []; const read = value("--read")?.split(",").filter(Boolean) ?? ["architect"]; if (!repo || !pattern) throw new Error("ownership:add requires --repo and --pattern"); await registry.addOwnership(projectId, repo, { pattern, readableBy: read, writableBy: write, architectControlled: args.includes("--architect-controlled") }); }
else if (command === "ownership:remove") { const repo = value("--repo"); const pattern = value("--pattern"); if (!repo || !pattern) throw new Error("ownership:remove requires --repo and --pattern"); await registry.removeOwnership(projectId, repo, pattern); }
else if (command === "agent-workspace:set") { const role = value("--role"); const repo = value("--repo"); const cwd = value("--cwd"); if (!role || (!repo && !cwd)) throw new Error("agent-workspace:set requires --role and --repo or --cwd"); await registry.setAgentWorkspace(projectId, role, { ...(repo ? { repositoryId: repo } : {}), ...(cwd ? { cwd } : {}) }); }
else throw new Error(`Unknown topology command: ${command}`);
