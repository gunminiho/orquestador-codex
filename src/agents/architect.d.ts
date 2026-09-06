import type { ThreadStartResponse } from "../../schemas/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../../schemas/v2/ThreadResumeResponse";
import { CodexAppServerClient, type RunTurnResult } from "../codex/app-server-client";
export declare class ArchitectAgent {
    private readonly client;
    private readonly cwd;
    private threadId;
    constructor(client: CodexAppServerClient, cwd: string);
    start(existingThreadId?: string): Promise<{
        mode: "created" | "resumed";
        response: ThreadStartResponse | ThreadResumeResponse;
    }>;
    send(message: string): Promise<RunTurnResult>;
    getThreadId(): string;
}
//# sourceMappingURL=architect.d.ts.map