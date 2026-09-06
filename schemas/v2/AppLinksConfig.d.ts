import type { AppToolApproval } from "./AppToolApproval";
import type { ApprovalsReviewer } from "./ApprovalsReviewer";
/**
 * Account settings for a single app.
 */
export type AppLinksConfig = {
    [key in string]?: {
        approvals_reviewer: ApprovalsReviewer | null;
        default_tools_approval_mode: AppToolApproval | null;
    };
};
//# sourceMappingURL=AppLinksConfig.d.ts.map