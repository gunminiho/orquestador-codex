import type { McpServerInfo } from "../McpServerInfo";
import type { Resource } from "../Resource";
import type { ResourceTemplate } from "../ResourceTemplate";
import type { Tool } from "../Tool";
import type { McpAuthStatus } from "./McpAuthStatus";
import type { McpServerConnectionStatus } from "./McpServerConnectionStatus";
export type McpServerStatus = {
    name: string;
    /**
     * Current thread-runtime connection state; null when unavailable or the configuration changed.
     */
    runtimeStatus: McpServerConnectionStatus | null;
    pluginId: string | null;
    serverInfo: McpServerInfo | null;
    tools: {
        [key in string]?: Tool;
    };
    resources: Array<Resource>;
    resourceTemplates: Array<ResourceTemplate>;
    authStatus: McpAuthStatus;
};
//# sourceMappingURL=McpServerStatus.d.ts.map