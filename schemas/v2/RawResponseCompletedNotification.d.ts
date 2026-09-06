import type { ResponseUsageMetadata } from "./ResponseUsageMetadata";
import type { TokenUsageBreakdown } from "./TokenUsageBreakdown";
/**
 * Internal-only notification containing the exact usage from one upstream
 * Responses API completion.
 */
export type RawResponseCompletedNotification = {
    threadId: string;
    turnId: string;
    responseId: string;
    usage: TokenUsageBreakdown | null;
    usageMetadata: ResponseUsageMetadata | null;
};
//# sourceMappingURL=RawResponseCompletedNotification.d.ts.map