export type CodexErrorKind = "RATE_LIMIT" | "TRANSIENT_SERVER" | "INVALID_REQUEST" | "TASK_FAILURE" | "CANCELLED" | "UNKNOWN";
export type CodexErrorClassification = { kind: CodexErrorKind; message: string; retryable: boolean };
export function classifyCodexError(error: unknown): CodexErrorClassification {
 const message = error instanceof Error ? error.message : String(error); const normalized = message.toLowerCase();
 if (/rate.?limit|usage.?limit|quota|too many requests|\b429\b/.test(normalized)) return { kind:"RATE_LIMIT", message, retryable:true };
 if (/app server exited|econnreset|epipe|spawn|transport|connection.*closed/.test(normalized)) return { kind:"TRANSIENT_SERVER", message, retryable:true };
 if (/cancelled|interrupted/.test(normalized)) return { kind:"CANCELLED", message, retryable:false };
 if (/rpc error.*(?:-3260|invalid|parse)|invalid request|protocol/.test(normalized)) return { kind:"INVALID_REQUEST", message, retryable:false };
 if (/turn failed|model.*error/.test(normalized)) return { kind:"TASK_FAILURE", message, retryable:false };
 return { kind:"UNKNOWN", message, retryable:false };
}
