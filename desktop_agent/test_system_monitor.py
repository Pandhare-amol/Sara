import sys
import types
import unittest
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent.tools_system import system_resource_snapshot, system_stop_process


class SystemMonitorToolTests(unittest.TestCase):
    def _fake_psutil(self, process=None):
        fake = types.SimpleNamespace(
            NoSuchProcess=type("NoSuchProcess", (Exception,), {}),
            AccessDenied=type("AccessDenied", (Exception,), {}),
            ZombieProcess=type("ZombieProcess", (Exception,), {}),
            TimeoutExpired=type("TimeoutExpired", (Exception,), {}),
            cpu_percent=lambda interval=None: 37.5,
            cpu_count=lambda logical=True: 4,
            virtual_memory=lambda: types.SimpleNamespace(percent=64.2, used=6_000, total=10_000),
            disk_usage=lambda _path: types.SimpleNamespace(percent=42.1, used=4_200, total=10_000),
            sensors_battery=lambda: types.SimpleNamespace(percent=18, power_plugged=False, secsleft=900),
            process_iter=lambda attrs: [process] if process is not None else [],
        )
        return fake

    def test_resource_snapshot_contains_cpu_memory_battery_and_process_metrics(self):
        process = types.SimpleNamespace(
            pid=123456,
            info={
                "pid": 123456,
                "name": "ExampleApp",
                "memory_info": types.SimpleNamespace(rss=2_000_000),
                "memory_percent": 12.5,
                "create_time": 12_345.0,
                "cpu_times": types.SimpleNamespace(user=2.0, system=1.0),
            },
        )
        fake_psutil = self._fake_psutil(process)
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            snapshot = system_resource_snapshot({})

        self.assertEqual(snapshot["cpu"]["percent"], 37.5)
        self.assertEqual(snapshot["ram"]["percent"], 64.2)
        self.assertEqual(snapshot["disk"]["percent"], 42.1)
        self.assertTrue(snapshot["disk"]["available"])
        self.assertEqual(snapshot["battery"]["percent"], 18)
        self.assertFalse(snapshot["battery"]["power_plugged"])
        self.assertEqual(snapshot["processes"][0]["pid"], 123456)
        self.assertEqual(snapshot["processes"][0]["create_time"], 12_345.0)
        self.assertEqual(snapshot["processes"][0]["memory_bytes"], 2_000_000)
        self.assertFalse(snapshot["processes"][0]["protected"])

    def test_close_requires_confirmation_and_only_requests_non_forceful_termination(self):
        with self.assertRaisesRegex(ToolError, "confirmation"):
            system_stop_process({"pid": 123456, "confirmed": False})

        calls = {"terminate": 0, "kill": 0}

        class FakeProcess:
            pid = 123456

            def name(self):
                return "ExampleApp"

            def is_running(self):
                return True

            def terminate(self):
                calls["terminate"] += 1

            def wait(self, timeout):
                self.wait_timeout = timeout
                return 0

            def kill(self):
                calls["kill"] += 1

        fake_psutil = self._fake_psutil()
        fake_psutil.Process = lambda pid: FakeProcess()
        with patch.dict(sys.modules, {"psutil": fake_psutil}), patch("desktop_agent.tools_system.platform.system", return_value="Linux"):
            result = system_stop_process({"pid": 123456, "expectedName": "ExampleApp", "confirmed": True})

        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertEqual(calls["terminate"], 1)
        self.assertEqual(calls["kill"], 0)

    def test_close_refuses_process_name_change_and_protected_sara_names(self):
        class FakeProcess:
            pid = 123456

            def name(self):
                return "OtherApp"

            def is_running(self):
                return True

        fake_psutil = self._fake_psutil()
        fake_psutil.Process = lambda pid: FakeProcess()
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            with self.assertRaisesRegex(ToolError, "changed since"):
                system_stop_process({"pid": 123456, "expectedName": "ExampleApp", "confirmed": True})

        class ReusedProcess:
            pid = 123456

            def name(self):
                return "ExampleApp"

            def create_time(self):
                return 99.0

            def is_running(self):
                return True

        fake_psutil.Process = lambda pid: ReusedProcess()
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            with self.assertRaisesRegex(ToolError, "process ID was reused"):
                system_stop_process({"pid": 123456, "expectedName": "ExampleApp", "expectedCreateTime": 12_345.0, "confirmed": True})

        class ProtectedProcess:
            pid = 123456

            def name(self):
                return "sara-agent.exe"

            def is_running(self):
                return True

        fake_psutil.Process = lambda pid: ProtectedProcess()
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            with self.assertRaisesRegex(ToolError, "protected"):
                system_stop_process({"pid": 123456, "confirmed": True})


if __name__ == "__main__":
    unittest.main()
