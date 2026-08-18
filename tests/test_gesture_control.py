from __future__ import annotations

import importlib
import os
import tempfile
import unittest
from types import SimpleNamespace


def _make_landmarks(kind: str = "open_palm", *, swipe_dx: float = 0.0, swipe_dy: float = 0.0):
    pts = [SimpleNamespace(x=0.5, y=0.5, z=0.0) for _ in range(21)]
    pts[0] = SimpleNamespace(x=0.5, y=0.9, z=0.0)  # wrist
    # Thumb
    pts[3] = SimpleNamespace(x=0.45, y=0.55, z=0.0)
    pts[4] = SimpleNamespace(x=0.42, y=0.42, z=0.0)
    # Index
    pts[6] = SimpleNamespace(x=0.48, y=0.55, z=0.0)
    pts[8] = SimpleNamespace(x=0.48, y=0.28, z=0.0)
    # Middle
    pts[10] = SimpleNamespace(x=0.52, y=0.55, z=0.0)
    pts[12] = SimpleNamespace(x=0.52, y=0.30, z=0.0)
    # Ring
    pts[14] = SimpleNamespace(x=0.56, y=0.58, z=0.0)
    pts[16] = SimpleNamespace(x=0.56, y=0.33, z=0.0)
    # Pinky
    pts[18] = SimpleNamespace(x=0.60, y=0.60, z=0.0)
    pts[20] = SimpleNamespace(x=0.60, y=0.35, z=0.0)

    if kind == "fist":
        for idx in (4, 8, 12, 16, 20):
            pts[idx].y = 0.82
        pts[3].y = 0.80
    elif kind == "point":
        for idx in (12, 16, 20):
            pts[idx].y = 0.82
        pts[8].y = 0.25
    elif kind == "pinch":
        pts[4] = SimpleNamespace(x=0.47, y=0.42, z=0.0)
        pts[8] = SimpleNamespace(x=0.48, y=0.43, z=0.0)
        for idx in (12, 16, 20):
            pts[idx].y = 0.82
    elif kind == "thumbs_up":
        for idx in (8, 12, 16, 20):
            pts[idx].y = 0.82
        pts[4].y = 0.30
    elif kind == "thumbs_down":
        for idx in (8, 12, 16, 20):
            pts[idx].y = 0.82
        pts[4].y = 0.98
    if swipe_dx or swipe_dy:
        for p in pts:
            p.x += swipe_dx
            p.y += swipe_dy
    return pts


class GestureControlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name

        import desktop_agent.registry as registry
        import desktop_agent.tools_hardware as tools_hardware
        import desktop_agent.gesture_engine as gesture_engine
        import desktop_agent.gesture_tools as gesture_tools
        import desktop_agent.tools_gesture as tools_gesture
        import desktop_agent.tools_vision as tools_vision
        import desktop_agent.gesture.recognizer as recognizer
        import desktop_agent.gesture.state as state
        import desktop_agent.gesture.smoother as smoother
        import desktop_agent.gesture.safety as safety
        import desktop_agent.gesture.camera as camera

        self.registry = importlib.reload(registry)
        self.tools_hardware = importlib.reload(tools_hardware)
        self.gesture_engine = importlib.reload(gesture_engine)
        self.gesture_tools = importlib.reload(gesture_tools)
        self.tools_gesture = importlib.reload(tools_gesture)
        self.tools_vision = importlib.reload(tools_vision)
        self.recognizer = importlib.reload(recognizer)
        self.state = importlib.reload(state)
        self.smoother = importlib.reload(smoother)
        self.safety = importlib.reload(safety)
        self.camera = importlib.reload(camera)

    def tearDown(self) -> None:
        import logging
        for name in ("sara.gesture", "sara.gesture_engine", "sara.gesture_mapper", "sara.gesture.camera"):
            logger = logging.getLogger(name)
            for handler in list(logger.handlers):
                try:
                    handler.flush()
                except Exception:
                    pass
                try:
                    handler.close()
                except Exception:
                    pass
                try:
                    logger.removeHandler(handler)
                except Exception:
                    pass
        try:
            self.camera.VISION_ENGINE.disable()
        except Exception:
            pass
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_recognizer_static_gestures(self) -> None:
        open_palm = self.recognizer.recognize_gesture(_make_landmarks("open_palm"))
        self.assertEqual(open_palm.name, "OPEN_PALM")
        self.assertGreater(open_palm.confidence, 0.8)

        fist = self.recognizer.recognize_gesture(_make_landmarks("fist"))
        self.assertEqual(fist.name, "CLOSED_FIST")

        point = self.recognizer.recognize_gesture(_make_landmarks("point"))
        self.assertEqual(point.name, "INDEX_POINT")

        pinch = self.recognizer.recognize_gesture(_make_landmarks("pinch"))
        self.assertEqual(pinch.name, "PINCH")
        self.assertGreater(pinch.confidence, 0.8)

    def test_recognizer_swipe_from_trajectory(self) -> None:
        trajectory = [(0.1, 0.4), (0.25, 0.4), (0.45, 0.4), (0.72, 0.4)]
        swipe = self.recognizer.recognize_gesture(_make_landmarks("point"), trajectory=trajectory)
        self.assertIn(swipe.name, {"SWIPE_LEFT", "SWIPE_RIGHT", "SWIPE_UP", "SWIPE_DOWN"})

    def test_state_machine(self) -> None:
        machine = self.state.GestureStateMachine()
        self.assertEqual(machine.state, self.state.GestureState.DISABLED)
        machine.enable()
        self.assertEqual(machine.state, self.state.GestureState.IDLE)
        machine.observe(hands_detected=1, active_gesture="PINCH", confidence=0.9)
        self.assertIn(machine.state, {self.state.GestureState.ARMED, self.state.GestureState.TRACKING})
        machine.begin_drag("PINCH", 0.95)
        self.assertEqual(machine.state, self.state.GestureState.DRAGGING)
        machine.end_drag()
        self.assertNotEqual(machine.state, self.state.GestureState.DRAGGING)
        machine.emergency_stop()
        self.assertEqual(machine.state, self.state.GestureState.EMERGENCY_STOP)

    def test_debouncer_and_smoother(self) -> None:
        debounce = self.smoother.GestureDebouncer(min_frames=2, cooldown_s=0.1)
        self.assertFalse(debounce.allow("PINCH", 0.9, 1.0, 0.8))
        self.assertTrue(debounce.allow("PINCH", 0.9, 1.05, 0.8))
        self.assertFalse(debounce.allow("PINCH", 0.9, 1.06, 0.8))
        smooth = self.smoother.GestureSmoother(alpha=0.5, dead_zone=0.001)
        self.assertEqual(smooth.update(0.1, 0.1), (0.1, 0.1))
        self.assertNotEqual(smooth.update(0.5, 0.5), (0.1, 0.1))

    def test_camera_manager_without_cv2(self) -> None:
        original_cv2 = self.camera.cv2
        try:
            self.camera.cv2 = None
            manager = self.camera.CameraManager(index=0)
            status = manager.open()
            self.assertFalse(status.opened)
            self.assertIn("OpenCV", status.error)
        finally:
            self.camera.cv2 = original_cv2

    def test_gesture_tools_registration_and_config(self) -> None:
        self.assertIn("gestureControlSetMapping", self.registry.TOOLS)
        self.assertIn("gestureControlSetMonitor", self.registry.TOOLS)
        self.assertIn("gestureControlSetSensitivity", self.registry.TOOLS)
        self.assertIn("gestureControlSetThresholds", self.registry.TOOLS)

        mapping_result = self.tools_gesture.gesture_control_set_mapping({"gesture": "PINCH", "mapping": {"tool": "hardwareMouseClick", "args": {"button": "left"}}})
        self.assertEqual(mapping_result["status"], "SUCCESS")
        status = self.gesture_engine.GESTURE_ENGINE.get_status()
        self.assertIn("gesture_status", self.tools_vision.gesture_control_status({})["result"])
        self.assertGreaterEqual(int(status.get("mapping_size") or 0), 1)
        self.assertIn("PINCH", self.gesture_engine.GESTURE_ENGINE.get_config().get("per_gesture", {}))

        sensitivity = self.tools_gesture.gesture_control_set_sensitivity({"sensitivity": 1.5})
        self.assertEqual(sensitivity["status"], "SUCCESS")
        thresholds = self.tools_gesture.gesture_control_set_thresholds({"thresholds": {"click": 0.95}})
        self.assertEqual(thresholds["status"], "SUCCESS")

    def test_gesture_safety_blocks_dangerous_mappings(self) -> None:
        manager = self.safety.GestureSafetyManager()
        self.assertTrue(manager.requires_confirmation("deleteFile", {}))
        self.assertFalse(manager.is_allowed("PINCH", "deleteFile", {}))
        self.assertTrue(manager.is_allowed("PINCH", "hardwareMouseClick", {}))


if __name__ == "__main__":
    unittest.main()
