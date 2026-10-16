from __future__ import annotations

import importlib
import os
import tempfile
import threading
import unittest
from unittest.mock import patch


class AgentPlannerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name
        import desktop_agent.agents as agents

        self.agents = importlib.reload(agents)

    def tearDown(self) -> None:
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_competitor_workflow_has_dependencies(self) -> None:
        plan = self.agents.plan_goal("research 10 competitors, create a spreadsheet, analyze them, make a presentation, and save everything")
        self.assertGreaterEqual(len(plan), 4)
        deps = [step.get("depends_on", []) for step in plan]
        self.assertTrue(any(dep for dep in deps))
        layers = self.agents._build_execution_layers(plan)
        self.assertTrue(layers)
        self.assertTrue(any(len(layer) > 1 for layer in layers))

    def test_emergency_stop_prevents_later_workflow_steps_and_preserves_uncertainty(self) -> None:
        started = threading.Event()
        release = threading.Event()

        agents_module = self.agents

        class BlockingAgent(agents_module.BaseAgent):
            def __init__(self):
                super().__init__("blocking_agent", ["test"])
                self.actions = []

            def execute(self, task):
                self.start()
                self.actions.append(task.action)
                if task.action == "first":
                    started.set()
                    release.wait(2)
                return agents_module.AgentResult(status="completed", result="tool returned")

        manager = self.agents.AgentManager()
        agent = BlockingAgent()
        manager.register_agent(agent)
        steps = [
            {"agent": "blocking_agent", "action": "first", "args": {}},
            {"agent": "blocking_agent", "action": "second", "args": {}},
        ]
        results = {}
        with patch.object(self.agents, "plan_goal", return_value=steps), \
                patch.object(self.agents.MEMORY, "remember"), \
                patch.object(self.agents.RECOVERY, "latest_incomplete_for_goal", return_value=None), \
                patch.object(self.agents.RECOVERY, "save"):
            worker = threading.Thread(target=lambda: results.setdefault("workflow", manager.execute_for_sara("test workflow")), daemon=True)
            worker.start()
            self.assertTrue(started.wait(2))
            stop_result = manager.emergency_stop()
            self.assertTrue(stop_result["running_tool_calls_may_finish"])
            self.assertEqual(len(stop_result["cancellation_requested_tasks"]), 1)
            release.set()
            worker.join(3)

        workflow = results["workflow"]
        self.assertEqual(workflow["status"], "cancelled")
        self.assertEqual(agent.actions, ["first"])
        self.assertEqual(workflow["results"][0]["task"]["status"], "cancelled")
        self.assertTrue(workflow["results"][0]["task"]["cancellation_requested"])
        self.assertIn("may have completed external effects", workflow["results"][0]["task"]["error"])
        self.assertIn("review the external state", workflow["sara_summary"])


if __name__ == "__main__":
    unittest.main()
