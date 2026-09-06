import type { PluginReconcileChangedPlugin } from "./PluginReconcileChangedPlugin";
/**
 * Bundle and installed-state changes observed by this pass, not a runtime-readiness
 * acknowledgement or a cumulative diff since the client's last request. Other metadata-only
 * changes are not listed.
 */
export type PluginReconcileResponse = {
    /**
     * Plugins affected by bundle changes, enablement changes, or removals.
     * Installed-state changes compare against the previous cached snapshot, including
     * cached reinstalls. Removal hints survive cache cleanup failures; unchanged plugins are omitted.
     */
    changedPlugins: Array<PluginReconcileChangedPlugin>;
    /**
     * Backend remote plugin IDs whose bundle or identity update failed.
     */
    failedRemotePluginIds: Array<string>;
    /**
     * Subset of failures for which the requested bundle could not be materialized.
     * A previously cached version may still be available.
     */
    failedMaterializationRemotePluginIds: Array<string>;
};
//# sourceMappingURL=PluginReconcileResponse.d.ts.map