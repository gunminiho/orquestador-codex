import type { CodexErrorInfo } from "../../schemas/v2/CodexErrorInfo";
import type { TurnError } from "../../schemas/v2/TurnError";

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) { super(message); this.name = "CodexRpcError"; }
}

export class CodexTurnError extends Error {
  readonly codexErrorInfo: CodexErrorInfo | null;
  constructor(readonly turnError: TurnError, readonly threadId: string, readonly turnId: string) { super(turnError.message); this.name = "CodexTurnError"; this.codexErrorInfo = turnError.codexErrorInfo; }
}
