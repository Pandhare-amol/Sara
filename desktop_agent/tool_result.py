from typing import Any, Dict, Optional
import time


FINAL_STATUSES = {"SUCCESS", "FAILED", "UNCERTAIN"}
EXECUTION_STATUSES = {"SUCCESS", "FAILED", "TIMEOUT", "SKIPPED"}
VERIFICATION_STATUSES = {"VERIFIED", "FAILED", "UNCERTAIN", "NOT_REQUIRED", "SKIPPED"}


def make_tool_result(
    tool: str,
    execution_status: str,
    verification_status: str,
    message: str = "",
    details: Optional[Dict[str, Any]] = None,
    verification: Optional[Dict[str, Any]] = None,
    request_id: Optional[str] = None,
    operation_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    changed_state: Optional[bool] = None,
) -> Dict[str, Any]:
    if details is None:
        details = {}
    if verification is None:
        verification = {}
    exec_status = str(execution_status or "FAILED").upper()
    verify_status = str(verification_status or "UNCERTAIN").upper()
    if exec_status == "SUCCESS" and verify_status == "VERIFIED":
        final_status = "SUCCESS"
    elif exec_status == "FAILED":
        final_status = "FAILED"
    elif exec_status == "TIMEOUT":
        final_status = "UNCERTAIN"
    elif exec_status == "SUCCESS" and verify_status in {"UNCERTAIN", "NOT_REQUIRED"}:
        final_status = "UNCERTAIN"
    else:
        final_status = "FAILED" if verify_status == "FAILED" else "UNCERTAIN"
    return {
        "ok": exec_status == "SUCCESS" and verify_status != "FAILED",
        "success": final_status == "SUCCESS",
        "status": final_status,
        "execution_status": exec_status,
        "verification_status": verify_status,
        "tool": tool,
        "request_id": request_id or operation_id,
        "message": message,
        "details": details,
        "executed": exec_status == "SUCCESS",
        "verified": verify_status == "VERIFIED",
        "changed_state": changed_state,
        "duration_ms": duration_ms,
        "timestamp": time.time(),
        "operation_id": operation_id,
        "verification": verification | {"status": verify_status} if isinstance(verification, dict) else {"status": verify_status, "raw": verification},
        "error": details.get("error") if isinstance(details, dict) else None,
        "data": details,
    }
