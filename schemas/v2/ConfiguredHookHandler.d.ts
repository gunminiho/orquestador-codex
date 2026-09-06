import type { JsonValue } from "../serde_json/JsonValue";
export type ConfiguredHookHandler = {
    "type": "command";
    command: string;
    commandWindows: string | null;
    timeoutSec: bigint | null;
    async: boolean;
    statusMessage: string | null;
    /**
     * Approximate token threshold for spilling this hook's `additionalContext` to disk.
     * `null` uses 2,500 tokens; `0` disables spilling for this hook. The threshold is
     * evaluated against the original context; a spilled preview also includes recovery
     * metadata.
     */
    additionalContextLimit: number | null;
} | {
    "type": "mcp_tool";
    server: string;
    tool: string;
    input: {
        [key in string]?: JsonValue;
    };
    timeoutSec: bigint | null;
    statusMessage: string | null;
} | {
    "type": "prompt";
} | {
    "type": "agent";
};
//# sourceMappingURL=ConfiguredHookHandler.d.ts.map