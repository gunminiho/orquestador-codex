import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { LegacyAppPathString } from "../LegacyAppPathString";
import type { ReasoningEffort } from "../ReasoningEffort";
import type { ApprovalsReviewer } from "./ApprovalsReviewer";
import type { AskForApproval } from "./AskForApproval";
import type { SandboxPolicy } from "./SandboxPolicy";
import type { Thread } from "./Thread";
export type ThreadForkResponse = {
    thread: Thread;
    model: string;
    modelProvider: string;
    serviceTier: string | null;
    cwd: AbsolutePathBuf; /**
     * Environment-native paths to instruction source files currently loaded for this thread.
     */
    instructionSources: Array<LegacyAppPathString>;
    approvalPolicy: AskForApproval; /**
     * Reviewer currently used for approval requests on this thread.
     */
    approvalsReviewer: ApprovalsReviewer; /**
     * Legacy sandbox policy retained for compatibility. Experimental clients
     * should prefer `activePermissionProfile` for profile provenance.
     */
    sandbox: SandboxPolicy;
    reasoningEffort: ReasoningEffort | null;
};
//# sourceMappingURL=ThreadForkResponse.d.ts.map