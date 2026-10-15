"""
System information: CPU, RAM, disk usage, GPU (best-effort), temperature.

Telemetry is read-only. A separate process-close tool requires explicit
confirmation, protects system/SARA processes, requests graceful closure, and
never force-kills. psutil powers the core metrics; GPU stats come from
nvidia-ml-py3 (pynvml) when an NVIDIA GPU is present, and degrade gracefully
otherwise. Temperature is best-effort via psutil.sensors_temperatures (Linux)
or WMI on Windows when available.
"""

from __future__ import annotations

import os
import platform
import threading
import time
from typing import Any, Dict, List, Tuple

from .registry import ToolError, register


def _bytes_human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024.0:
            return f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}EB"


_PROCESS_CPU_BASELINES: Dict[int, Tuple[float, float, float]] = {}
_PROCESS_CPU_BASELINES_LOCK = threading.Lock()
_PROTECTED_PROCESS_NAMES = {
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "services.exe",
    "lsass.exe", "winlogon.exe", "svchost.exe", "systemd", "init", "launchd",
    "explorer.exe", "sara.exe", "sara", "sara-agent.exe", "sara-agent", "myraa-agent.exe", "myraa-agent", "node.exe", "node", "python.exe",
    "pythonw.exe", "python", "uvicorn.exe", "uvicorn", "electron.exe", "electron",
}


def _is_protected_process(pid: int, name: str) -> bool:
    normalized = name.strip().lower()
    return pid in {0, 1, os.getpid()} or normalized in _PROTECTED_PROCESS_NAMES or "sara" in normalized


@register("systemResourceSnapshot")
def system_resource_snapshot(args: Dict[str, Any]) -> Dict[str, Any]:
    """Collect a point-in-time resource snapshot for the local system."""
    try:
        import psutil
    except Exception as exc:  # noqa: BLE001
        raise ToolError("System monitoring requires the optional 'psutil' package.") from exc

    cpu_percent = psutil.cpu_percent(interval=0.15)
    vm = psutil.virtual_memory()
    disk_data: Dict[str, Any] = {"available": False, "percent": None, "used": None, "total": None, "mountpoint": None}
    system_drive = os.environ.get("SystemDrive") or os.path.abspath(os.sep)
    try:
        disk_usage = psutil.disk_usage(system_drive)
        disk_data = {
            "available": True,
            "percent": round(float(disk_usage.percent), 1),
            "used": _bytes_human(float(disk_usage.used)),
            "total": _bytes_human(float(disk_usage.total)),
            "mountpoint": system_drive[:120],
        }
    except Exception:
        pass
    battery = None
    try:
        battery = psutil.sensors_battery()
    except Exception:
        battery = None

    battery_data: Dict[str, Any] = {"available": battery is not None, "percent": None, "power_plugged": None, "secs_left": None}
    if battery is not None:
        battery_data["percent"] = max(0, min(100, int(round(battery.percent))))
        battery_data["power_plugged"] = bool(battery.power_plugged)
        seconds_left = battery.secsleft
        if seconds_left is not None and seconds_left >= 0:
            battery_data["secs_left"] = int(seconds_left)

    now = time.monotonic()
    logical_cpus = max(1, int(psutil.cpu_count(logical=True) or 1))
    processes: List[Dict[str, Any]] = []
    seen_pids = set()
    for process in psutil.process_iter(["pid", "name", "memory_info", "memory_percent", "create_time", "cpu_times"]):
        try:
            info = process.info
            pid = int(info.get("pid") or process.pid)
            name = str(info.get("name") or "Unknown process")[:120]
            cpu_times = info.get("cpu_times")
            create_time = float(info.get("create_time") or 0)
            if cpu_times is None:
                cpu_seconds = 0.0
            else:
                cpu_seconds = float(cpu_times.user + cpu_times.system)
            with _PROCESS_CPU_BASELINES_LOCK:
                previous = _PROCESS_CPU_BASELINES.get(pid)
                if previous and previous[0] == create_time and now > previous[2]:
                    cpu_value = max(0.0, (cpu_seconds - previous[1]) / (now - previous[2]) * 100.0 / logical_cpus)
                else:
                    cpu_value = 0.0
                _PROCESS_CPU_BASELINES[pid] = (create_time, cpu_seconds, now)
            memory_info = info.get("memory_info")
            memory_bytes = int(memory_info.rss) if memory_info is not None else 0
            memory_percent = float(info.get("memory_percent") or 0.0)
            processes.append({
                "pid": pid,
                "name": name,
                "create_time": create_time,
                "cpu_percent": round(min(100.0, cpu_value), 1),
                "memory_percent": round(max(0.0, min(100.0, memory_percent)), 1),
                "memory_bytes": memory_bytes,
                "protected": _is_protected_process(pid, name),
            })
            seen_pids.add(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError, ValueError, TypeError):
            continue

    with _PROCESS_CPU_BASELINES_LOCK:
        for pid in set(_PROCESS_CPU_BASELINES) - seen_pids:
            _PROCESS_CPU_BASELINES.pop(pid, None)

    processes.sort(key=lambda item: max(item["cpu_percent"], item["memory_percent"]), reverse=True)
    processes = processes[:20]
    return {
        "result": "Local system resource snapshot collected.",
        "cpu": {"percent": round(float(cpu_percent), 1)},
        "ram": {"percent": round(float(vm.percent), 1), "used": _bytes_human(vm.used), "total": _bytes_human(vm.total)},
        "disk": disk_data,
        "battery": battery_data,
        "processes": processes,
        "captured_at": time.time(),
    }


@register("systemStopProcess")
def system_stop_process(args: Dict[str, Any]) -> Dict[str, Any]:
    """Request a confirmed, graceful close for a user-selected process; never force-kill it."""
    if args.get("confirmed") is not True:
        raise ToolError("Closing a process requires explicit user confirmation.")
    try:
        import psutil
    except Exception as exc:  # noqa: BLE001
        raise ToolError("Process monitoring requires the optional 'psutil' package.") from exc

    try:
        pid = int(args.get("pid"))
    except (TypeError, ValueError) as exc:
        raise ToolError("A valid process ID is required.") from exc
    if pid <= 1 or pid == os.getpid():
        raise ToolError("The selected process is protected and cannot be closed.")

    try:
        process = psutil.Process(pid)
        name = str(process.name())[:120]
        expected_name = str(args.get("expectedName") or "").strip()
        if expected_name and name.casefold() != expected_name.casefold():
            raise ToolError("The process changed since it was displayed; refresh the resource list and try again.")
        expected_create_time = args.get("expectedCreateTime")
        if expected_create_time is not None:
            try:
                expected_instance = float(expected_create_time)
                actual_instance = float(process.create_time())
            except (TypeError, ValueError, psutil.AccessDenied) as exc:
                raise ToolError("Could not verify the selected process instance; no process was stopped.") from exc
            if abs(expected_instance - actual_instance) > 0.01:
                raise ToolError("The process ID was reused since the resource list was displayed; no process was stopped.")
        if _is_protected_process(pid, name):
            raise ToolError("This system or SARA process is protected and cannot be closed from resource monitoring.")
        if not process.is_running():
            raise ToolError("The selected process has already exited.")

        if platform.system() == "Windows":
            try:
                import win32con
                import win32gui
            except Exception as exc:  # noqa: BLE001
                raise ToolError("A safe Windows window-close facility is unavailable; no process was stopped.") from exc
            windows: List[int] = []

            def collect_window(hwnd, _):
                try:
                    if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowThreadProcessId(hwnd)[1] == pid:
                        windows.append(hwnd)
                except Exception:
                    pass
                return True

            win32gui.EnumWindows(collect_window, None)
            if not windows:
                raise ToolError("No visible application window was found. Refusing to terminate it without a graceful close target.")
            for hwnd in windows:
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        else:
            process.terminate()  # SIGTERM allows the process to clean up; there is no force-kill fallback.

        try:
            process.wait(timeout=3.0)
        except psutil.TimeoutExpired:
            return {
                "ok": False,
                "verified": False,
                "pid": pid,
                "name": name,
                "result": "The application did not close within three seconds. It was not force-killed; unsaved work may still be open.",
            }
        return {"ok": True, "verified": True, "pid": pid, "name": name, "result": f"Graceful close verified for {name} (PID {pid})."}
    except psutil.NoSuchProcess as exc:
        raise ToolError("The selected process has already exited.") from exc


@register("systemInfo")
def system_info(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        import psutil
    except Exception:  # noqa: BLE001
        psutil = None

    cpu_percent = psutil.cpu_percent(interval=0.3)
    cpu_count_logical = psutil.cpu_count(logical=True)
    cpu_count_physical = psutil.cpu_count(logical=False) or cpu_count_logical

    vm = psutil.virtual_memory()
    ram_total = vm.total
    ram_used = vm.used
    ram_percent = vm.percent

    # Disk usage on the system drive (and project drive if different).
    disks: Dict[str, Dict[str, Any]] = {}
    seen = set()
    try:
        for part in psutil.disk_partitions(all=False):
            mp = part.mountpoint
            if mp in seen:
                continue
            seen.add(mp)
            try:
                du = psutil.disk_usage(mp)
                disks[mp] = {
                    "total": _bytes_human(du.total),
                    "used": _bytes_human(du.used),
                    "free": _bytes_human(du.free),
                    "percent": du.percent,
                }
            except Exception:
                continue
    except Exception:
        pass

    boot = psutil.boot_time()
    import datetime as _dt

    uptime = _dt.datetime.now() - _dt.datetime.fromtimestamp(boot)

    return {
        "result": (
            f"CPU {cpu_percent}% ({cpu_count_physical} cores / {cpu_count_logical} threads). "
            f"RAM {ram_percent}% ({_bytes_human(ram_used)}/{_bytes_human(ram_total)}). "
            f"{len(disks)} disk(s) monitored. Uptime {uptime}."
        ),
        "cpu": {"percent": cpu_percent, "physical_cores": cpu_count_physical, "logical_cores": cpu_count_logical},
        "ram": {"percent": ram_percent, "used": _bytes_human(ram_used), "total": _bytes_human(ram_total)},
        "disks": disks,
        "uptime_seconds": int(uptime.total_seconds()),
        "os": platform.platform(),
    }


def _gpu_stats() -> list:
    try:
        import pynvml  # type: ignore
        from pynvml import (  # type: ignore
            NVML_TEMPERATURE_GPU,
            NVML_CLOCK_GRAPHICS,
            NVML_CLOCK_MEM,
            nvmlInit,
            nvmlDeviceGetCount,
            nvmlDeviceGetHandleByIndex,
            nvmlDeviceGetName,
            nvmlDeviceGetUtilizationRates,
            nvmlDeviceGetMemoryInfo,
            nvmlDeviceGetTemperature,
            nvmlDeviceGetClockInfo,
        )
    except Exception:
        return []

    gpus = []
    try:
        nvmlInit()
        count = nvmlDeviceGetCount()
        for i in range(count):
            h = nvmlDeviceGetHandleByIndex(i)
            util = nvmlDeviceGetUtilizationRates(h)
            mem = nvmlDeviceGetMemoryInfo(h)
            gpus.append(
                {
                    "index": i,
                    "name": nvmlDeviceGetName(h).decode() if isinstance(nvmlDeviceGetName(h), bytes) else str(nvmlDeviceGetName(h)),
                    "gpu_utilization_percent": util.gpu,
                    "memory_utilization_percent": util.memory,
                    "memory_total": _bytes_human(mem.total),
                    "memory_used": _bytes_human(mem.used),
                    "memory_free": _bytes_human(mem.free),
                    "temperature_c": nvmlDeviceGetTemperature(h, NVML_TEMPERATURE_GPU),
                }
            )
    except Exception:
        return []
    return gpus


@register("gpuInfo")
def gpu_info(args: Dict[str, Any]) -> Dict[str, Any]:
    gpus = _gpu_stats()
    if not gpus:
        return {
            "result": (
                "No NVIDIA GPU stats available via pynvml (no NVIDIA GPU, "
                "driver missing, or nvidia-ml-py3 not installed)."
            ),
            "gpus": [],
        }
    summary = "; ".join(
        f"{g['name']}: {g['gpu_utilization_percent']}% GPU, "
        f"{g['memory_used']}/{g['memory_total']} VRAM, {g['temperature_c']}°C"
        for g in gpus
    )
    return {"result": summary, "gpus": gpus}


@register("temperatureInfo")
def temperature_info(args: Dict[str, Any]) -> Dict[str, Any]:
    # Prefer GPU temp if available (NVIDIA), then psutil sensors.
    gpus = _gpu_stats()
    temps: Dict[str, Any] = {}
    for g in gpus:
        temps[f"gpu{g['index']}"] = g["temperature_c"]

    try:
        try:
            import psutil
        except Exception:  # noqa: BLE001
            psutil = None

        sensors = psutil.sensors_temperatures() if hasattr(psutil, "sensors_temperatures") else {}
        for name, entries in (sensors or {}).items():
            for entry in entries[:1]:
                temps[name] = entry.current
    except Exception:
        pass

    # Windows CPU temps generally require admin + OpenHardwareMonitor/LibreHardwareMonitor.
    if not temps:
        return {
            "result": (
                "Temperature reading unavailable. On Windows, CPU temps need "
                "LibreHardwareMonitor or admin access; GPU temps need an NVIDIA GPU."
            ),
            "temperatures": {},
        }
    summary = ", ".join(f"{k}={v}°C" for k, v in temps.items())
    return {"result": f"Temperatures: {summary}.", "temperatures": temps}


__all__ = ["system_info", "gpu_info", "temperature_info"]
