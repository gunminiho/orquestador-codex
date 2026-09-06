import type { CodexErrorInfo } from "./CodexErrorInfo";
import type { MisalignmentErrorDetails } from "./MisalignmentErrorDetails";
export type TurnError = {
    message: string;
    codexErrorInfo: CodexErrorInfo | null;
    additionalDetails: string | null;
    /**
     * Optional public explanation and continuation instruction for a misalignment block.
     */
    misalignment: MisalignmentErrorDetails | null;
};
//# sourceMappingURL=TurnError.d.ts.map