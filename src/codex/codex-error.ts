import type { CodexErrorInfo } from "../../schemas/v2/CodexErrorInfo";

export type CodexErrorKind = "RATE_LIMIT" | "TRANSIENT_SERVER" | "INVALID_REQUEST" | "TASK_FAILURE" | "CANCELLED" | "AUTH" | "SANDBOX" | "UNKNOWN";
export type CodexErrorClassification = { kind: CodexErrorKind; message: string; retryable: boolean };
type StructuredError = { message?: string; codexErrorInfo?: CodexErrorInfo | null; error?: { data?: { codexErrorInfo?: CodexErrorInfo | null } } };

export function classifyCodexError(error: unknown): CodexErrorClassification {
  const structured = (error ?? {}) as StructuredError;
  const info = structured.codexErrorInfo ?? structured.error?.data?.codexErrorInfo;
  const message = error instanceof Error ? error.message : structured.message ?? String(error);
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded" || info === "sessionBudgetExceeded") return { kind: "RATE_LIMIT", message, retryable: true };
  if (info === "serverOverloaded" || info === "internalServerError" || (typeof info === "object" && info !== null)) return { kind: "TRANSIENT_SERVER", message, retryable: true };
  if (info === "badRequest") return { kind: "INVALID_REQUEST", message, retryable: false };
  if (info === "unauthorized") return { kind: "AUTH", message, retryable: false };
  if (info === "sandboxError") return { kind: "SANDBOX", message, retryable: false };
  const normalized = message.toLowerCase();
  if (/rate.?limit|usage.?limit|quota|too many requests|\b429\b/.test(normalized)) return { kind: "RATE_LIMIT", message, retryable: true };
  if (/app server exited|econnreset|epipe|spawn|transport|connection.*closed/.test(normalized)) return { kind: "TRANSIENT_SERVER", message, retryable: true };
  if (/cancelled|interrupted/.test(normalized)) return { kind: "CANCELLED", message, retryable: false };
  if (/invalid request|protocol/.test(normalized)) return { kind: "INVALID_REQUEST", message, retryable: false };
  return { kind: "UNKNOWN", message, retryable: false };
}
