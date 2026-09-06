export type ExternalAgentConfigDetectParams = {
    /**
     * If true, include detection under the user's home directory.
     */
    includeHome?: boolean;
    /**
     * Zero or more working directories to include for repo-scoped detection.
     */
    cwds?: Array<string> | null;
    /**
     * Maximum age in days for detected sessions. Missing values use the default limit.
     */
    maxSessionAgeDays?: number | null;
    /**
     * Maximum number of sessions to detect. Missing values use the default limit.
     */
    maxSessions?: number | null;
    /**
     * Deprecated field retained for compatibility. This field is ignored; use `migrationSource`
     * to select the migration source.
     */
    source?: string | null;
    /**
     * Optional migration-source selector. Missing or unrecognized values use the default source.
     */
    migrationSource?: string | null;
};
//# sourceMappingURL=ExternalAgentConfigDetectParams.d.ts.map