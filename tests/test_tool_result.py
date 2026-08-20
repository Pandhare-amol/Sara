import time
from desktop_agent.main import ExecuteRequest, execute
from desktop_agent.tool_result import make_tool_result


def test_execute_unknown_tool_does_not_crash_without_request_id():
    response = execute(ExecuteRequest(tool="not_real", args={}))
    assert response.ok is False
    assert response.tool == "not_real"
    assert response.error is not None


def test_make_tool_result_ok_logic():
    tr = make_tool_result("openApplication", "SUCCESS", "UNCERTAIN", message="launched", details={})
    assert tr["execution_status"] == "SUCCESS"
    assert tr["verification_status"] == "UNCERTAIN"
    assert tr["ok"] is True
    assert tr["status"] == "SUCCESS"
    assert tr["success"] is True

    tr2 = make_tool_result("openApplication", "SUCCESS", "VERIFIED")
    assert tr2["ok"] is True
    assert tr2["status"] == "SUCCESS"

    tr3 = make_tool_result("openApplication", "FAILED", "NOT_REQUIRED")
    assert tr3["ok"] is False

    tr4 = make_tool_result("openApplication", "SUCCESS", "FAILED")
    assert tr4["ok"] is False
    assert tr4["status"] == "FAILED"
