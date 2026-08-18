from __future__ import annotations

import os
import time
import unittest


@unittest.skipUnless(os.environ.get("SARA_WINDOWS_ACCEPTANCE") == "1", "Real Windows acceptance tests disabled")
class WindowsGestureAcceptanceTest(unittest.TestCase):
    def setUp(self) -> None:
        import desktop_agent.tools_vision as tools_vision

        self.tools_vision = tools_vision

    def tearDown(self) -> None:
        try:
            self.tools_vision.gesture_control_stop({})
        except Exception:
            pass

    def _status(self) -> dict:
        return self.tools_vision.gesture_control_status({})["result"]["gesture_status"]

    def _wait_for(self, predicate, timeout_s: float = 12.0, step_s: float = 0.5) -> dict:
        deadline = time.time() + timeout_s
        last = self._status()
        while time.time() < deadline:
            last = self._status()
            if predicate(last):
                return last
            time.sleep(step_s)
        return last

    def test_camera_lifecycle(self) -> None:
        stopped = self._status()
        self.assertFalse(stopped["enabled"])
        self.assertEqual(stopped["state"], "DISABLED")

        started = self.tools_vision.gesture_control_start({})["data"]
        self.assertTrue(started["enabled"])

        active = self._wait_for(lambda s: s["vision_state"]["status"] in {"ACTIVE", "STARTING", "PAUSED"})
        self.assertTrue(active["enabled"])
        self.assertIn(active["state"], {"IDLE", "TRACKING", "ARMED", "ACTIVE", "PAUSED"})
        self.assertTrue(active["vision_state"]["camera_available"])

        paused = self.tools_vision.gesture_control_pause({})["data"]
        self.assertTrue(paused["paused"])

        resumed = self.tools_vision.gesture_control_resume({})["data"]
        self.assertFalse(resumed["paused"])

        stopped = self.tools_vision.gesture_control_stop({})["data"]
        self.assertFalse(stopped["enabled"])
        self.assertEqual(stopped["state"], "DISABLED")

    def test_hand_detection_or_skip(self) -> None:
        started = self.tools_vision.gesture_control_start({})["data"]
        self.assertTrue(started["enabled"])
        active = self._wait_for(lambda s: s["vision_state"]["status"] == "ACTIVE", timeout_s=15.0)
        hands = active["vision_state"].get("hands_detected", 0)
        gestures = active["vision_state"].get("gestures", [])
        if hands <= 0 and not gestures:
            self.skipTest("No hand was presented to the webcam during acceptance")
        self.assertGreaterEqual(hands, 1)
        self.assertGreaterEqual(len(gestures), 1)


if __name__ == "__main__":
    unittest.main()
