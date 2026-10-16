from __future__ import annotations

import importlib
import os
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
except ModuleNotFoundError:  # pragma: no cover - environment dependent
    TestClient = None  # type: ignore[assignment]


INTERNAL_TOKEN = "unit-test-agent-internal-token-0123456789abcdef"


@unittest.skipIf(TestClient is None, "fastapi/httpx test dependencies are not installed")
class DesktopAgentAuthTest(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(os.environ, {"SARA_AGENT_INTERNAL_TOKEN": INTERNAL_TOKEN})
        self.environment.start()
        self.addCleanup(self.environment.stop)

        import desktop_agent.main as main_module

        self.module = importlib.reload(main_module)
        self.client = TestClient(self.module.app)
        self.addCleanup(self.client.close)

    def test_health_advertises_protocol_but_exposes_no_token(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["agent_auth_required"])
        self.assertEqual(response.json()["agent_auth_protocol_version"], 1)
        self.assertEqual(response.json()["service"], "sara-desktop-agent")
        self.assertNotIn(INTERNAL_TOKEN, response.text)

    def test_local_control_and_sensitive_routes_require_internal_token(self) -> None:
        self.assertEqual(self.client.get("/auth/check").status_code, 401)
        self.assertEqual(self.client.get("/tools").status_code, 401)
        self.assertEqual(
            self.client.post("/execute", json={"tool": "desktopAgentDiagnostic", "args": {}}).status_code,
            401,
        )
        self.assertEqual(self.client.get("/browser/state").status_code, 401)
        self.assertEqual(self.client.post("/companion/pair", json={}).status_code, 401)
        self.assertEqual(self.client.post("/orchestrator/emergency-stop", json={}).status_code, 401)

    def test_authenticated_node_calls_can_handshake_execute_and_list_tools(self) -> None:
        headers = {"X-SARA-Agent-Token": INTERNAL_TOKEN}
        auth = self.client.get("/auth/check", headers=headers)
        self.assertEqual(auth.status_code, 200)
        self.assertEqual(auth.json()["service"], "sara-desktop-agent")
        self.assertTrue(auth.json()["agent_auth_required"])
        self.assertEqual(auth.json()["agent_auth_protocol_version"], 1)
        self.assertEqual(self.client.get("/tools", headers=headers).status_code, 200)
        response = self.client.post(
            "/execute",
            headers=headers,
            json={"tool": "desktopAgentDiagnostic", "args": {}},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_tool_logging_records_argument_keys_without_values(self) -> None:
        headers = {"X-SARA-Agent-Token": INTERNAL_TOKEN}
        secret_value = "PRIVATE-USER-CONTENT-DO-NOT-LOG"
        with self.assertLogs("sara.desktop", level="INFO") as captured:
            response = self.client.post(
                "/execute",
                headers=headers,
                json={"tool": "notRegisteredForLoggingTest", "args": {"privateNote": secret_value}},
            )
        self.assertEqual(response.status_code, 200)
        log_text = "\n".join(captured.output)
        self.assertIn("arg_keys=privateNote", log_text)
        self.assertNotIn(secret_value, log_text)

    def test_tool_results_that_echo_arguments_are_not_written_to_logs(self) -> None:
        headers = {"X-SARA-Agent-Token": INTERNAL_TOKEN}
        tool_name = "privateLogRedactionTest"
        secret_value = "PRIVATE-RESULT-DO-NOT-LOG"
        self.module.TOOLS[tool_name] = lambda args: {"result": args["privateNote"]}
        self.addCleanup(self.module.TOOLS.pop, tool_name, None)

        with self.assertLogs("sara.desktop", level="INFO") as captured:
            response = self.client.post(
                "/execute",
                headers=headers,
                json={"tool": tool_name, "args": {"privateNote": secret_value}},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"]["result"], secret_value)
        self.assertNotIn(secret_value, "\\n".join(captured.output))

    def test_missing_server_secret_fails_closed_even_with_a_supplied_header(self) -> None:
        with patch.dict(os.environ, {"SARA_AGENT_INTERNAL_TOKEN": ""}):
            response = self.client.post(
                "/execute",
                headers={"X-SARA-Agent-Token": INTERNAL_TOKEN},
                json={"tool": "desktopAgentDiagnostic", "args": {}},
            )
        self.assertEqual(response.status_code, 401)

    def test_cors_preflight_does_not_need_the_control_token(self) -> None:
        response = self.client.options(
            "/execute",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-sara-agent-token",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://localhost:3000")


if __name__ == "__main__":
    unittest.main()
