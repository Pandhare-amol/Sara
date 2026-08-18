from __future__ import annotations

import math
from dataclasses import dataclass, asdict, field
from typing import Any, Dict, Iterable, List, Optional, Sequence


@dataclass
class HandObservation:
    x: float
    y: float
    z: float = 0.0

    @classmethod
    def from_any(cls, item: Any) -> "HandObservation":
        return cls(float(getattr(item, "x", item[0] if isinstance(item, (list, tuple)) else 0.0)), float(getattr(item, "y", item[1] if isinstance(item, (list, tuple)) else 0.0)), float(getattr(item, "z", item[2] if isinstance(item, (list, tuple)) and len(item) > 2 else 0.0)))


@dataclass
class GestureRecognition:
    name: str
    confidence: float
    source: str = "ACCESSIBILITY"
    handedness: str = ""
    features: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _finger_extended(lm: Sequence[HandObservation], tip: int, pip: int) -> bool:
    return lm[tip].y < lm[pip].y


def _thumb_up(lm: Sequence[HandObservation]) -> bool:
    return lm[4].y < lm[3].y


def _thumb_down(lm: Sequence[HandObservation]) -> bool:
    return lm[4].y > lm[0].y + 0.05


def _trajectory_gesture(trajectory: Optional[Sequence[Sequence[float]]]) -> Optional[tuple[str, float]]:
    if not trajectory or len(trajectory) < 4:
        return None
    start = trajectory[0]
    end = trajectory[-1]
    dx = float(end[0]) - float(start[0])
    dy = float(end[1]) - float(start[1])
    adx, ady = abs(dx), abs(dy)
    if max(adx, ady) < 0.12:
        return None
    if adx > ady * 2.2:
        return ("SWIPE_RIGHT" if dx > 0 else "SWIPE_LEFT", min(0.99, 0.75 + adx))
    if ady > adx * 2.2:
        return ("SWIPE_DOWN" if dy > 0 else "SWIPE_UP", min(0.99, 0.75 + ady))
    return None


def recognize_gesture(
    landmarks: Iterable[Any],
    *,
    handedness: str = "",
    trajectory: Optional[Sequence[Sequence[float]]] = None,
) -> GestureRecognition:
    lm = [HandObservation.from_any(item) for item in landmarks]
    if len(lm) < 21:
        return GestureRecognition("UNKNOWN", 0.0, source="UNKNOWN", handedness=handedness, features={"reason": "insufficient_landmarks"})

    swipe = _trajectory_gesture(trajectory)
    if swipe:
        return GestureRecognition(swipe[0], swipe[1], source="LANDMARKS", handedness=handedness, features={"trajectory": list(trajectory or [])})

    index_ext = _finger_extended(lm, 8, 6)
    middle_ext = _finger_extended(lm, 12, 10)
    ring_ext = _finger_extended(lm, 16, 14)
    pinky_ext = _finger_extended(lm, 20, 18)
    thumb_up = _thumb_up(lm)
    thumb_down = _thumb_down(lm)

    thumb_tip = lm[4]
    index_tip = lm[8]
    dist = math.sqrt((thumb_tip.x - index_tip.x) ** 2 + (thumb_tip.y - index_tip.y) ** 2 + (thumb_tip.z - index_tip.z) ** 2)
    if dist < 0.05:
        confidence = max(0.80, 1.0 - dist * 6.0)
        return GestureRecognition("PINCH", min(0.99, confidence), source="LANDMARKS", handedness=handedness, features={"distance": dist})

    if index_ext and middle_ext and not ring_ext and not pinky_ext:
        return GestureRecognition("V_SIGN", 0.88, source="LANDMARKS", handedness=handedness, features={"index_ext": True, "middle_ext": True})

    if index_ext and not middle_ext and not ring_ext and not pinky_ext:
        return GestureRecognition("INDEX_POINT", 0.92, source="LANDMARKS", handedness=handedness, features={"index_ext": True})

    finger_count = sum([index_ext, middle_ext, ring_ext, pinky_ext])
    if finger_count >= 3:
        return GestureRecognition("OPEN_PALM", 0.90 if finger_count == 4 else 0.82, source="LANDMARKS", handedness=handedness, features={"finger_count": finger_count})

    if finger_count == 0:
        if thumb_up and not thumb_down:
            return GestureRecognition("THUMBS_UP", 0.86, source="LANDMARKS", handedness=handedness, features={"thumb_up": True})
        if thumb_down and not thumb_up:
            return GestureRecognition("THUMBS_DOWN", 0.86, source="LANDMARKS", handedness=handedness, features={"thumb_down": True})
        return GestureRecognition("CLOSED_FIST", 0.95, source="LANDMARKS", handedness=handedness, features={"finger_count": 0})

    return GestureRecognition("UNKNOWN", 0.35, source="LANDMARKS", handedness=handedness, features={"finger_count": finger_count})
