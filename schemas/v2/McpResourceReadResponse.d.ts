import type { ResourceContent } from "../ResourceContent";
export type McpResourceReadResponse = {
    contents: Array<ResourceContent>;
    /**
     * Originating call when the server applied app-specific resource scoping.
     */
    originCallId: string | null;
};
//# sourceMappingURL=McpResourceReadResponse.d.ts.map