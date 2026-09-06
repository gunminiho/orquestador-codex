import type { ThreadItem } from "./ThreadItem";
export type ItemStartedNotification = {
    item: ThreadItem;
    threadId: string;
    turnId: string;
    /**
     * Unix timestamp (in milliseconds) when this item lifecycle started.
     */
    startedAtMs: number;
};
//# sourceMappingURL=ItemStartedNotification.d.ts.map