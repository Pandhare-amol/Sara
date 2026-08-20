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
        with self._lock:
            self.state.interval = max(0.5, float(interval))
            self.state.max_events = max(1, int(max_events))
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
        event = {"timestamp": time.time(), "text": text, "metadata": metadata or {}}
        with self._lock:
            self.state.last_seen = text
            self.state.events.append(event)
            self.state.events = self.state.events[-self.state.max_events :]
            self._persist_event(event)
        return event

    def sample(self) -> Dict[str, Any]:
        from .tools_screenshot import read_screen, save_screenshot

        try:
            result = read_screen({"max_chars": 1000})
            image_path = ""
            if self.state.capture_images:
                saved = save_screenshot({"name": "live-screen"})
                image_path = str(saved.get("path") or "")
                self.state.latest_image_path = image_path
            text = str(result.get("text") or result.get("result") or "")
            event = self.note(text, {"active_window": result.get("active_window"), "image_path": image_path})
            return {"result": result, "event": event, "image_path": image_path}
        except Exception as exc:  # noqa: BLE001
            event = self.note(f"screen_capture_failed: {exc}", {"error": str(exc)})
            return {"error": str(exc), "event": event}

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
        while not self._stop.is_set():
            try:
                self.sample()
            except Exception as exc:  # noqa: BLE001
                self.note(f"monitor_error: {exc}")
            self._stop.wait(self.state.interval)
        self.state.running = False


SCREEN_MONITOR = ScreenMonitor()
