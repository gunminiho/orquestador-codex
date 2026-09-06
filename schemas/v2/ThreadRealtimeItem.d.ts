import type { ThreadRealtimeBemItemPresentation } from "./ThreadRealtimeBemItemPresentation";
import type { ThreadRealtimeSessionOutcome } from "./ThreadRealtimeSessionOutcome";
import type { ThreadRealtimeTranscriptRole } from "./ThreadRealtimeTranscriptRole";
/**
 * EXPERIMENTAL - a thread-scoped realtime item in the canonical timeline.
 */
export type ThreadRealtimeItem = {
    id: string;
    realtimeSessionId: string;
} & ({
    "type": "realtimeSessionStarted";
} | {
    "type": "transcriptSegment";
    role: ThreadRealtimeTranscriptRole;
    text: string;
} | {
    "type": "bemItemPromoted";
    turnId: string;
    itemId: string;
    presentation: ThreadRealtimeBemItemPresentation;
} | {
    "type": "realtimeSessionClosed";
    outcome: ThreadRealtimeSessionOutcome;
});
//# sourceMappingURL=ThreadRealtimeItem.d.ts.map