import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
export type ExternalAgentConfigImportItemTypeSuccess = {
    itemType: ExternalAgentConfigMigrationItemType;
    cwd: string | null;
    source: string | null;
    target: string | null;
    /**
     * Original title for an imported session; null for other item types.
     */
    title: string | null;
};
//# sourceMappingURL=ExternalAgentConfigImportItemTypeSuccess.d.ts.map