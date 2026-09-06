import type { MisalignmentSteer } from "./MisalignmentSteer";
export type MisalignmentErrorDetails = {
    /**
     * Open-ended classification; clients must accept categories added by Responses.
     */
    errorType: string | null;
    /**
     * A substantive localized explanation is required before offering continuation.
     */
    detailedExplanation: string | null;
    /**
     * Instruction to submit as the next turn's user input if continuation is confirmed.
     */
    steer: MisalignmentSteer | null;
};
//# sourceMappingURL=MisalignmentErrorDetails.d.ts.map