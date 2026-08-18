import os
import tempfile
import unittest

os.environ.setdefault("SARA_DATA_DIR", tempfile.mkdtemp(prefix="sara-tests-"))

from desktop_agent.agents import AgentManager, AgentResult, AgentTask


class UncertainHandlingTest(unittest.TestCase):
    def test_uncertain_verification_is_not_failure(self) -> None:
        manager = AgentManager()
        task = AgentTask(
            id=manager._new_id(),
            parent_id=None,
            goal="test",
            agent="system_control_agent",
            action="open_application",
            args={},
        )
        result = AgentResult(
            status="completed",
            result={"execution_status": "SUCCESS", "verification_status": "UNCERTAIN", "tool": "openApplication"},
        )
        ok = manager._verify_result(task, result)
        self.assertTrue(ok)
        self.assertEqual(result.result.get("verification_status"), "UNCERTAIN")


if __name__ == "__main__":
    unittest.main()
