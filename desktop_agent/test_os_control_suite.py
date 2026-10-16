from __future__ import annotations

import importlib
import unittest
from unittest.mock import patch

from desktop_agent.agents import plan_goal
from desktop_agent.tools_applications import (
    _AUTO_CLOSE_LAUNCHES,
    _discard_task_app_tracking,
    close_application,
    close_launched_applications,
    open_application,
)


class OSControlSuiteTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.os_control_suite as os_control_suite

        self.os_suite = importlib.reload(os_control_suite).OS_AUTOMATION_SUITE

    def test_plan_detects_shutdown_requires_confirmation(self) -> None:
        plan = self.os_suite.plan("Shut down the computer")
        self.assertEqual(plan["action"], "shutdown")
        self.assertTrue(plan["requires_confirmation"])

    def test_execute_open_application_uses_existing_tool(self) -> None:
        with patch("desktop_agent.tools_applications._is_running", return_value=False), \
                patch("desktop_agent.tools_applications._launch"), \
                patch("desktop_agent.tools_applications._wait_for_application", return_value={"status": "SUCCESS", "verified": True}):
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

    def test_open_application_focuses_existing_app_without_claiming_sara_ownership(self) -> None:
        with patch("desktop_agent.tools_applications._is_running", return_value=True), patch("desktop_agent.tools_applications._focus_running_app", return_value=True) as focus_mock, patch("desktop_agent.tools_applications._launch") as launch_mock:
            result = open_application({"name": "chrome", "automation_task_id": "task-existing", "auto_close_after_task": True})
        self.assertIn("already running", result["result"])
        self.assertFalse(result["launched_by_sara"])
        self.assertFalse(result["auto_close_tracked"])
        focus_mock.assert_called_once()
        launch_mock.assert_not_called()

    def test_auto_close_tracks_only_a_new_visible_process_for_an_opted_in_task(self) -> None:
        task_id = "task-owned-new-process"
        self.addCleanup(_discard_task_app_tracking, task_id)
        process_snapshot = {"pid": 501, "name": "notepad.exe", "create_time": 1000.0}
        with patch("desktop_agent.tools_applications.psutil", object()), \
                patch("desktop_agent.tools_applications._is_running", return_value=False), \
                patch("desktop_agent.tools_applications._matching_process_instances", side_effect=[[], [process_snapshot]]), \
                patch("desktop_agent.tools_applications._windows_for_process", return_value=[{"hwnd": 91, "title": "Untitled - Notepad"}]), \
                patch("desktop_agent.tools_applications._launch"), \
                patch("desktop_agent.tools_applications._wait_for_application", return_value={"status": "SUCCESS", "verified": True, "running": True, "focused": True}), \
                patch("desktop_agent.tools_applications.time.time", return_value=1000.0):
            result = open_application({"name": "notepad", "automation_task_id": task_id, "auto_close_after_task": True})

        self.assertTrue(result["verified"])
        self.assertTrue(result["launched_by_sara"])
        self.assertTrue(result["auto_close_tracked"])
        self.assertEqual(_AUTO_CLOSE_LAUNCHES[task_id][0]["pid"], 501)
        self.assertEqual(_AUTO_CLOSE_LAUNCHES[task_id][0]["windows"][0]["hwnd"], 91)

    def test_unattributable_app_window_is_reported_left_open(self) -> None:
        task_id = "task-unattributable-window"
        self.addCleanup(_discard_task_app_tracking, task_id)
        process_snapshot = {"pid": 503, "name": "notepad.exe", "create_time": 1000.0}
        with patch("desktop_agent.tools_applications.psutil", object()), \
                patch("desktop_agent.tools_applications._is_running", return_value=False), \
                patch("desktop_agent.tools_applications._matching_process_instances", side_effect=[[], [process_snapshot]]), \
                patch("desktop_agent.tools_applications._windows_for_process", return_value=None), \
                patch("desktop_agent.tools_applications._launch"), \
                patch("desktop_agent.tools_applications._wait_for_application", return_value={"status": "SUCCESS", "verified": True, "running": True, "focused": True}), \
                patch("desktop_agent.tools_applications.time.time", return_value=1000.0):
            opened = open_application({"name": "notepad", "automation_task_id": task_id, "auto_close_after_task": True})
        with patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications.psutil", object()):
            closed = close_launched_applications({"automation_task_id": task_id})

        self.assertTrue(opened["launched_by_sara"])
        self.assertFalse(opened["auto_close_tracked"])
        self.assertFalse(closed["verified"])
        self.assertIn("could not safely attribute", closed["left_open"][0]["reason"])

    def test_task_close_is_graceful_and_leaves_unclosed_windows_open(self) -> None:
        task_id = "task-left-open"
        instance = {
            "pid": 502,
            "name": "notepad.exe",
            "create_time": 1000.0,
            "windows": [{"hwnd": 92, "title": "Untitled - Notepad"}],
        }
        fake_process = type("FakeProcess", (), {
            "name": lambda self: "notepad.exe",
            "create_time": lambda self: 1000.0,
            "is_running": lambda self: True,
        })()
        with patch.dict(_AUTO_CLOSE_LAUNCHES, {task_id: [instance]}), \
                patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications.psutil", type("FakePsutil", (), {"Process": staticmethod(lambda _pid: fake_process)})), \
                patch("desktop_agent.tools_applications._close_recorded_windows", return_value={"closed": False, "reason": "An unsaved-work prompt is open."}), \
                patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            result = close_launched_applications({"automation_task_id": task_id})

        self.assertFalse(result["ok"])
        self.assertFalse(result["verified"])
        self.assertIn("unsaved-work prompt", result["left_open"][0]["reason"])
        run_mock.assert_not_called()

    def test_close_launched_applications_without_owned_processes_is_verified_noop(self) -> None:
        result = close_launched_applications({"automation_task_id": "task-no-apps"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertEqual(result["closed"], [])

    def test_close_application_never_force_terminates_even_after_confirmation(self) -> None:
        with patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            result = close_application({"name": "chrome", "kill": True, "confirmed": True})
        self.assertFalse(result["ok"])
        self.assertFalse(result["verified"])
        self.assertEqual(result["error_code"], "FORCE_CLOSE_DISABLED")
        run_mock.assert_not_called()

    def test_unknown_application_close_leaves_all_processes_untouched(self) -> None:
        with patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            result = close_application({"name": "unknown helper"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_code"], "UNKNOWN_APPLICATION_UNTOUCHED")
        run_mock.assert_not_called()

    def test_graceful_close_sends_window_close_and_leaves_unsaved_prompt_open(self) -> None:
        instance = {"pid": 520, "name": "chrome.exe", "create_time": 1000.0}
        window = {"hwnd": 52, "title": "Chrome"}
        with patch("desktop_agent.tools_applications.psutil", object()), \
                patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications._matching_process_instances", return_value=[instance]), \
                patch("desktop_agent.tools_applications._windows_for_process", return_value=[window]), \
                patch("desktop_agent.tools_applications._close_recorded_windows", return_value={"closed": False, "reason": "An unsaved-work prompt appeared."}) as close_mock, \
                patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            result = close_application({"name": "chrome"})
        self.assertFalse(result["ok"])
        self.assertFalse(result["verified"])
        self.assertIn("unsaved-work prompt", result["left_open"][0]["reason"])
        close_mock.assert_called_once_with(520, [window], timeout=3.0)
        run_mock.assert_not_called()

    def test_graceful_close_verifies_visible_window_closed(self) -> None:
        instance = {"pid": 521, "name": "chrome.exe", "create_time": 1000.0}
        window = {"hwnd": 53, "title": "Chrome"}
        with patch("desktop_agent.tools_applications.psutil", object()), \
                patch("desktop_agent.tools_applications._is_windows_platform", return_value=True), \
                patch("desktop_agent.tools_applications._matching_process_instances", return_value=[instance]), \
                patch("desktop_agent.tools_applications._windows_for_process", return_value=[window]), \
                patch("desktop_agent.tools_applications._close_recorded_windows", return_value={"closed": True, "reason": "The tracked app window closed gracefully."}), \
                patch("desktop_agent.tools_applications.subprocess.run") as run_mock:
            result = close_application({"name": "chrome"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertEqual(len(result["closed"]), 1)
        run_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
