from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

_log = logging.getLogger("sara.gesture.camera")

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    cv2 = None  # type: ignore


@dataclass
class CameraStatus:
    available: bool
    opened: bool
    index: int
    width: int = 0
    height: int = 0
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "opened": self.opened,
            "index": self.index,
            "width": self.width,
            "height": self.height,
            "error": self.error,
        }


class CameraManager:
    def __init__(self, index: int = 0) -> None:
        self.index = int(index)
        self.cap: Optional[Any] = None
        self.available = cv2 is not None
        self.error = ""

    def open(self, index: Optional[int] = None) -> CameraStatus:
        if index is not None:
            self.index = int(index)
        if cv2 is None:
            self.error = "OpenCV unavailable"
            return self.status()
        self.close()
        try:
            self.cap = cv2.VideoCapture(self.index)
            if not self.cap or not self.cap.isOpened():
                self.error = f"Camera {self.index} could not be opened"
                self.close()
                return self.status()
            self.error = ""
        except Exception as exc:  # pragma: no cover - hardware failure
            self.error = str(exc)
            self.close()
        return self.status()

    def read(self) -> tuple[bool, Any]:
        if not self.cap:
            return False, None
        try:
            return self.cap.read()
        except Exception as exc:  # pragma: no cover - hardware failure
            self.error = str(exc)
            return False, None

    def close(self) -> None:
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
        self.cap = None

    def reconnect(self) -> CameraStatus:
        self.close()
        return self.open(self.index)

    def status(self) -> CameraStatus:
        opened = bool(self.cap and getattr(self.cap, "isOpened", lambda: False)())
        width = height = 0
        if opened:
            try:
                width = int(self.cap.get(getattr(cv2, "CAP_PROP_FRAME_WIDTH", 3)) if cv2 else 0)
                height = int(self.cap.get(getattr(cv2, "CAP_PROP_FRAME_HEIGHT", 4)) if cv2 else 0)
            except Exception:
                width = height = 0
        return CameraStatus(available=self.available, opened=opened, index=self.index, width=width, height=height, error=self.error)
