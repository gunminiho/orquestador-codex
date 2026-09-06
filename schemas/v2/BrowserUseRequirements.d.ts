import type { BrowserUseOriginPolicy } from "./BrowserUseOriginPolicy";
export type BrowserUseRequirements = {
    allowHistoryAccess: boolean | null;
    disableAutoReview: boolean | null;
    allowGlobalPersistentApproval: boolean | null;
    defaultOriginPolicy: BrowserUseOriginPolicy | null;
    origins: {
        [key in string]?: BrowserUseOriginPolicy;
    } | null;
};
//# sourceMappingURL=BrowserUseRequirements.d.ts.map