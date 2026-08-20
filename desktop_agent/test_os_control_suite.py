from __future__ import annotations

import importlib
import unittest
from unittest.mock import patch

from desktop_agent.agents import plan_goal
from desktop_agent.tools_applications import close_application, open_application


class OSControlSuiteTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.os_control_suite as os_control_suite

        self.os_suite = importlib.reload(os_control_suite).OS_AUTOMATION_SUITE

    def test_plan_detects_shutdown_requires_confirmation(self) -> None:
        plan = self.os_suite.plan("Shut down the computer")
        self.assertEqual(plan["action"], "shutdown")
        self.assertTrue(plan["requires_confirmation"])

    def test_execute_open_application_uses_existing_tool(self) -> None:
        result = self.os_suite.execute("open_app", {"name": "notepad"}, confirmed=False)
        self.assertIn("result", result)

    def test_execute_delete_requires_confirmation(self) -> None:
        result = self.os_suite.execute("delete_file", {"path": "C:/temp/example.txt"}, confirmed=False)
        self.assertTrue(result["requires_confirmation"])

    def test_workflow_engine_can_store_and_run_steps(self) -> None:
        workflow = self.os_suite.automation_engine.create_workflow(
            name="demo",
            description="Open a folder and list files",
            steps=[
                {"action": "open_folder", "args": {"path": "Desktop"}},
                {"action": "list_files", "args": {"path": "Desktop"}},
            ],
        )
        self.assertEqual(workflow["name"], "demo")
        result = self.os_suite.automation_engine.run_workflow(workflow, confirmed=False)
        self.assertEqual(result["status"], "completed")

    def test_plan_and_execute_camera_actions(self) -> None:
        self.assertEqual(self.os_suite.plan("Open the webcam")["action"], "open_camera")
        self.assertEqual(self.os_suite.plan("Take a photo")["action"], "take_photo")
        self.assertEqual(self.os_suite.plan("Record video for 10 seconds")["action"], "record_video")

    def test_plan_routes_show_desktop_to_system_control_agent(self) -> None:
        plan = plan_goal("Show desktop")
        self.assertEqual(plan[0]["agent"], "system_control_agent")
        self.assertEqual(plan[0]["action"], "show_desktop")

    def test_plan_builds_work_setup_and_report_workflows(self) -> None:
        work_setup = plan_goal("Open my work setup")
        self.assertGreaterEqual(len(work_setup), 2)
        report = plan_goal("Create a report from emails and send it")
        self.assertGreaterEqual(len(report), 3)

    def test_open_application_focuses_existing_app_when_running(self) -> None:
        with patch("desktop_agent.tools_applications._is_running", return_value=True), patch("desktop_agent.tools_applications._focus_running_app", return_value=True) as focus_mock, patch("desktop_agent.tools_applications._launch") as launch_mock:
            result = open_application({"name": "chrome"})
        self.assertIn("already running", result["result"])
        focus_mock.assert_called_once()
        launch_mock.assert_not_called()

    def test_close_application_can_force_kill_running_process(self) -> None:
        with patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            run_mock.return_value = type("Result", (), {"returncode": 0})()
            close_application({"name": "chrome", "kill": True})
        self.assertTrue(run_mock.called)
        self.assertIn("/F", run_mock.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
