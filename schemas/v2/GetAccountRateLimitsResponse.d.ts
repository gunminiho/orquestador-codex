import type { JsonValue } from "../serde_json/JsonValue";
import type { RateLimitResetCreditsSummary } from "./RateLimitResetCreditsSummary";
import type { RateLimitSnapshot } from "./RateLimitSnapshot";
export type GetAccountRateLimitsResponse = {
    /**
     * Backward-compatible single-bucket view; mirrors the historical payload.
     */
    rateLimits: RateLimitSnapshot;
    /**
     * Multi-bucket view keyed by metered `limit_id` (for example, `codex`).
     */
    rateLimitsByLimitId: {
        [key in string]?: RateLimitSnapshot;
    } | null;
    rateLimitResetCredits: RateLimitResetCreditsSummary | null;
    /**
     * Account associated with this usage snapshot, when supplied by the backend.
     */
    accountId: string | null;
    /**
     * Optional backend-owned banner from the same usage read. Its nested keys retain the
     * backend's snake_case contract; an absent banner leaves the client's existing UI unchanged.
     */
    rateLimitUpsell: JsonValue | null;
};
//# sourceMappingURL=GetAccountRateLimitsResponse.d.ts.map