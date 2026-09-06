import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type SkillInterface = {
    displayName?: string;
    shortDescription?: string;
    iconSmall?: AbsolutePathBuf;
    iconLarge?: AbsolutePathBuf;
    /**
     * Remote small icon URL from the plugin catalog.
     */
    iconSmallUrl: string | null;
    /**
     * Remote large icon URL from the plugin catalog.
     */
    iconLargeUrl: string | null;
    brandColor?: string;
    defaultPrompt?: string;
};
//# sourceMappingURL=SkillInterface.d.ts.map