/**
 * EXPERIMENTAL - read metadata for specific apps/connectors.
 */
export type AppsReadParams = {
    /**
     * App ids to read. The server accepts at most 100 ids and deduplicates repeated ids while
     * preserving their first-request order.
     */
    appIds: Array<string>;
    /**
     * Optional loaded thread id used to evaluate effective app configuration.
     */
    threadId?: string | null;
    /**
     * When true, include display-only public tool summaries in the returned metadata.
     */
    includeTools?: boolean;
};
//# sourceMappingURL=AppsReadParams.d.ts.map