import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";

import path from "node:path";

export type AgentRole =
  | "architect"
  | "backend"
  | "frontend";

export type AgentState = {
  threadId: string;
};

export type ProjectAgentState = {
  agents: Partial<
    Record<AgentRole, AgentState>
  >;
};

export type OrchestratorState = {
  version: 2;

  projects: Record<
    string,
    ProjectAgentState
  >;
};

type LegacyOrchestratorState = {
  agents?: {
    architect?: AgentState;
    backend?: AgentState;
    frontend?: AgentState;
  };
};

const EMPTY_STATE: OrchestratorState = {
  version: 2,
  projects: {},
};

export class OrchestratorStateStore {
  private readonly directory: string;
  private readonly file: string;

  constructor(rootDirectory: string) {
    this.directory = path.join(
      rootDirectory,
      ".orchestrator",
    );

    this.file = path.join(
      this.directory,
      "state.json",
    );
  }

  async load(): Promise<OrchestratorState> {
    try {
      const content = await readFile(
        this.file,
        "utf8",
      );

      const parsed =
        JSON.parse(content) as unknown;

      if (this.isV2State(parsed)) {
        return parsed;
      }

      if (this.isLegacyState(parsed)) {
        return this.migrateLegacyState(
          parsed,
        );
      }

      throw new Error(
        "Unsupported orchestrator state format.",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return structuredClone(
          EMPTY_STATE,
        );
      }

      throw error;
    }
  }

  async save(
    state: OrchestratorState,
  ): Promise<void> {
    await mkdir(
      this.directory,
      {
        recursive: true,
      },
    );

    await writeFile(
      this.file,
      `${JSON.stringify(
        state,
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  getProjectState(
    state: OrchestratorState,
    projectId: string,
  ): ProjectAgentState {
    return (
      state.projects[projectId] ?? {
        agents: {},
      }
    );
  }

  async saveAgent(
    state: OrchestratorState,
    projectId: string,
    role: AgentRole,
    agent: AgentState,
  ): Promise<void> {
    const project =
      state.projects[projectId] ?? {
        agents: {},
      };

    project.agents[role] = agent;

    state.projects[projectId] =
      project;

    await this.save(state);
  }

  private isV2State(
    value: unknown,
  ): value is OrchestratorState {
    if (
      typeof value !== "object" ||
      value === null
    ) {
      return false;
    }

    const candidate =
      value as Record<string, unknown>;

    return (
      candidate.version === 2 &&
      typeof candidate.projects ===
        "object" &&
      candidate.projects !== null
    );
  }

  private isLegacyState(
    value: unknown,
  ): value is LegacyOrchestratorState {
    if (
      typeof value !== "object" ||
      value === null
    ) {
      return false;
    }

    return "agents" in value;
  }

  private async migrateLegacyState(
    legacy: LegacyOrchestratorState,
  ): Promise<OrchestratorState> {
    await mkdir(
      this.directory,
      {
        recursive: true,
      },
    );

    const backup = path.join(
      this.directory,
      `state.legacy.${Date.now()}.json`,
    );

    await rename(
      this.file,
      backup,
    );

    console.log(
      "[STATE] Legacy global-agent state detected.",
    );

    console.log(
      `[STATE] Backup created: ${backup}`,
    );

    console.log(
      "[STATE] Preserving legacy threads under legacy-unassigned; move them to the registered project before use.",
    );

    const state: OrchestratorState = {
      version: 2,
      projects: {
        "legacy-unassigned": {
          agents: legacy.agents ?? {},
        },
      },
    };

    await this.save(state);

    return state;
  }
}
