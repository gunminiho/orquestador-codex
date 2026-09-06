import { mkdir, readFile, rename, writeFile, } from "node:fs/promises";
import path from "node:path";
const EMPTY_STATE = {
    version: 2,
    projects: {},
};
export class OrchestratorStateStore {
    directory;
    file;
    constructor(rootDirectory) {
        this.directory = path.join(rootDirectory, ".orchestrator");
        this.file = path.join(this.directory, "state.json");
    }
    async load() {
        try {
            const content = await readFile(this.file, "utf8");
            const parsed = JSON.parse(content);
            if (this.isV2State(parsed)) {
                return parsed;
            }
            if (this.isLegacyState(parsed)) {
                return this.migrateLegacyState(parsed);
            }
            throw new Error("Unsupported orchestrator state format.");
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT") {
                return structuredClone(EMPTY_STATE);
            }
            throw error;
        }
    }
    async save(state) {
        await mkdir(this.directory, {
            recursive: true,
        });
        await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }
    getProjectState(state, projectId) {
        return (state.projects[projectId] ?? {
            agents: {},
        });
    }
    async saveAgent(state, projectId, role, agent) {
        const project = state.projects[projectId] ?? {
            agents: {},
        };
        project.agents[role] = agent;
        state.projects[projectId] =
            project;
        await this.save(state);
    }
    isV2State(value) {
        if (typeof value !== "object" ||
            value === null) {
            return false;
        }
        const candidate = value;
        return (candidate.version === 2 &&
            typeof candidate.projects ===
                "object" &&
            candidate.projects !== null);
    }
    isLegacyState(value) {
        if (typeof value !== "object" ||
            value === null) {
            return false;
        }
        return "agents" in value;
    }
    async migrateLegacyState(legacy) {
        await mkdir(this.directory, {
            recursive: true,
        });
        const backup = path.join(this.directory, `state.legacy.${Date.now()}.json`);
        await rename(this.file, backup);
        console.log("[STATE] Legacy global-agent state detected.");
        console.log(`[STATE] Backup created: ${backup}`);
        console.log("[STATE] Legacy agent threads were NOT assigned to any project.");
        console.log("[STATE] Starting clean project-scoped state.");
        const state = structuredClone(EMPTY_STATE);
        await this.save(state);
        return state;
    }
}
//# sourceMappingURL=orchestrator-state.js.map