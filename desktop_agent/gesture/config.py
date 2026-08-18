from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Dict


def default_config_path() -> Path:
    data_dir = Path(os.environ.get("SARA_DATA_DIR") or os.getcwd()) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "gesture_config.json"


@dataclass
class GestureThresholds:
    cursor_movement: float = 0.65
    scroll: float = 0.75
    click: float = 0.90
    drag: float = 0.90
    window_control: float = 0.95
    confirmation: float = 0.95


@dataclass
class GestureConfigStore:
    enabled: bool = False
    camera_index: int = 0
    monitor_index: int = 1
    cursor_control: bool = True
    camera_name: str = "default"
    camera_available: bool = False
    fps: int = 20
    sensitivity: float = 1.0
    dead_zone: float = 0.008
    smoothing_alpha: float = 0.35
    confidence_threshold: float = 0.70
    frames_required: int = 3
    cooldown_ms: int = 500
    debounce_ms: int = 350
    thresholds: GestureThresholds = field(default_factory=GestureThresholds)
    mapping: Dict[str, Any] = field(default_factory=dict)
    calibration: Dict[str, Any] = field(default_factory=dict)
    browser_mode: str = "REAL_USER_BROWSER"
    active_monitor: int = 1
    gesture_mode: str = "IDLE"

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["thresholds"] = asdict(self.thresholds)
        return payload

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "GestureConfigStore":
        payload = dict(payload or {})
        thresholds = payload.get("thresholds") or {}
        if not isinstance(thresholds, dict):
            thresholds = {}
        payload["thresholds"] = GestureThresholds(**{**asdict(GestureThresholds()), **thresholds})
        mapping = payload.get("mapping") or {}
        if not isinstance(mapping, dict):
            mapping = {}
        payload["mapping"] = mapping
        calibration = payload.get("calibration") or {}
        if not isinstance(calibration, dict):
            calibration = {}
        payload["calibration"] = calibration
        return cls(**{k: v for k, v in payload.items() if k in cls.__dataclass_fields__})

    def save(self, path: Path | None = None) -> Dict[str, Any]:
        path = path or default_config_path()
        path.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return {"path": str(path), "saved": True}

    @classmethod
    def load(cls, path: Path | None = None) -> "GestureConfigStore":
        path = path or default_config_path()
        if not path.exists():
            return cls()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return cls()
        return cls.from_dict(payload)
