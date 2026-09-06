import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
export type ExternalAgentConfigImportHistoryRecordSuccessParams = {
    itemType: ExternalAgentConfigMigrationItemType;
    cwd: string | null;
    source: string | null;
    target: string | null;
    /**
     * Original title for an imported session, when available.
     */
    title?: string | null;
};
//# sourceMappingURL=ExternalAgentConfigImportHistoryRecordSuccessParams.d.ts.map