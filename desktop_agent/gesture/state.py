from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional


class GestureState:
    DISABLED = "DISABLED"
    IDLE = "IDLE"
    TRACKING = "TRACKING"
    ARMED = "ARMED"
    ACTIVE = "ACTIVE"
    DRAGGING = "DRAGGING"
    COOLDOWN = "COOLDOWN"
    PAUSED = "PAUSED"
    EMERGENCY_STOP = "EMERGENCY_STOP"


@dataclass
class GestureStateSnapshot:
    state: str = GestureState.DISABLED
    active_gesture: str = ""
    confidence: float = 0.0
    hands_detected: int = 0
    cursor_control: bool = True
    dragging: bool = False
    emergency_stop: bool = False
    last_transition: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class GestureStateMachine:
    def __init__(self) -> None:
        self.snapshot = GestureStateSnapshot()

    @property
    def state(self) -> str:
        return self.snapshot.state

    def enable(self) -> None:
        self.snapshot.state = GestureState.IDLE
        self.snapshot.emergency_stop = False
        self.snapshot.dragging = False
        self.snapshot.active_gesture = ""
        self.snapshot.confidence = 0.0

    def disable(self) -> None:
        self.snapshot.state = GestureState.DISABLED
        self.snapshot.dragging = False
        self.snapshot.active_gesture = ""
        self.snapshot.confidence = 0.0
        self.snapshot.emergency_stop = False

    def pause(self) -> None:
        if self.snapshot.state != GestureState.DISABLED:
            self.snapshot.state = GestureState.PAUSED

    def resume(self) -> None:
        if self.snapshot.state == GestureState.PAUSED:
            self.snapshot.state = GestureState.IDLE

    def emergency_stop(self) -> None:
        self.snapshot.state = GestureState.EMERGENCY_STOP
        self.snapshot.dragging = False
        self.snapshot.active_gesture = ""
        self.snapshot.confidence = 0.0
        self.snapshot.emergency_stop = True

    def clear_emergency_stop(self) -> None:
        self.snapshot.emergency_stop = False
        if self.snapshot.state == GestureState.EMERGENCY_STOP:
            self.snapshot.state = GestureState.IDLE

    def observe(self, *, hands_detected: int = 0, active_gesture: str = "", confidence: float = 0.0, cursor_control: bool = True, dragging: Optional[bool] = None) -> None:
        self.snapshot.hands_detected = int(hands_detected)
        self.snapshot.cursor_control = bool(cursor_control)
        if dragging is not None:
            self.snapshot.dragging = bool(dragging)
        if self.snapshot.state in {GestureState.DISABLED, GestureState.PAUSED, GestureState.EMERGENCY_STOP}:
            return
        if self.snapshot.hands_detected <= 0 and not self.snapshot.dragging:
            self.snapshot.state = GestureState.IDLE
        elif self.snapshot.dragging:
            self.snapshot.state = GestureState.DRAGGING
        else:
            self.snapshot.state = GestureState.TRACKING if active_gesture == "" else GestureState.ARMED
        if active_gesture:
            self.snapshot.active_gesture = active_gesture
            self.snapshot.confidence = float(confidence)

    def arm(self, gesture: str, confidence: float) -> None:
        self.snapshot.state = GestureState.ARMED
        self.snapshot.active_gesture = gesture
        self.snapshot.confidence = float(confidence)

    def activate(self, gesture: str, confidence: float) -> None:
        self.snapshot.state = GestureState.ACTIVE
        self.snapshot.active_gesture = gesture
        self.snapshot.confidence = float(confidence)

    def begin_drag(self, gesture: str, confidence: float) -> None:
        self.snapshot.state = GestureState.DRAGGING
        self.snapshot.dragging = True
        self.snapshot.active_gesture = gesture
        self.snapshot.confidence = float(confidence)

    def end_drag(self) -> None:
        self.snapshot.dragging = False
        if self.snapshot.state == GestureState.DRAGGING:
            self.snapshot.state = GestureState.IDLE

    def cool_down(self) -> None:
        if self.snapshot.state not in {GestureState.DISABLED, GestureState.EMERGENCY_STOP}:
            self.snapshot.state = GestureState.COOLDOWN

    def as_dict(self) -> Dict[str, Any]:
        return self.snapshot.to_dict()
