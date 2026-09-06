/**
 * Replace a paginated thread's durable history with the prefix before one turn.
 *
 * This only changes persisted conversation history. It does not revert local file changes.
 */
export type ThreadRevertParams = {
    threadId: string;
    /**
     * Turn excluded from the replacement history, together with every later turn.
     */
    beforeTurnId: string;
};
//# sourceMappingURL=ThreadRevertParams.d.ts.map