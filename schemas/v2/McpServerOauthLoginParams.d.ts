import type { McpServerOauthClientRegistration } from "./McpServerOauthClientRegistration";
export type McpServerOauthLoginParams = {
    name: string;
    threadId?: string | null;
    /**
     * Registration strategy for this login only; omission selects automatic discovery.
     */
    clientRegistration?: McpServerOauthClientRegistration | null;
    scopes?: Array<string> | null;
    timeoutSecs?: bigint | null;
};
//# sourceMappingURL=McpServerOauthLoginParams.d.ts.map