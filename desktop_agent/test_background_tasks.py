import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent.tools_background import BackgroundTaskManager


class BackgroundTaskManagerTest(unittest.TestCase):
    def make_manager(self):
        directory = tempfile.TemporaryDirectory()
        with patch("desktop_agent.tools_background.data_root", return_value=Path(directory.name)):
            manager = BackgroundTaskManager()
        self.addCleanup(directory.cleanup)
        return manager, Path(directory.name)

    def test_cancelled_task_does_not_start_unknown_tool(self):
        manager, _ = self.make_manager()
        manager._run = lambda task_id: None
        with patch.dict("desktop_agent.tools_background.TOOLS", {"slow": lambda args: time.sleep(0.05)}), \
                patch("desktop_agent.tools_background.MEMORY.remember"):
            task = manager.submit("slow", {}, "test")
            cancelled = manager.cancel(task["id"])

        self.assertTrue(cancelled["cancel_requested"])
        self.assertEqual(cancelled["status"], "cancelled")

    def test_auto_close_runs_only_after_a_verified_opted_in_app_task(self):
        manager, _ = self.make_manager()
        calls = []

        def app_goal(args):
            self.assertTrue(args.get("automation_task_id"))
            return {"ok": True, "verified": True, "auto_close_after_task": True, "result": "Task completed."}

        def close_app(args):
            calls.append(args)
            return {"ok": True, "verified": True, "status": "completed", "closed": [{"pid": 1}], "left_open": []}

        with patch("desktop_agent.tools_background.threading.Thread") as thread, \
                patch("desktop_agent.tools_background.MEMORY.remember"), \
                patch("desktop_agent.tools_background.REINFORCEMENT.record", return_value={}), \
                patch.dict("desktop_agent.tools_background.TOOLS", {"saraAppExecuteGoal": app_goal, "closeLaunchedApplications": close_app}, clear=False):
            task = manager.submit("saraAppExecuteGoal", {"goal": "complete helper task"}, "verified app task")
            manager._run(task["id"])

        snapshot = manager.status(task["id"])
        self.assertEqual(snapshot["status"], "completed")
        self.assertTrue(snapshot["auto_close_result"]["verified"])
        self.assertEqual(calls, [{"automation_task_id": task["id"]}])
        thread.assert_called_once()

    def test_unverified_app_task_never_triggers_auto_close(self):
        manager, _ = self.make_manager()
        close_app = lambda _args: self.fail("unverified tasks must not close apps")
        with patch("desktop_agent.tools_background.threading.Thread"), \
                patch("desktop_agent.tools_background.MEMORY.remember"), \
                patch("desktop_agent.tools_background.REINFORCEMENT.record", return_value={}), \
                patch.dict("desktop_agent.tools_background.TOOLS", {
                    "saraAppExecuteGoal": lambda _args: {"ok": True, "verified": False, "auto_close_after_task": True},
                    "closeLaunchedApplications": close_app,
                }, clear=False):
            task = manager.submit("saraAppExecuteGoal", {"goal": "uncertain task"}, "unverified app task")
            manager._run(task["id"])

        snapshot = manager.status(task["id"])
        self.assertIsNone(snapshot["auto_close_result"])

    def test_emergency_stop_requests_running_cancel_and_skips_auto_close(self):
        manager, _ = self.make_manager()
        started = threading.Event()
        release = threading.Event()
        close_calls = []

        def app_goal(_args):
            started.set()
            release.wait(2)
            return {"ok": True, "verified": True, "auto_close_after_task": True, "result": "Task completed."}

        with patch("desktop_agent.tools_background.threading.Thread"), \
                patch("desktop_agent.tools_background.MEMORY.remember"), \
                patch.dict("desktop_agent.tools_background.TOOLS", {"saraAppExecuteGoal": app_goal}, clear=False):
            task = manager.submit("saraAppExecuteGoal", {"goal": "complete helper task"}, "stop test")

        with patch("desktop_agent.tools_background.MEMORY.remember"), \
                patch("desktop_agent.tools_background.REINFORCEMENT.record", return_value={}), \
                patch.dict("desktop_agent.tools_background.TOOLS", {
                    "saraAppExecuteGoal": app_goal,
                    "closeLaunchedApplications": lambda args: close_calls.append(args),
                }, clear=False):
            worker = threading.Thread(target=manager._run, args=(task["id"],), daemon=True)
            worker.start()
            self.assertTrue(started.wait(1))
            stopped = manager.emergency_stop()
            self.assertEqual(stopped["cancellation_requested_running_task_ids"], [task["id"]])
            self.assertTrue(stopped["active_tool_calls_may_finish"])
            self.assertEqual(manager.status(task["id"])["status"], "cancelling")
            release.set()
            worker.join(2)

        snapshot = manager.status(task["id"])
        self.assertEqual(snapshot["status"], "cancelled")
        self.assertIn("external effects", snapshot["error"].lower())
        self.assertEqual(close_calls, [])
        self.assertEqual(snapshot["auto_close_result"]["status"], "left_open")

    def test_restart_marks_unfinished_tasks_paused(self):
        manager, directory = self.make_manager()
        manager._store.write_text('[{"id":"old","tool":"slow","args":{},"status":"running","result":null,"error":"","created_at":1,"started_at":1,"finished_at":null,"label":"old"}]', encoding="utf-8")
        with patch("desktop_agent.tools_background.data_root", return_value=directory):
            restored = BackgroundTaskManager()
        self.assertEqual(restored._tasks["old"].status, "paused")
        self.assertIn("restarted", restored._tasks["old"].error.lower())


if __name__ == "__main__":
    unittest.main()