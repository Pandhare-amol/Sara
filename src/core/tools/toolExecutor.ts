import type {
  CanonicalToolResult,
  ToolExecutionStatus,
  ToolVerificationStatus,
} from "../contracts/toolContract";

export function normalizeToolExecutionResult(
  tool: string,
  result: unknown,
  error?: string,
): CanonicalToolResult {
  const payload = result && typeof result === "object" ? result as Record<string, any> : {};
  const executionStatus = String(payload.execution_status || (error ? "FAILED" : "SUCCESS")).toUpperCase() as ToolExecutionStatus;
  const verificationStatus = String(payload.verification_status || payload.verification?.status || (error ? "SKIPPED" : "UNCERTAIN")).toUpperCase() as ToolVerificationStatus;
  const status = String(payload.status || (error ? "FAILED" : "UNCERTAIN")).toUpperCase() as CanonicalToolResult["status"];
  const operationId = String(payload.operation_id || payload.operationId || `${tool}-${Date.now()}`);
  const message = String(payload.message || payload.result || error || "Tool execution completed.");

  return {
    ...payload,
    status,
    execution_status: executionStatus,
    verification_status: verificationStatus,
    tool,
    request_id: payload.request_id || payload.requestId,
    operation_id: operationId,
    message,
    details: (payload.details && typeof payload.details === "object") ? payload.details : {},
    executed: payload.executed === true,
    verified: payload.verified === true || verificationStatus === "VERIFIED",
    changed_state: payload.changed_state ?? null,
    duration_ms: payload.duration_ms ?? null,
    timestamp: Number(payload.timestamp || Date.now()),
    error: error ? { message: error, retryable: false } : payload.error ?? null,
    data: payload.data ?? payload,
    verification: payload.verification && typeof payload.verification === "object"
      ? payload.verification
      : { status: verificationStatus },
  } as CanonicalToolResult;
}
