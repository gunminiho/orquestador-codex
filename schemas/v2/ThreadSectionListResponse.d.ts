import type { ThreadSection } from "./ThreadSection";
/**
 * One page of independently persisted thread sections.
 */
export type ThreadSectionListResponse = {
    data: Array<ThreadSection>;
    /**
     * Opaque cursor for the next page, or `null` when no sections remain.
     */
    nextCursor: string | null;
};
//# sourceMappingURL=ThreadSectionListResponse.d.ts.map