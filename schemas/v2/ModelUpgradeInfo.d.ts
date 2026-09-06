export type ModelUpgradeInfo = {
    model: string;
    upgradeCopy: string | null;
    modelLink: string | null;
    migrationMarkdown: string | null;
    /**
     * Informational Unix timestamp for this upgrade's scheduled retirement, if known.
     */
    retirementAt: number | null;
};
//# sourceMappingURL=ModelUpgradeInfo.d.ts.map