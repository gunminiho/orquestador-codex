/**
 * Runtime categories affected by this change, not just capabilities currently present.
 * Flags describe declarations before runtime policy filtering. Updates OR the old and new
 * bundle flags; enablement changes and cached reinstalls use the cached bundle; removals retain
 * the old bundle's flags.
 */
export type PluginReconcileChangedPlugin = {
    /**
     * Local plugin ID (`name@marketplace`), matching `PluginSummary.id`.
     */
    id: string;
    hasMcps: boolean;
    hasApps: boolean;
    hasHooks: boolean;
    /**
     * Whether either bundle declares skill roots; not a validated inventory of enabled skills.
     */
    hasSkills: boolean;
};
//# sourceMappingURL=PluginReconcileChangedPlugin.d.ts.map