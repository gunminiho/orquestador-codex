import type { InitializeResponse } from "../../schemas/InitializeResponse";
import type { ClientNotification } from "../../schemas/ClientNotification";
import type { ServerNotification } from "../../schemas/ServerNotification";
import type { ThreadResumeParams } from "../../schemas/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "../../schemas/v2/ThreadResumeResponse";
import type { ThreadStartParams } from "../../schemas/v2/ThreadStartParams";
import type { ThreadStartResponse } from "../../schemas/v2/ThreadStartResponse";
import type { Turn } from "../../schemas/v2/Turn";
type NotificationListener = (notification: ServerNotification) => void;
export type RunTurnResult = {
    turnId: string;
    text: string;
    turn: Turn;
};
export declare class CodexAppServerClient {
    private child;
    private nextRequestId;
    private readonly pendingRequests;
    private readonly notificationListeners;
    private readonly completedTurns;
    private readonly streamedAgentText;
    start(): Promise<InitializeResponse>;
    startThread(params: ThreadStartParams): Promise<ThreadStartResponse>;
    resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
    runTurn(threadId: string, text: string): Promise<RunTurnResult>;
    request<T>(method: string, params: unknown): Promise<T>;
    notify(notification: ClientNotification): void;
    onNotification(listener: NotificationListener): () => void;
    stop(): void;
    private waitForTurnCompletion;
    private extractFinalAgentMessage;
    private spawnCodexAppServer;
    private send;
    private handleServerLine;
    private handleRpcResponse;
    private handleNotification;
    private isRpcResponse;
    private isServerNotification;
    private turnKey;
    private rejectAllPendingRequests;
}
export {};
//# sourceMappingURL=app-server-client.d.ts.map