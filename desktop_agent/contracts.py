from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field

ToolExecutionStatus = Literal["SUCCESS", "FAILED", "TIMEOUT", "SKIPPED"]
ToolVerificationStatus = Literal["VERIFIED", "FAILED", "UNCERTAIN", "NOT_REQUIRED", "SKIPPED"]
ToolFinalStatus = Literal["SUCCESS", "FAILED", "UNCERTAIN"]

class ToolErrorDetails(BaseModel):
    code: Optional[str] = None
    message: str
    retryable: Optional[bool] = None
    exceptionType: Optional[str] = None

class ToolVerificationCheck(BaseModel):
    name: str
    passed: bool
    evidence: Optional[Any] = None
    reason: Optional[str] = None

class ToolVerification(BaseModel):
    status: ToolVerificationStatus
    method: Optional[str] = None
    checks: Optional[List[ToolVerificationCheck]] = None
    details: Optional[Any] = None

class CanonicalToolResult(BaseModel):
    ok: bool
    status: ToolFinalStatus
    execution_status: ToolExecutionStatus
    verification_status: ToolVerificationStatus
    tool: str
    request_id: Optional[str] = None
    operation_id: str
    message: str
    details: Dict[str, Any] = Field(default_factory=dict)
    executed: bool
    verified: bool
    changed_state: Optional[bool] = None
    duration_ms: Optional[int] = None
    timestamp: int
    error: Optional[ToolErrorDetails] = None
    error_code: Optional[str] = None
    retryable: bool = False
    severity: Optional[Literal["INFO", "WARNING", "HIGH", "CRITICAL"]] = None
    source: Optional[str] = None
    task_id: Optional[str] = None
    correlation_id: Optional[str] = None
    policy_decision: Optional[Literal["ALLOW", "ASK_USER", "DENY", "UNKNOWN"]] = None
    data: Optional[Any] = None
    verification: ToolVerification
