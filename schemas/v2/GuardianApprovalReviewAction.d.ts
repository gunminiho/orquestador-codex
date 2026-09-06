import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { LegacyAppPathString } from "../LegacyAppPathString";
import type { GuardianCommandSource } from "./GuardianCommandSource";
import type { NetworkApprovalProtocol } from "./NetworkApprovalProtocol";
import type { RequestPermissionProfile } from "./RequestPermissionProfile";
export type GuardianApprovalReviewAction = {
    "type": "command";
    source: GuardianCommandSource;
    command: string;
    cwd: AbsolutePathBuf;
} | {
    "type": "execve";
    source: GuardianCommandSource;
    program: string;
    argv: Array<string>;
    cwd: AbsolutePathBuf;
} | {
    "type": "writeStdin";
    approvalId: string;
    processId: string;
    stdin: string;
    cwd: LegacyAppPathString;
} | {
    "type": "applyPatch";
    cwd: AbsolutePathBuf;
    files: Array<AbsolutePathBuf>;
} | {
    "type": "networkAccess";
    target: string;
    host: string;
    protocol: NetworkApprovalProtocol;
    port: number;
} | {
    "type": "mcpToolCall";
    server: string;
    toolName: string;
    connectorId: string | null;
    connectorName: string | null;
    toolTitle: string | null;
} | {
    "type": "requestPermissions";
    reason: string | null;
    permissions: RequestPermissionProfile;
};
//# sourceMappingURL=GuardianApprovalReviewAction.d.ts.map