from __future__ import annotations

import importlib
import os
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
