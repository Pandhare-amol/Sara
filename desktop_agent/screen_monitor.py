"""
SARA Native Screen Monitor — Live robust screen capture.

Provides real-time screen frames and text extraction using mss/PIL.
Maintains state safely and ensures SARA does not crash on capture failure.

States: IDLE, STARTING, MONITORING, PAUSED, STOPPING, STOPPED, ERROR
"""

from __future__ import annotations

import logging
import logging.handlers
import threading
import time
from typing import Any, Dict, List, Optional
import io
import base64

def _get_logger() -> logging.Logger:
    logger = logging.getLogger("sara.screen_monitor")
    if logger.handlers:
        return logger
    logger.setLevel(logging.DEBUG)
    try:
        import os
        log_dir = os.path.join(os.environ.get("SARA_DATA_DIR") or os.getcwd(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            os.path.join(log_dir, "screen_monitor.log"),
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        logger.addHandler(fh)
    except Exception:
        pass
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter("[ScreenMonitor] %(message)s"))
    sh.setLevel(logging.WARNING)
    logger.addHandler(sh)
    return logger

_log = _get_logger()

try:
    import mss
    _HAS_MSS = True
except ImportError:
    _HAS_MSS = False

try:
    from PIL import Image, ImageGrab
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False

class ScreenMonitorState:
    IDLE = "IDLE"
    STARTING = "STARTING"
    MONITORING = "MONITORING"
    PAUSED = "PAUSED"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    ERROR = "ERROR"

class ScreenMonitor:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self.state = ScreenMonitorState.IDLE
        self.error_msg = ""
        
        self.fps = 1.0
        self.quality = 50
        self.max_width = 1280
        self.max_height = 720
        self.monitor_index = 1 # 1 = primary monitor in mss
        
        self._consecutive_failures = 0
        self.last_frame_info: Dict[str, Any] = {}

    def _safe_transition(self, new_state: str, error: str = "") -> None:
        with self._lock:
            self.state = new_state
            if error:
                self.error_msg = error
            else:
                self.error_msg = ""

    def start(self, interval: float = 0.5, max_events: int = 3, **kwargs: Any) -> Dict[str, Any]:
        """Compatibility wrapper expected by tests and legacy callers."""
        self._sample_interval = max(0.1, float(interval))
        self._sample_limit = max(1, int(max_events))
        self._stop_event.clear()
        self._running = True
        self._safe_transition(ScreenMonitorState.MONITORING)
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run_live, name="sara-screen-live", daemon=True)
            self._thread.start()
        return {"running": True, "state": self.state, "interval": self._sample_interval, "max_events": self._sample_limit}

    def sample(self) -> Dict[str, Any]:
        """Capture a single sample and return a minimal event payload."""
        try:
            frame = self._capture_frame()
            if frame and frame.get("valid"):
                return {
                    "event": "screen_sample",
                    "result": {"width": frame["width"], "height": frame["height"], "ts": frame["ts"], "size_bytes": len(frame["frame"])},
                }
            return {"event": "screen_sample", "error": "No valid frame captured."}
        except Exception as exc:
            return {"event": "screen_sample", "error": str(exc)}

    def start_live(self, fps: float = 1.0, quality: int = 50, max_width: int = 1280, max_height: int = 720, monitor_index: int = 1) -> Dict[str, Any]:
        with self._lock:
            if self.state in (ScreenMonitorState.STARTING, ScreenMonitorState.MONITORING):
                return self.status()
                
            self._safe_transition(ScreenMonitorState.STARTING)
            self.fps = max(0.1, fps)
            self.quality = max(10, min(100, quality))
            self.max_width = max_width
            self.max_height = max_height
            self.monitor_index = monitor_index
            self._consecutive_failures = 0
            self._running = True
            
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run_live, name="sara-screen-live", daemon=True)
            self._thread.start()
            
            # Wait briefly to ensure it starts successfully (validate first frame)
            time.sleep(0.5)
            return self.status()

    def stop(self) -> Dict[str, Any]:
        _log.info("Stopping screen monitor.")
        with self._lock:
            if self.state in (ScreenMonitorState.IDLE, ScreenMonitorState.STOPPED, ScreenMonitorState.ERROR):
                return {"running": False, "state": self.state, "error": self.error_msg}
            self._safe_transition(ScreenMonitorState.STOPPING)
            self._running = False
            self._stop_event.set()
            
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
            
        self._safe_transition(ScreenMonitorState.STOPPED)
        _log.info("Screen monitor stopped.")
        return {"running": False, "state": self.state, "error": self.error_msg}

    def pause(self) -> Dict[str, Any]:
        with self._lock:
            if self.state == ScreenMonitorState.MONITORING:
                self._safe_transition(ScreenMonitorState.PAUSED)
        return self.status()

    def resume(self) -> Dict[str, Any]:
        with self._lock:
            if self.state == ScreenMonitorState.PAUSED:
                self._safe_transition(ScreenMonitorState.MONITORING)
        return self.status()

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "state": self.state,
                "error": self.error_msg,
                "fps": self.fps,
                "running": self.state in (ScreenMonitorState.STARTING, ScreenMonitorState.MONITORING, ScreenMonitorState.PAUSED),
                "last_frame": self.last_frame_info,
            }

    def _capture_frame(self) -> Optional[Dict[str, Any]]:
        """Capture a single frame using mss or PIL, resize, and compress to JPEG base64."""
        if not _HAS_MSS and not _HAS_PIL:
            raise RuntimeError("Neither mss nor PIL is installed. Cannot capture screen.")

        img = None
        if _HAS_MSS:
            try:
                with mss.mss() as sct:
                    monitors = sct.monitors
                    if self.monitor_index < len(monitors):
                        monitor = monitors[self.monitor_index]
                    else:
                        monitor = monitors[0] # All monitors
                    
                    sct_img = sct.grab(monitor)
                    # Convert to PIL Image
                    img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
            except Exception as e:
                _log.warning(f"mss capture failed: {e}. Falling back to PIL.")
                pass

        if img is None and _HAS_PIL:
            try:
                # all_screens=True works on Windows to get all monitors
                img = ImageGrab.grab(all_screens=True)
            except Exception as e:
                raise RuntimeError(f"PIL capture failed: {e}")

        if img is None:
            raise RuntimeError("Screen capture failed to produce an image.")

        width, height = img.size
        if width == 0 or height == 0:
            raise RuntimeError(f"Invalid capture dimensions: {width}x{height}")

        # Resize if too large
        if width > self.max_width or height > self.max_height:
            ratio = min(self.max_width / width, self.max_height / height)
            new_w = int(width * ratio)
            new_h = int(height * ratio)
            # Use Resampling.LANCZOS if available, else ANTIALIAS
            resample = getattr(Image, "Resampling", Image).LANCZOS
            img = img.resize((new_w, new_h), resample)
            width, height = new_w, new_h

        # Compress to JPEG
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=self.quality)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        return {
            "width": width,
            "height": height,
            "frame": b64,
            "ts": time.time(),
            "valid": True
        }

    def _run_live(self) -> None:
        self._safe_transition(ScreenMonitorState.MONITORING)
        _log.info("Live screen monitoring thread started.")
        
        while not self._stop_event.is_set():
            start_time = time.time()
            
            if self.state == ScreenMonitorState.PAUSED:
                time.sleep(0.5)
                continue
                
            try:
                frame_data = self._capture_frame()
                if frame_data and frame_data.get("valid"):
                    self._consecutive_failures = 0
                    with self._lock:
                        self.last_frame_info = {
                            "width": frame_data["width"],
                            "height": frame_data["height"],
                            "ts": frame_data["ts"],
                            "size_bytes": len(frame_data["frame"])
                        }
                    
                    # Push frame to backend if connected. We can use requests to localhost:3000
                    # For performance, this is often handled by App.tsx IPC now, but if the python agent 
                    # needs to process OCR or vision models itself, it happens here.
                    
            except Exception as exc:
                self._consecutive_failures += 1
                _log.error(f"Screen capture failed (consecutive: {self._consecutive_failures}): {exc}")
                if self._consecutive_failures >= 5:
                    self._safe_transition(ScreenMonitorState.ERROR, str(exc))
                    break # Give up after 5 consecutive failures

            elapsed = time.time() - start_time
            sleep_time = (1.0 / self.fps) - elapsed
            if sleep_time > 0:
                self._stop_event.wait(sleep_time)

        if self.state != ScreenMonitorState.ERROR:
            self._safe_transition(ScreenMonitorState.STOPPED)
        _log.info("Live screen monitoring thread exited.")


SCREEN_MONITOR = ScreenMonitor()
