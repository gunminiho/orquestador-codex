import type { ExternalAgentConfigImportItemTypeFailure } from "./ExternalAgentConfigImportItemTypeFailure";
import type { ExternalAgentConfigImportItemTypeSuccess } from "./ExternalAgentConfigImportItemTypeSuccess";
export type ExternalAgentConfigImportHistory = {
    importId: string;
    providerId: string | null;
    completedAtMs: bigint;
    successes: Array<ExternalAgentConfigImportItemTypeSuccess>;
    failures: Array<ExternalAgentConfigImportItemTypeFailure>;
};
//# sourceMappingURL=ExternalAgentConfigImportHistory.d.ts.map