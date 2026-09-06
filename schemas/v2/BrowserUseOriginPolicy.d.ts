import type { AllowDenyRequirement } from "./AllowDenyRequirement";
import type { BrowserUseAccessApprovalLifetime } from "./BrowserUseAccessApprovalLifetime";
export type BrowserUseOriginPolicy = {
    access: AllowDenyRequirement | null;
    downloads: AllowDenyRequirement | null;
    uploads: AllowDenyRequirement | null;
    fullCdpAccess: AllowDenyRequirement | null;
    autoReview: AllowDenyRequirement | null;
    persistentApproval: boolean | null;
    accessApprovalLifetime: BrowserUseAccessApprovalLifetime | null;
};
//# sourceMappingURL=BrowserUseOriginPolicy.d.ts.map