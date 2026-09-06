import { createInterface, } from "node:readline/promises";
import { stdin as input, stdout as output, } from "node:process";
import { ProjectRegistryStore, } from "../projects/project-registry";
const rl = createInterface({
    input,
    output,
});
const registry = new ProjectRegistryStore(process.cwd());
try {
    const projects = await registry.listProjects();
    console.log("");
    console.log("========================================");
    console.log(" REMOVE PROJECT");
    console.log("========================================");
    console.log("");
    if (projects.length === 0) {
        console.log("No projects registered.");
        process.exit(0);
    }
    console.log("Registered projects:");
    console.log("");
    for (const project of projects) {
        console.log(`- ${project.id} (${project.name})`);
    }
    console.log("");
    const id = await rl.question("Project ID to remove: ");
    const project = projects.find((candidate) => candidate.id ===
        id.trim().toLowerCase());
    if (!project) {
        throw new Error(`Project "${id}" is not registered.`);
    }
    console.log("");
    console.log(`Project : ${project.name}`);
    console.log(`ID      : ${project.id}`);
    console.log(`Root    : ${project.root}`);
    console.log("");
    console.log("The project directory will NOT be deleted.");
    console.log("Only its orchestrator registration will be removed.");
    console.log("");
    const confirmation = await rl.question(`Type "${project.id}" to confirm: `);
    if (confirmation.trim() !==
        project.id) {
        console.log("");
        console.log("Removal cancelled.");
        process.exit(0);
    }
    const removed = await registry.removeProject(project.id);
    console.log("");
    console.log("✓ Project removed from orchestrator");
    console.log(`  ID   : ${removed.id}`);
    console.log(`  Name : ${removed.name}`);
    console.log("");
    console.log("✓ Project files were not modified.");
    console.log("");
}
catch (error) {
    console.error("");
    console.error("✗ Could not remove project.");
    console.error(error instanceof Error
        ? error.message
        : error);
    process.exitCode = 1;
}
finally {
    rl.close();
}
//# sourceMappingURL=project-remove.js.map