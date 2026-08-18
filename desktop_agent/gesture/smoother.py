from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import DefaultDict, Dict, Optional, Tuple


@dataclass
class GestureSmoother:
    alpha: float = 0.35
    dead_zone: float = 0.008

    def __post_init__(self) -> None:
        self._state: Optional[Tuple[float, float]] = None

    def reset(self) -> None:
        self._state = None

    def update(self, x: float, y: float) -> Tuple[float, float]:
        if self._state is None:
            self._state = (x, y)
            return self._state
        px, py = self._state
        if abs(x - px) <= self.dead_zone and abs(y - py) <= self.dead_zone:
            return self._state
        nx = self.alpha * x + (1 - self.alpha) * px
        ny = self.alpha * y + (1 - self.alpha) * py
        self._state = (nx, ny)
        return self._state


class GestureDebouncer:
    def __init__(self, *, min_frames: int = 3, cooldown_s: float = 0.5) -> None:
        self.min_frames = max(1, int(min_frames))
        self.cooldown_s = max(0.0, float(cooldown_s))
        self._counts: DefaultDict[str, int] = defaultdict(int)
        self._last_seen: Dict[str, float] = {}
        self._last_fired: Dict[str, float] = {}

    def allow(self, gesture: str, confidence: float, now: float, min_confidence: float) -> bool:
        if confidence < min_confidence:
            self._counts[gesture] = 0
            return False
        self._counts[gesture] += 1
        self._last_seen[gesture] = now
        if self._counts[gesture] < self.min_frames:
            return False
        if now - self._last_fired.get(gesture, 0.0) < self.cooldown_s:
            return False
        self._last_fired[gesture] = now
        self._counts[gesture] = 0
        return True

    def reset(self, gesture: Optional[str] = None) -> None:
        if gesture is None:
            self._counts.clear()
            self._last_seen.clear()
            self._last_fired.clear()
            return
        self._counts.pop(gesture, None)
        self._last_seen.pop(gesture, None)
        self._last_fired.pop(gesture, None)
