import type { AccountTokenUsageDailyBucket } from "./AccountTokenUsageDailyBucket";
import type { AccountTokenUsageSummary } from "./AccountTokenUsageSummary";
import type { ThreadUsage } from "./ThreadUsage";
export type GetAccountTokenUsageResponse = {
    summary: AccountTokenUsageSummary;
    dailyUsageBuckets: Array<AccountTokenUsageDailyBucket> | null;
    /**
     * Estimated usage when a thread was requested and its billing route is available.
     */
    threadUsage?: ThreadUsage | null;
};
//# sourceMappingURL=GetAccountTokenUsageResponse.d.ts.map