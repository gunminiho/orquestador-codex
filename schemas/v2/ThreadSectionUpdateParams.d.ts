import type { ThreadSectionAppearance } from "./ThreadSectionAppearance";
/**
 * Parameters for updating an independently persisted thread section.
 */
export type ThreadSectionUpdateParams = {
    /**
     * The stable, server-generated identity of the section to update.
     */
    sectionId: string;
    /**
     * The updated user-visible name of the section.
     */
    name: string;
    /**
     * Omit to preserve appearance, use `null` to clear it, or provide a replacement.
     */
    appearance?: ThreadSectionAppearance | null;
};
//# sourceMappingURL=ThreadSectionUpdateParams.d.ts.map