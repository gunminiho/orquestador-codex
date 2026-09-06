export type AgentRole = "architect" | "backend" | "frontend";
export type AgentState = {
    threadId: string;
};
export type ProjectAgentState = {
    agents: Partial<Record<AgentRole, AgentState>>;
};
export type OrchestratorState = {
    version: 2;
    projects: Record<string, ProjectAgentState>;
};
export declare class OrchestratorStateStore {
    private readonly directory;
    private readonly file;
    constructor(rootDirectory: string);
    load(): Promise<OrchestratorState>;
    save(state: OrchestratorState): Promise<void>;
    getProjectState(state: OrchestratorState, projectId: string): ProjectAgentState;
    saveAgent(state: OrchestratorState, projectId: string, role: AgentRole, agent: AgentState): Promise<void>;
    private isV2State;
    private isLegacyState;
    private migrateLegacyState;
}
//# sourceMappingURL=orchestrator-state.d.ts.map