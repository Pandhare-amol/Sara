from __future__ import annotations

import importlib
import os
import tempfile
import time
import unittest


class ScreenMonitorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name

        import desktop_agent.platform_core as platform_core
        import desktop_agent.screen_monitor as screen_monitor

        platform_core.close_all_services()
        self.screen_monitor = importlib.reload(screen_monitor)

    def tearDown(self) -> None:
        try:
            import desktop_agent.platform_core as platform_core
            platform_core.close_all_services()
        except Exception:
            pass
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_start_sample_stop(self) -> None:
        monitor = self.screen_monitor.SCREEN_MONITOR
        started = monitor.start(interval=0.5, max_events=3)
        self.assertTrue(started["running"])
        sampled = monitor.sample()
        self.assertIn("event", sampled)
        self.assertTrue("result" in sampled or "error" in sampled)
        time.sleep(0.1)
        status = monitor.status()
        self.assertTrue(status["running"])
        stopped = monitor.stop()
        self.assertFalse(stopped["running"])


if __name__ == "__main__":
    unittest.main()
