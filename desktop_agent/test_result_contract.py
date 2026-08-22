import unittest

from .main import _canonical_result


class ResultContractTest(unittest.TestCase):
    def test_unverified_legacy_result_is_uncertain(self):
        result = _canonical_result(
            "openApplication",
            {"result": "Application launch requested."},
            args={"request_id": "req-1", "task_id": "task-1"},
            execution_time_ms=12,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "UNCERTAIN")
        self.assertFalse(result["verified"])
        self.assertEqual(result["request_id"], "req-1")
        self.assertEqual(result["task_id"], "task-1")
        self.assertEqual(result["execution_time_ms"], 12)
        self.assertTrue(result["operation_id"])
        self.assertIsInstance(result["timestamp"], int)

    def test_verified_result_is_success(self):
        result = _canonical_result(
            "desktopBrowserState",
            {"ok": True, "verified": True, "result": "State read."},
            args={"operation_id": "op-1"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "SUCCESS")
        self.assertTrue(result["verified"])
        self.assertEqual(result["operation_id"], "op-1")

    def test_failure_contains_structured_error(self):
        result = _canonical_result("readFile", error="File does not exist.", args={"request_id": "req-2"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["error"]["code"], "TOOL_EXECUTION_FAILED")
        self.assertEqual(result["error"]["message"], "File does not exist.")


if __name__ == "__main__":
    unittest.main()
