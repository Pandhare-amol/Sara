from __future__ import annotations

import unittest
from unittest.mock import patch

from desktop_agent import tools_voice_os


class VoiceTaskScopingTest(unittest.TestCase):
    def test_app_goal_runs_in_outer_task_and_receives_its_id(self) -> None:
        calls = []
        parsed = {
            "tool": "saraAppExecuteGoal",
            "intent": "application.automation",
            "args": {"goal": "Run a verified helper task"},
            "requires_confirmation": False,
            "response": "I will handle that through SARA's application automation.",
        }

        def app_goal(args):
            calls.append(dict(args))
            return {
                "ok": True,
                "verified": True,
                "auto_close_after_task": True,
                "result": "The helper task completed.",
            }

        with patch("desktop_agent.tools_voice_os.parse_to_dict", return_value=parsed), \
                patch("desktop_agent.tools_voice_os.MEMORY.remember", return_value={}), \
                patch("desktop_agent.tools_voice_os.COMPANION.update_context"), \
                patch("desktop_agent.tools_voice_os.REINFORCEMENT.record", return_value={}), \
                patch.dict(tools_voice_os.TOOLS, {"saraAppExecuteGoal": app_goal}, clear=False):
            result = tools_voice_os.sara_voice_execute_command({
                "command": "Run a verified helper task",
                "automation_task_id": "voice-task-42",
            })

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["automation_task_id"], "voice-task-42")
        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertTrue(result["auto_close_after_task"])
        self.assertEqual(result["result"]["result"], "The helper task completed.")

    def test_direct_app_voice_command_retains_background_execution(self) -> None:
        parsed = {
            "tool": "saraAppExecuteGoal",
            "intent": "application.automation",
            "args": {"goal": "Run a verified helper task"},
            "requires_confirmation": False,
            "response": "I will handle that through SARA's application automation.",
        }
        with patch("desktop_agent.tools_voice_os.parse_to_dict", return_value=parsed), \
                patch("desktop_agent.tools_voice_os.MEMORY.remember", return_value={}), \
                patch("desktop_agent.tools_voice_os.COMPANION.update_context"), \
                patch("desktop_agent.tools_voice_os.REINFORCEMENT.record", return_value={}), \
                patch.dict(tools_voice_os.TOOLS, {"saraAppExecuteGoal": lambda _args: {"ok": True, "verified": True}}, clear=False), \
                patch("desktop_agent.tools_background.BACKGROUND_TASKS.submit", return_value={"id": "background-1", "status": "queued"}) as submit:
            result = tools_voice_os.sara_voice_execute_command({"command": "Run a verified helper task"})

        submit.assert_called_once()
        self.assertEqual(submit.call_args.args[0], "saraAppExecuteGoal")
        self.assertEqual(result["result"]["task"]["id"], "background-1")
        self.assertNotIn("auto_close_after_task", result)


if __name__ == "__main__":
    unittest.main()
