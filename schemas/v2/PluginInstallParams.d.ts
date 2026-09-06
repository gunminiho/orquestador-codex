import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type PluginInstallParams = {
    marketplacePath?: AbsolutePathBuf | null;
    remoteMarketplaceName?: string | null;
    /**
     * Client-generated identifier used to correlate one installation attempt.
     */
    installAttemptId?: string | null;
    pluginName: string;
};
//# sourceMappingURL=PluginInstallParams.d.ts.map