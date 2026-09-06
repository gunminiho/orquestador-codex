/**
 * Read the committed installed connector runtime snapshot.
 */
export type AppsInstalledParams = {
    /**
     * Optional loaded thread id used to evaluate effective app configuration.
     */
    threadId?: string | null;
    /**
     * When true and Apps are permitted, refresh and publish the hosted connector runtime tool
     * snapshot first.
     */
    forceRefresh?: boolean;
};
//# sourceMappingURL=AppsInstalledParams.d.ts.map