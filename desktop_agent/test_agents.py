from __future__ import annotations

import importlib
import os
import tempfile
import unittest
from pathlib import Path


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
        try:
            self.agents.close_all_services()
        except Exception:
            pass
        self.tmp.cleanup()

    def test_competitor_workflow_has_dependencies(self) -> None:
        plan = self.agents.plan_goal("research 10 competitors, create a spreadsheet, analyze them, make a presentation, and save everything")
        self.assertGreaterEqual(len(plan), 4)
        deps = [step.get("depends_on", []) for step in plan]
        self.assertTrue(any(dep for dep in deps))
        layers = self.agents._build_execution_layers(plan)
        self.assertTrue(layers)
        self.assertTrue(any(len(layer) > 1 for layer in layers))

    def test_tool_registry_exposes_permission_and_verification_metadata(self) -> None:
        registry = self.agents.TOOL_REGISTRY
        self.assertIn("openApplication", registry.tools)
        tool = registry.get("openApplication")
        self.assertEqual(tool["permission_level"], "LOW")
        self.assertIn("verification_method", tool)
        self.assertIn("risk_level", tool)

    def test_high_risk_actions_require_explicit_permission(self) -> None:
        registry = self.agents.TOOL_REGISTRY
        # openApplication is non-destructive: allowed without confirmation
        self.assertTrue(registry.is_allowed("openApplication", {"name": "vscode"}))
        # closeApplication can lose unsaved work: requires confirmation
        self.assertFalse(registry.is_allowed("closeApplication", {"name": "vscode"}))
        # power actions always require confirmation
        self.assertFalse(registry.is_allowed("requestPowerAction", {"action": "shutdown"}))
        self.assertTrue(registry.is_allowed("requestPowerAction", {"action": "shutdown", "confirmed": True}))

    def test_verification_engine_classifies_outcomes(self) -> None:
        verification = self.agents.VERIFICATION_ENGINE
        self.assertEqual(verification.evaluate("opened vscode window", "openApplication"), "SUCCESS")
        self.assertEqual(verification.evaluate("no such window", "openApplication"), "FAILED")
        self.assertEqual(verification.evaluate("maybe open", "openApplication"), "UNCERTAIN")

    def test_browser_control_aliases_are_registered(self) -> None:
        registry = self.agents.TOOL_REGISTRY
        for name in [
            "browserOpen",
            "browserSearch",
            "browserClick",
            "browserType",
            "browserScroll",
            "browserGoBack",
            "browserMediaControl",
            "browserTabAction",
        ]:
            self.assertIn(name, registry.tools)

    def test_camera_controls_are_exposed_to_live_runtime_bridge(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "server.ts").read_text(encoding="utf-8")
        for name in [
            "openCamera",
            "takePhoto",
            "recordVideo",
            "stopVideoRecording",
            "scanQrCode",
            "saveCapturedPhoto",
            "showCapturedMedia",
            "saraCameraOpen",
            "saraCameraTakePhoto",
            "saraCameraRecordVideo",
            "saraCameraStopRecording",
            "saraCameraScanQr",
        ]:
            self.assertIn(f'"{name}"', source, f"Missing runtime bridge entry for {name}")

    def test_hardware_and_voice_controls_are_exposed_to_live_runtime_bridge(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "server.ts").read_text(encoding="utf-8")
        for name in [
            "hardwareMouseMove",
            "hardwareMouseClick",
            "hardwareMouseDrag",
            "hardwareMouseScroll",
            "hardwareMousePosition",
            "hardwareKeyboardType",
            "hardwareKeyboardPress",
            "hardwareKeyboardHold",
            "hardwareKeyboardRelease",
            "hardwareMacroReplay",
            "saraVoiceParseCommand",
            "saraVoiceExecuteCommand",
            "saraVoiceTrainCommand",
            "saraVoiceStopSpeaking",
            "saraCompanionSuggestNext",
        ]:
            self.assertIn(f'"{name}"', source, f"Missing runtime bridge entry for {name}")

    def test_every_desktop_registry_tool_is_exposed_to_live_runtime_bridge(self) -> None:
        root = Path(__file__).resolve().parents[1]
        registry = self.agents.TOOL_REGISTRY
        source = (root / "server.ts").read_text(encoding="utf-8")
        missing = [name for name in registry.tools if name not in source]
        self.assertFalse(missing, f"Missing runtime bridge entries for: {missing[:20]}")


if __name__ == "__main__":
    unittest.main()
