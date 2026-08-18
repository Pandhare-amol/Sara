"""Reusable gesture-control primitives for SARA Desktop Agent."""

from .camera import CameraManager
from .config import GestureConfigStore, GestureThresholds, default_config_path
from .recognizer import GestureRecognition, HandObservation, recognize_gesture
from .safety import GestureSafetyManager
from .smoother import GestureDebouncer, GestureSmoother
from .state import GestureState, GestureStateMachine

__all__ = [
    "CameraManager",
    "GestureConfigStore",
    "GestureThresholds",
    "default_config_path",
    "GestureRecognition",
    "HandObservation",
    "recognize_gesture",
    "GestureSafetyManager",
    "GestureDebouncer",
    "GestureSmoother",
    "GestureState",
    "GestureStateMachine",
]
