/**
 * Parameters for moving a thread within a server-owned section ordering.
 */
export type ThreadSectionMoveParams = {
    /**
     * Thread to move into, within, or out of a section.
     */
    threadId: string;
    /**
     * Destination section, or `null` to remove the thread from its section.
     */
    sectionId: string | null;
    /**
     * Existing thread to insert before; omission or null appends to the section.
     */
    beforeThreadId?: string | null;
};
//# sourceMappingURL=ThreadSectionMoveParams.d.ts.map