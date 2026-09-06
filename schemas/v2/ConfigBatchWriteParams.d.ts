import type { ConfigEdit } from "./ConfigEdit";
export type ConfigBatchWriteParams = {
    edits: Array<ConfigEdit>;
    /**
     * Path to the config file to write; defaults to the user's `config.toml` when omitted.
     */
    filePath?: string | null;
    expectedVersion?: string | null;
    /**
     * When true, hot-reload updated runtime settings into loaded threads after writing.
     * Session-static model, reasoning-effort, Plan-mode reasoning-effort, service-tier, and
     * personality defaults are not reloaded.
     */
    reloadUserConfig?: boolean;
};
//# sourceMappingURL=ConfigBatchWriteParams.d.ts.map