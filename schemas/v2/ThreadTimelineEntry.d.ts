import type { ThreadItem } from "./ThreadItem";
import type { ThreadRealtimeItem } from "./ThreadRealtimeItem";
import type { TurnError } from "./TurnError";
import type { TurnStatus } from "./TurnStatus";
/**
 * EXPERIMENTAL - one item or turn boundary in canonical rollout order.
 */
export type ThreadTimelineEntry = {
    "type": "item";
    position: number;
    turnId: string;
    item: ThreadItem;
} | {
    "type": "realtime";
    position: number;
    item: ThreadRealtimeItem;
} | {
    "type": "turnStarted";
    position: number;
    turnId: string;
    startedAt: number | null;
} | {
    "type": "turnCompleted";
    position: number;
    turnId: string;
    status: TurnStatus;
    error: TurnError | null;
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
};
//# sourceMappingURL=ThreadTimelineEntry.d.ts.map