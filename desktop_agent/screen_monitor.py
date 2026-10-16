"""Background screen monitoring helpers for SARA."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ScreenMonitorState:
    running: bool = False
    interval: float = 5.0
    max_events: int = 20
    last_seen: str = ""
    latest_image_path: str = ""
    capture_images: bool = False
    events: List[Dict[str, Any]] = field(default_factory=list)


class ScreenMonitor:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.state = ScreenMonitorState()

    def start(self, interval: float = 5.0, max_events: int = 20, capture_images: bool = False) -> Dict[str, Any]:
        from .visual_access import VISUAL_ACCESS
        VISUAL_ACCESS.require(monitor=True, save=bool(capture_images))
        with self._lock:
            self.state.interval = max(5.0 if capture_images else 1.0, min(60.0, float(interval)))
            self.state.max_events = max(1, min(20, int(max_events)))
            self.state.capture_images = bool(capture_images)
            if self._thread and self._thread.is_alive():
                self.state.running = True
                return self.status()
            self._stop.clear()
            self.state.running = True
            self._thread = threading.Thread(target=self._run, name="sara-screen-monitor", daemon=True)
            self._thread.start()
            return self.status()

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            self._stop.set()
            self.state.running = False
        return self.status()

    def status(self) -> Dict[str, Any]:
        return asdict(self.state) | {"events": list(self.state.events[-self.state.max_events :])}

    def note(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        # Do not keep raw OCR, window titles, image paths or exception details
        # in status/history or the persistent event file.
        safe_status = str((metadata or {}).get("status") or "observation")
        if safe_status not in {"observed", "capture_failed", "monitor_stopped", "observation"}:
            safe_status = "observation"
        event = {"timestamp": time.time(), "text": safe_status, "metadata": {"status": safe_status}}
        with self._lock:
            self.state.last_seen = text
            self.state.events.append(event)
            self.state.events = self.state.events[-self.state.max_events :]
            self._persist_event(event)
        return event

    def sample(self) -> Dict[str, Any]:
        from .tools_screenshot import read_screen, save_screenshot
        from .visual_access import VISUAL_ACCESS
        VISUAL_ACCESS.require(monitor=True, save=self.state.capture_images)

        try:
            result = read_screen({"max_chars": 1000})
            image_path = ""
            if self.state.capture_images:
                saved = save_screenshot({"name": "live-screen"})
                image_path = str(saved.get("path") or "")
                self.state.latest_image_path = image_path
            event = self.note("observed", {"status": "observed"})
            # Caller receives this transient result; raw OCR is never stored in
            # the monitor's status, event history or persistence file.
            return {"result": result, "event": event, "image_path": image_path}
        except Exception:  # noqa: BLE001
            event = self.note("capture_failed", {"status": "capture_failed"})
            return {"error": "Screen observation unavailable; check the current permission/window.", "event": event}

    def _persist_event(self, event: Dict[str, Any]) -> None:
        try:
            from .platform_core import _read_json, _write_json, data_root

            path = data_root() / "sara_screen_events.json"
            events = _read_json(path, [])
            events.append(event)
            _write_json(path, events[-500:])
        except Exception:
            pass

    def _run(self) -> None:
        from .registry import ToolError
        while not self._stop.is_set():
            try:
                self.sample()
            except ToolError:
                self.note("monitor_stopped", {"status": "monitor_stopped"})
                break  # expired/revoked consent cannot keep a monitor alive
            except Exception:  # noqa: BLE001
                self.note("capture_failed", {"status": "capture_failed"})
            self._stop.wait(self.state.interval)
        self.state.running = False


SCREEN_MONITOR = ScreenMonitor()
