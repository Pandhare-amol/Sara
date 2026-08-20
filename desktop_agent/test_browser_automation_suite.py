from __future__ import annotations

import importlib
import unittest


class BrowserAutomationSuiteTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.browser_automation_suite as browser_suite

        self.browser_suite = importlib.reload(browser_suite).BROWSER_AUTOMATION_SUITE

    def test_plan_detects_search_and_extracts_query(self) -> None:
        plan = self.browser_suite.plan("Search for AI news")
        self.assertEqual(plan["action"], "search")
        self.assertEqual(plan["args"]["query"], "AI news")

    def test_execute_open_browser_returns_result(self) -> None:
        result = self.browser_suite.execute("open", {"url": "https://example.com"}, confirmed=False)
        self.assertIn("result", result)

    def test_sensitive_actions_require_confirmation(self) -> None:
        result = self.browser_suite.execute("purchase", {}, confirmed=False)
        self.assertTrue(result["requires_confirmation"])

    def test_plan_can_build_research_workflow(self) -> None:
        plan = self.browser_suite.plan("Find the cheapest suitable laptop, compare five options, and make a spreadsheet.")
        self.assertEqual(plan["action"], "workflow")
        self.assertTrue(plan["steps"])
        self.assertGreaterEqual(len(plan["steps"]), 3)

    def test_browser_helpers_detect_login_and_captcha(self) -> None:
        self.assertTrue(self.browser_suite.execute("login_state", {"text": "User signed in"} )["result"]["logged_in"])
        self.assertTrue(self.browser_suite.execute("detect_captcha", {"text": "Please solve the reCAPTCHA"} )["result"]["detected"])


if __name__ == "__main__":
    unittest.main()
