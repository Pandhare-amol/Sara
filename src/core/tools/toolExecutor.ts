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
  const explicitOk = typeof payload.ok === "boolean" ? payload.ok : undefined;
  const executionStatus = String(payload.execution_status || (error || explicitOk === false ? "FAILED" : "SUCCESS")).toUpperCase() as ToolExecutionStatus;
  const verificationStatus = String(payload.verification_status || payload.verification?.status || (error ? "SKIPPED" : "UNCERTAIN")).toUpperCase() as ToolVerificationStatus;
  const status = String(payload.status || (error || explicitOk === false ? "FAILED" : verificationStatus === "VERIFIED" ? "SUCCESS" : "UNCERTAIN")).toUpperCase() as CanonicalToolResult["status"];
  const operationId = String(payload.operation_id || payload.operationId || `${tool}-${Date.now()}`);
  const message = String(payload.message || payload.result || error || "Tool execution completed.");

  return {
    ...payload,
    ok: explicitOk ?? (!error && status !== "FAILED"),
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
    error: error ? { message: error, retryable: payload.retryable === true } : payload.error ?? null,
    error_code: payload.error_code || payload.error?.code || (error ? "TOOL_EXECUTION_FAILED" : null),
    retryable: payload.retryable === true || payload.error?.retryable === true,
    severity: payload.severity || (error ? "WARNING" : "INFO"),
    source: payload.source || "sara.tool-router",
    task_id: payload.task_id || payload.taskId,
    correlation_id: payload.correlation_id || payload.correlationId,
    policy_decision: payload.policy_decision || "UNKNOWN",
    data: payload.data ?? payload,
    verification: payload.verification && typeof payload.verification === "object"
      ? payload.verification
      : { status: verificationStatus },
  } as CanonicalToolResult;
}
