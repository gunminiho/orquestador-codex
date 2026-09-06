import { ProjectRegistryStore, } from "../projects/project-registry";
const registry = new ProjectRegistryStore(process.cwd());
try {
    const projects = await registry.listProjects();
    console.log("");
    console.log("========================================");
    console.log(" REGISTERED PROJECTS");
    console.log("========================================");
    console.log("");
    if (projects.length === 0) {
        console.log("No projects registered.");
        console.log("");
        process.exit(0);
    }
    for (const project of projects) {
        console.log(`${project.id}`);
        console.log(`  Name    : ${project.name}`);
        console.log(`  Root    : ${project.root}`);
        console.log(`  Created : ${project.createdAt}`);
        console.log("");
    }
    console.log(`Total: ${projects.length} project${projects.length === 1
        ? ""
        : "s"}`);
    console.log("");
}
catch (error) {
    console.error("");
    console.error("✗ Could not list projects.");
    console.error(error instanceof Error
        ? error.message
        : error);
    process.exitCode = 1;
}
//# sourceMappingURL=project-list.js.map