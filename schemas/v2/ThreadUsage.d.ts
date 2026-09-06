import type { ThreadUsageBreakdownGroup } from "./ThreadUsageBreakdownGroup";
export type ThreadUsage = {
    threadId: string;
    estimatedUsageCreditsMicros: bigint;
    estimatedUsageUsdMicros: bigint | null;
    groups: Array<ThreadUsageBreakdownGroup>;
};
//# sourceMappingURL=ThreadUsage.d.ts.map