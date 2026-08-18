import time
import os
import logging
import logging.handlers
from typing import Dict, Any, Optional

from .gesture.config import GestureConfigStore, GestureThresholds, default_config_path
from .gesture.safety import GestureSafetyManager
from .gesture.smoother import GestureDebouncer
from .gesture.state import GestureState, GestureStateMachine

def _get_logger() -> logging.Logger:
    logger = logging.getLogger("sara.gesture_engine")
    if logger.handlers:
        return logger
    logger.setLevel(logging.DEBUG)
    try:
        log_dir = os.path.join(os.environ.get("SARA_DATA_DIR") or os.getcwd(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            os.path.join(log_dir, "gesture_control.log"),
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        logger.addHandler(fh)
    except Exception:
        pass
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter("[GestureEngine] %(message)s"))
    sh.setLevel(logging.WARNING)
    logger.addHandler(sh)
    return logger

_log = _get_logger()

class GestureEngine:
    def __init__(self):
        self.enabled = False
        self.paused = False
        self.emergency_stopped = False
        self.last_executed: Dict[str, float] = {}
        self.profile = "DEFAULT"
        self._counters: Dict[str, int] = {}
        self._last_seen: Dict[str, float] = {}
        self.config = self._load_config()
        self.cooldown_seconds = float(self.config.get("cooldown_ms", 500) / 1000.0)
        self.debounce_ms = float(self.config.get("debounce_ms", 350))
        self.confidence_threshold = float(self.config.get("confidence_threshold", 0.70))
        self.state_machine = GestureStateMachine()
        self.safety = GestureSafetyManager()
        self._debouncer = GestureDebouncer(min_frames=int(self.config.get("frames_required", 3)), cooldown_s=self.cooldown_seconds)

    def enable(self) -> None:
        self.enabled = True
        self.paused = False
        self.emergency_stopped = False
        self.state_machine.enable()
        _log.info("GestureEngine enabled. Camera start is deferred to VisionEngine.enable().")

    def disable(self) -> None:
        self.enabled = False
        self.paused = False
        self.emergency_stopped = False
        self.state_machine.disable()
        self._debouncer.reset()
        _log.info("GestureEngine disabled.")
        
    def pause(self) -> None:
        self.paused = True
        self.state_machine.pause()
        _log.info("GestureEngine paused.")
        
    def resume(self) -> None:
        self.paused = False
        if not self.emergency_stopped:
            self.state_machine.resume()
        _log.info("GestureEngine resumed.")

    def set_profile(self, profile_name: str) -> None:
        self.profile = profile_name
        _log.info(f"Gesture profile set to {profile_name}.")

    def set_monitor(self, monitor_index: int) -> None:
        self.config["monitor_index"] = int(monitor_index)
        self.save_config()

    def set_camera_index(self, camera_index: int) -> None:
        self.config["camera_index"] = int(camera_index)
        self.save_config()

    def set_sensitivity(self, sensitivity: float) -> None:
        value = max(0.1, min(2.0, float(sensitivity)))
        self.config["sensitivity"] = value
        self.config["dead_zone"] = max(0.001, 0.012 / value)
        self.config["confidence_threshold"] = max(0.5, min(0.99, 0.70 / value))
        self.confidence_threshold = float(self.config["confidence_threshold"])
        self.save_config()

    def set_thresholds(self, thresholds: Dict[str, Any]) -> None:
        current = self.config.get("thresholds") or {}
        if not isinstance(current, dict):
            current = {}
        current.update({k: v for k, v in (thresholds or {}).items() if v is not None})
        self.config["thresholds"] = current
        self.save_config()

    def set_mapping(self, gesture_name: str, mapping: Dict[str, Any]) -> None:
        per = self.config.get("per_gesture") or {}
        if not isinstance(per, dict):
            per = {}
        entry = dict(mapping or {})
        per[str(gesture_name)] = entry
        self.config["per_gesture"] = per
        self.save_config()

    def emergency_stop(self) -> Dict[str, Any]:
        self.emergency_stopped = True
        self.enabled = False
        self.paused = False
        self.state_machine.emergency_stop()
        self._debouncer.reset()
        _log.warning("Gesture emergency stop engaged.")
        return self.get_status()

    def _get_config_path(self) -> str:
        data_dir = os.environ.get('SARA_DATA_DIR') or os.getcwd()
        cfg_dir = os.path.join(data_dir, 'data')
        try:
            os.makedirs(cfg_dir, exist_ok=True)
        except Exception:
            pass
        return os.path.join(cfg_dir, 'gesture_config.json')

    def _load_config(self) -> Dict[str, Any]:
        try:
            cfg = GestureConfigStore.load(default_config_path())
            return cfg.to_dict()
        except Exception:
            return {
                "confidence_threshold": 0.70,
                "debounce_ms": 350,
                "cooldown_ms": 500,
                "min_confidence": 0.70,
                "frames_required": 3,
                "cooldown": 0.5,
                "per_gesture": {},
                "calibration": {},
                "mapping": {},
                "thresholds": GestureThresholds().__dict__,
                "sensitivity": 1.0,
                "monitor_index": 1,
                "camera_index": 0,
                "cursor_control": True,
            }

    def save_config(self) -> None:
        try:
            cfg = GestureConfigStore.from_dict(self.config)
            cfg.save(default_config_path())
        except Exception as exc:
            _log.error(f"Failed to save config: {exc}")

    def set_config(self, cfg: Dict[str, Any]) -> None:
        self.config.update(cfg or {})
        self.cooldown_seconds = float(self.config.get("cooldown_ms", self.config.get("cooldown", 500)) / 1000.0 if "cooldown_ms" in self.config else self.config.get("cooldown", 0.5))
        self.debounce_ms = float(self.config.get("debounce_ms", 350))
        self.confidence_threshold = float(self.config.get("confidence_threshold", 0.70))
        self._debouncer = GestureDebouncer(min_frames=int(self.config.get("frames_required", 3)), cooldown_s=self.cooldown_seconds)
        self.save_config()

    def get_config(self) -> Dict[str, Any]:
        return dict(self.config)

    def calibrate(self) -> Dict[str, Any]:
        """Return current calibration status/data. A real flow would capture points."""
        return self.config.get("calibration", {})

    def get_status(self) -> Dict[str, Any]:
        try:
            from .vision_engine import VISION_ENGINE
            vision_state = VISION_ENGINE.get_state()
            camera_available = bool(getattr(VISION_ENGINE, "available", False))
        except Exception:
            vision_state = {}
            camera_available = False
        snapshot = self.state_machine.as_dict()
        return {
            "enabled": self.enabled,
            "paused": self.paused,
            "state": snapshot.get("state", GestureState.DISABLED),
            "camera": "default" if self.config.get("camera_index", 0) == 0 else f"camera-{self.config.get('camera_index')}",
            "camera_available": camera_available,
            "camera_index": self.config.get("camera_index", 0),
            "monitor_index": self.config.get("monitor_index", 1),
            "hands_detected": vision_state.get("hands_detected", snapshot.get("hands_detected", 0)),
            "active_gesture": snapshot.get("active_gesture", ""),
            "confidence": snapshot.get("confidence", 0.0),
            "cursor_control": bool(self.config.get("cursor_control", True)),
            "dragging": bool(snapshot.get("dragging", False)),
            "emergency_stop": bool(self.emergency_stopped or snapshot.get("emergency_stop", False)),
            "thresholds": self.config.get("thresholds", {}),
            "confidence_threshold": self.confidence_threshold,
            "cooldown_ms": int(self.config.get("cooldown_ms", 500)),
            "debounce_ms": int(self.config.get("debounce_ms", 350)),
            "mapping_size": len(self.config.get("per_gesture", {}) or {}),
            "vision_state": vision_state,
        }

    def status(self) -> Dict[str, Any]:
        return self.get_status()

    def process_state(self, state: Dict[str, Any]) -> None:
        """Consume the VisionEngine state, detect high-level gestures and trigger actions."""
        if not self.enabled or self.paused or self.emergency_stopped:
            return

        gestures = state.get("gestures", [])
        now = time.time()
        min_conf = float(self.config.get("confidence_threshold", self.confidence_threshold))
        frames_req = int(self.config.get("frames_required", 3))
        hand_count = int(state.get("hands_detected", 0) or 0)
        self.state_machine.observe(hands_detected=hand_count, cursor_control=bool(self.config.get("cursor_control", True)))

        for g in gestures:
            name = g.get("name")
            confidence = float(g.get("confidence", 0))
            if not name:
                continue

            per_g = self.config.get('per_gesture', {}).get(name, {})
            g_min_conf = float(per_g.get('min_confidence', min_conf))
            g_frames_req = int(per_g.get('frames_required', frames_req))
            if confidence < g_min_conf:
                self._counters[name] = 0
                continue

            if not self._debouncer.allow(name, confidence, now, g_min_conf):
                self.state_machine.arm(name, confidence)
                continue

            last = self.last_executed.get(name, 0.0)
            cooldown_seconds = float(self.config.get("cooldown_ms", 500) / 1000.0 if "cooldown_ms" in self.config else self.config.get("cooldown", 0.5))
            debounce_seconds = float(self.config.get("debounce_ms", 350) / 1000.0)
            if now - max(last, 0) < max(cooldown_seconds, debounce_seconds):
                self.state_machine.cool_down()
                continue

            try:
                _log.info(f"Gesture detected: {name} | Confidence: {confidence:.2f}")
                from .gesture_mapper import GestureMapper
                kwargs = {}
                if "x_norm" in g and "y_norm" in g:
                    kwargs["x_norm"] = g["x_norm"]
                    kwargs["y_norm"] = g["y_norm"]
                self.state_machine.activate(name, confidence)
                mapping = self.config.get("per_gesture", {}).get(name, {}) or GestureMapper.DEFAULT_MAPPING.get(name, {})
                tool_name = str(mapping.get("tool", "") or "")
                if not self.safety.is_allowed(name, tool_name, mapping):
                    _log.warning("Gesture mapping blocked by safety policy: %s", name)
                    self.state_machine.cool_down()
                    continue
                GestureMapper.handle_gesture(name, confidence, self.profile, **kwargs)
                self.last_executed[name] = now
                self._counters[name] = 0
                try:
                    from .platform_core import MEMORY
                    MEMORY.remember(
                        "gesture_event",
                        name,
                        {"confidence": confidence, "profile": self.profile, "state": self.state_machine.as_dict()},
                    )
                except Exception:
                    pass
            except Exception as exc:
                _log.error(f"Error handling gesture {name}: {exc}")

        stale = []
        for k, ts in list(self._last_seen.items()):
            if now - ts > 1.0:
                stale.append(k)
        for key in stale:
            self._last_seen.pop(key, None)
            self._counters.pop(key, None)


# Singleton instance used by other modules
GESTURE_ENGINE = GestureEngine()
