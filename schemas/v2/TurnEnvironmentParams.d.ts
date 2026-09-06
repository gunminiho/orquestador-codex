import type { LegacyAppPathString } from "../LegacyAppPathString";
export type TurnEnvironmentParams = {
    environmentId: string;
    cwd: LegacyAppPathString;
    /**
     * Environment-native runtime workspace roots. Omitted defaults to `cwd`.
     */
    runtimeWorkspaceRoots?: Array<LegacyAppPathString> | null;
};
//# sourceMappingURL=TurnEnvironmentParams.d.ts.map