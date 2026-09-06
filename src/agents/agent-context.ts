import type { ProjectDefinition } from "../projects/project-registry";
import { TopologyService, type Role } from "../projects/project-topology";

export function projectInstructions(project: ProjectDefinition, role: Role): { cwd: string; instructions: string } {
  const topology = new TopologyService(project.topology);
  const lines = project.topology.repositories.map((repository) => {
    const readable = repository.ownership.filter((rule) => rule.readableBy.includes(role) || role === "architect").map((rule) => rule.pattern);
    const writable = repository.ownership.filter((rule) => rule.writableBy.includes(role)).map((rule) => rule.pattern);
    const controlled = repository.ownership.filter((rule) => rule.architectControlled).map((rule) => rule.pattern);
    return `Repository ${repository.id} (${repository.root})\nRead: ${readable.join(", ") || "none"}\nWrite: ${writable.join(", ") || "none"}\nArchitect-controlled: ${controlled.join(", ") || "none"}`;
  });
  return { cwd: topology.workspaceFor(role), instructions: `\nProject topology for ${project.name} (${project.id}):\nWorkspace: ${project.topology.workspaceRoot}\n${lines.join("\n\n")}\nThese rules are enforced by the orchestrator. Report repository-relative files as repositoryId:path.` };
}
