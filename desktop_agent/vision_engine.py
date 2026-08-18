"""
SARA Vision Engine — Real-time hand tracking and gesture detection.

Architecture:
  - Uses MediaPipe Hands (legacy solutions API, compatible with 0.10.x)
  - Camera opened ONLY when enable() is explicitly called
  - Thread-safe camera open/close with proper join before release
  - EMA smoothing on per-hand centroids
  - Swipe detection via centroid trajectory buffer
  - Normalized coordinates forwarded through process_state to GestureEngine
  - Pause/resume without releasing camera
  - Reconnection logic after 5 consecutive read failures
  - All gestures logged to logs/gesture_control.log

Supported gestures:
  PINCH               — thumb tip near index tip (< 0.05 normalized distance)
  OPEN_PALM           — 3+ fingers extended + thumb extended
  CLOSED_FIST         — all 4 fingers folded
  INDEX_POINT         — only index extended, others folded
  THUMBS_UP           — thumb extended up, fist otherwise
  THUMBS_DOWN         — thumb extended down, fist otherwise
  V_SIGN              — index + middle extended, others folded
  TWO_FINGER_SCROLL_UP   — index + middle extended, moving upward
  TWO_FINGER_SCROLL_DOWN — index + middle extended, moving downward
  SWIPE_LEFT          — wrist centroid moving left > threshold
  SWIPE_RIGHT         — wrist centroid moving right > threshold
  SWIPE_UP            — wrist centroid moving up > threshold
  SWIPE_DOWN          — wrist centroid moving down > threshold
"""

from __future__ import annotations

import importlib
import logging
import math
import os
import pathlib
import threading
import time
import urllib.request
import uuid
from collections import deque
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def _get_logger() -> logging.Logger:
    logger = logging.getLogger("sara.gesture")
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
    sh.setFormatter(logging.Formatter("[VisionEngine] %(message)s"))
    sh.setLevel(logging.WARNING)
    logger.addHandler(sh)
    return logger

import logging.handlers
_log = _get_logger()

# Import the singleton instance of GestureEngine
from .gesture_engine import GESTURE_ENGINE
from .gesture.recognizer import recognize_gesture

# Make OpenCV/MediaPipe optional so the agent can run where they are unavailable.
try:
    import cv2  # type: ignore
except Exception:
    cv2 = None  # type: ignore

_MP_TASKS_VISION = None
_MP_IMAGE = None
_MP_IMAGE_FORMAT = None
_MP_RUNNING_MODE = None
_MP_BASE_OPTIONS = None
_MP_HAND_LANDMARKER = None
_MP_HAND_LANDMARKER_OPTIONS = None
_MP_CATEGORY = None

try:
    import mediapipe as mp  # type: ignore
    _HAS_MEDIAPIPE = hasattr(mp, "solutions")
    if not _HAS_MEDIAPIPE:
        try:
            _MP_TASKS_VISION = importlib.import_module("mediapipe.tasks.python.vision")
            _MP_IMAGE = importlib.import_module("mediapipe.tasks.python.vision.core.image")
            _MP_IMAGE_FORMAT = _MP_IMAGE.ImageFormat
            _MP_RUNNING_MODE = importlib.import_module(
                "mediapipe.tasks.python.vision.core.vision_task_running_mode"
            ).VisionTaskRunningMode
            _MP_BASE_OPTIONS = importlib.import_module(
                "mediapipe.tasks.python.core.base_options"
            ).BaseOptions
            _MP_HAND_LANDMARKER = importlib.import_module(
                "mediapipe.tasks.python.vision.hand_landmarker"
            )
            _MP_HAND_LANDMARKER_OPTIONS = _MP_HAND_LANDMARKER.HandLandmarkerOptions
            _MP_CATEGORY = importlib.import_module(
                "mediapipe.tasks.python.components.containers.category"
            ).Category
            _HAS_MEDIAPIPE = True
        except Exception:
            _HAS_MEDIAPIPE = False
except Exception:
    mp = None  # type: ignore
    _HAS_MEDIAPIPE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_EMA_ALPHA = 0.35          # Exponential moving average smoothing factor
_DEAD_ZONE = 0.008         # Normalized units — centroids must move more than this to register
_SWIPE_WINDOW = 0.5        # Seconds to accumulate trajectory for swipe detection
_SWIPE_MIN_DELTA = 0.12    # Minimum normalized displacement to count as a swipe
_SWIPE_RATIO = 2.2         # Primary axis must be N× larger than cross-axis
_MAX_FAIL_READS = 5        # Consecutive failed reads before reconnect attempt
_TARGET_FPS = 15           # Frames per second target
_FRAME_INTERVAL = 1.0 / _TARGET_FPS


class _HandState:
    """Per-hand tracking state across frames."""

    def __init__(self):
        self.cx_ema: Optional[float] = None   # EMA-smoothed centroid x (normalized [0,1])
        self.cy_ema: Optional[float] = None   # EMA-smoothed centroid y (normalized [0,1])
        self.trajectory: deque = deque()       # deque of (ts, cx, cy) for swipe detection
        self.last_gesture: str = ""
        self.gesture_start_time: float = 0.0
        self.two_finger_start_y: Optional[float] = None  # for scroll direction


class _LandmarkList:
    def __init__(self, landmark: List[Any]):
        self.landmark = landmark


class _ClassificationList:
    def __init__(self, classification: List[Any]):
        self.classification = classification


def _default_model_path() -> pathlib.Path:
    data_root = pathlib.Path(os.environ.get("SARA_DATA_DIR") or pathlib.Path.home() / ".sara")
    model_dir = data_root / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    return model_dir / "hand_landmarker.task"


def _ensure_hand_landmarker_model() -> Optional[str]:
    model_path = _default_model_path()
    if model_path.exists() and model_path.stat().st_size > 0:
        return str(model_path)

    url = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
    tmp_path = model_path.with_name(f"{model_path.stem}-{os.getpid()}-{uuid.uuid4().hex}.download")
    try:
        urllib.request.urlretrieve(url, tmp_path)
        if tmp_path.exists() and tmp_path.stat().st_size > 0:
            os.replace(tmp_path, model_path)
            return str(model_path)
        raise RuntimeError("downloaded model file is empty")
    except Exception as exc:
        _log.warning("Failed to download hand landmarker model: %s", exc)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
        return None


class VisionEngine:
    """
    Real-time hand tracking engine.

    State machine:
      UNAVAILABLE  — OpenCV or MediaPipe not installed
      IDLE         — available but camera not started
      STARTING     — enable() called, thread launching
      ACTIVE       — camera running, processing frames
      PAUSED       — camera running, processing skipped
      ERROR        — camera error
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.camera_enabled = False
        self.cap: Optional[Any] = None
        self.thread: Optional[threading.Thread] = None
        self.running = False
        self.paused = False
        self._consecutive_failures = 0

        self.state: Dict[str, Any] = {
            "status": "UNAVAILABLE" if (cv2 is None or not _HAS_MEDIAPIPE) else "IDLE",
            "hands_detected": 0,
            "gestures": [],
            "hands": [],
            "last_event_time": 0,
            "fps": 0,
            "latency_ms": 0,
            "camera_index": 0,
            "camera_available": bool(cv2 is not None and _HAS_MEDIAPIPE),
        }

        # Per-hand state keyed by hand index (0 = first hand, 1 = second)
        self._hand_states: Dict[int, _HandState] = {}

        if cv2 is None or not _HAS_MEDIAPIPE:
            _log.warning("OpenCV or MediaPipe not available; vision disabled.")
            self.available = False
            return

        self.available = True
        self._backend = "solutions" if hasattr(mp, "solutions") else "tasks"
        if self._backend == "solutions":
            self.mp_hands = mp.solutions.hands
            self.hands_detector = self.mp_hands.Hands(
                static_image_mode=False,
                max_num_hands=2,
                min_detection_confidence=0.7,
                min_tracking_confidence=0.5,
            )
        else:
            self.hands_detector = None
            self._model_path: Optional[str] = None
        self.state["status"] = "IDLE"
        _log.info("VisionEngine initialized (OpenCV + MediaPipe available)")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enable(self) -> None:
        """Enable the camera and start the processing loop."""
        if not getattr(self, "available", False):
            _log.warning("enable() called but MediaPipe/OpenCV not available")
            return
        if getattr(self, "_backend", "solutions") == "tasks" and self.hands_detector is None:
            model_path = _ensure_hand_landmarker_model()
            if not model_path:
                self.available = False
                self.state["status"] = "UNAVAILABLE"
                _log.warning("Hand landmarker model unavailable; vision disabled.")
                return
            options = _MP_HAND_LANDMARKER_OPTIONS(
                base_options=_MP_BASE_OPTIONS(model_asset_path=model_path),
                running_mode=_MP_RUNNING_MODE.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.7,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self.hands_detector = _MP_HAND_LANDMARKER.HandLandmarker.create_from_options(options)
            self._model_path = model_path
        with self._lock:
            if self.camera_enabled:
                return
            self.camera_enabled = True
            self.running = True
            self.paused = False
            self._consecutive_failures = 0
        self.state["status"] = "STARTING"
        _log.info("VisionEngine enabled — starting camera thread")
        self.thread = threading.Thread(
            target=self._process_loop, name="sara-vision", daemon=True
        )
        self.thread.start()

    def disable(self) -> None:
        """Stop gesture processing and release the camera."""
        _log.info("VisionEngine disable() called")
        with self._lock:
            self.camera_enabled = False
            self.running = False
        # Wait for thread to exit before releasing cap to avoid race
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3.0)
        with self._lock:
            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None
        detector = getattr(self, "hands_detector", None)
        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
        self.state["status"] = "IDLE"
        self.state["hands_detected"] = 0
        self.state["gestures"] = []
        self.state["hands"] = []
        self._hand_states.clear()
        _log.info("VisionEngine disabled — camera released")

    def pause(self) -> None:
        """Pause gesture processing (camera stays open)."""
        self.paused = True
        self.state["status"] = "PAUSED"
        _log.info("VisionEngine paused")

    def resume(self) -> None:
        """Resume gesture processing after pause."""
        self.paused = False
        if self.camera_enabled:
            self.state["status"] = "ACTIVE"
        _log.info("VisionEngine resumed")

    def get_state(self) -> Dict[str, Any]:
        return dict(self.state)

    def is_active(self) -> bool:
        return self.camera_enabled and self.running and not self.paused

    # ------------------------------------------------------------------
    # Internal: gesture detection
    # ------------------------------------------------------------------

    def _finger_extended(self, lm, tip_idx: int, pip_idx: int) -> bool:
        """True if finger tip is above PIP (finger is extended upward)."""
        return lm[tip_idx].y < lm[pip_idx].y

    def _detect_gesture(self, hand_landmarks, hand_state: _HandState) -> str:
        lm = hand_landmarks.landmark
        trajectory = list(hand_state.trajectory)[-8:]
        rec = recognize_gesture(lm, handedness="", trajectory=[(cx, cy) for _, cx, cy in trajectory])
        return rec.name

    def _detect_two_finger_scroll(self, hand_state: _HandState) -> Optional[str]:
        """Detect TWO_FINGER_SCROLL_UP/DOWN from trajectory of V_SIGN hand."""
        traj = hand_state.trajectory
        if len(traj) < 3:
            return None
        now = time.time()
        recent = [(t, cx, cy) for t, cx, cy in traj if now - t <= _SWIPE_WINDOW]
        if len(recent) < 3:
            return None
        dy = recent[-1][2] - recent[0][2]
        dx = abs(recent[-1][1] - recent[0][1])
        if abs(dy) < 0.06 or abs(dy) < dx * 1.5:
            return None
        return "TWO_FINGER_SCROLL_UP" if dy < 0 else "TWO_FINGER_SCROLL_DOWN"

    def _detect_swipe(self, hand_state: _HandState) -> Optional[str]:
        """Detect directional swipe from centroid trajectory."""
        traj = hand_state.trajectory
        if len(traj) < 4:
            return None
        now = time.time()
        recent = [(t, cx, cy) for t, cx, cy in traj if now - t <= _SWIPE_WINDOW]
        if len(recent) < 4:
            return None
        dx = recent[-1][1] - recent[0][1]
        dy = recent[-1][2] - recent[0][2]
        adx, ady = abs(dx), abs(dy)
        if max(adx, ady) < _SWIPE_MIN_DELTA:
            return None
        if adx > ady * _SWIPE_RATIO:
            return "SWIPE_RIGHT" if dx > 0 else "SWIPE_LEFT"
        if ady > adx * _SWIPE_RATIO:
            return "SWIPE_DOWN" if dy > 0 else "SWIPE_UP"
        return None

    # ------------------------------------------------------------------
    # Internal: centroid computation + EMA smoothing
    # ------------------------------------------------------------------

    def _compute_centroid(self, hand_landmarks) -> Tuple[float, float]:
        lm = getattr(hand_landmarks, "landmark", hand_landmarks)
        xs = [l.x for l in lm]
        ys = [l.y for l in lm]
        return sum(xs) / len(xs), sum(ys) / len(ys)

    def _smooth_centroid(
        self, hand_state: _HandState, raw_cx: float, raw_cy: float
    ) -> Tuple[float, float]:
        if hand_state.cx_ema is None:
            hand_state.cx_ema = raw_cx
            hand_state.cy_ema = raw_cy
        else:
            # Dead zone: if movement smaller than dead zone, keep previous position
            if (abs(raw_cx - hand_state.cx_ema) > _DEAD_ZONE or
                    abs(raw_cy - hand_state.cy_ema) > _DEAD_ZONE):
                hand_state.cx_ema = _EMA_ALPHA * raw_cx + (1 - _EMA_ALPHA) * hand_state.cx_ema
                hand_state.cy_ema = _EMA_ALPHA * raw_cy + (1 - _EMA_ALPHA) * hand_state.cy_ema
        return hand_state.cx_ema, hand_state.cy_ema

    # ------------------------------------------------------------------
    # Internal: processing loop
    # ------------------------------------------------------------------

    def _process_loop(self) -> None:
        if not getattr(self, "available", False):
            return
        if getattr(self, "_backend", "solutions") == "tasks" and self.hands_detector is None:
            _log.warning("Vision backend not initialized; processing loop exiting")
            self.state["status"] = "UNAVAILABLE"
            return

        cam_idx = GESTURE_ENGINE.config.get("camera_index", 0)
        _log.info(f"Opening camera index {cam_idx}")

        with self._lock:
            self.cap = cv2.VideoCapture(cam_idx)
        self.state["status"] = "ACTIVE"

        while self.running:
            start_time = time.time()

            # Check if camera is still valid
            with self._lock:
                cap = self.cap

            if cap is None or not cap.isOpened():
                _log.error("Camera not available; attempting reconnect")
                self._attempt_reconnect(cam_idx)
                time.sleep(1.0)
                continue

            success, image = cap.read()

            if not success or image is None:
                self._consecutive_failures += 1
                _log.warning(f"Camera read failed (consecutive: {self._consecutive_failures})")
                if self._consecutive_failures >= _MAX_FAIL_READS:
                    _log.error("Too many consecutive failures — reconnecting camera")
                    self._attempt_reconnect(cam_idx)
                self.state["status"] = "ERROR"
                time.sleep(0.2)
                continue

            self._consecutive_failures = 0
            self.state["status"] = "ACTIVE" if not self.paused else "PAUSED"

            if self.paused:
                # Keep camera warm but skip processing
                elapsed = time.time() - start_time
                time.sleep(max(0, _FRAME_INTERVAL - elapsed))
                continue

            # Reset hand list each frame (critical bug fix: was appending forever)
            self.state["hands"] = []
            self.state["gestures"] = []

            # Convert BGR→RGB + horizontal flip (selfie view)
            try:
                image = cv2.cvtColor(cv2.flip(image, 1), cv2.COLOR_BGR2RGB)
            except Exception:
                pass

            image.flags.writeable = False
            now = time.time()
            if getattr(self, "_backend", "solutions") == "solutions":
                results = self.hands_detector.process(image)
            else:
                mp_image = _MP_IMAGE.Image(image_format=_MP_IMAGE_FORMAT.SRGB, data=image)
                results = self.hands_detector.detect_for_video(mp_image, int(now * 1000))
                results = self._adapt_tasks_result(results)
            active_hand_indices = set()

            if getattr(results, "multi_hand_landmarks", None):
                n_hands = len(results.multi_hand_landmarks)
                self.state["hands_detected"] = n_hands

                for hand_idx, hand_landmarks in enumerate(results.multi_hand_landmarks):
                    active_hand_indices.add(hand_idx)

                    # Get or create per-hand state
                    if hand_idx not in self._hand_states:
                        self._hand_states[hand_idx] = _HandState()
                    hs = self._hand_states[hand_idx]

                    # Compute raw centroid (normalized [0,1])
                    raw_cx, raw_cy = self._compute_centroid(hand_landmarks)

                    # Apply EMA smoothing + dead zone
                    cx, cy = self._smooth_centroid(hs, raw_cx, raw_cy)

                    # Update trajectory buffer for swipe detection
                    hs.trajectory.append((now, cx, cy))
                    # Prune old trajectory entries
                    cutoff = now - _SWIPE_WINDOW * 2
                    while hs.trajectory and hs.trajectory[0][0] < cutoff:
                        hs.trajectory.popleft()

                    # Fix handedness bug: use per-hand index, not always [0]
                    handedness = None
                    try:
                        if results.multi_handedness and hand_idx < len(results.multi_handedness):
                            handedness = results.multi_handedness[hand_idx].classification[0].label
                    except Exception:
                        pass

                    self.state["hands"].append({
                        "centroid": {"x": cx, "y": cy},
                        "handedness": handedness,
                    })

                    gesture_rec = recognize_gesture(
                        hand_landmarks.landmark,
                        handedness=handedness or "",
                        trajectory=[(cx, cy) for _, cx, cy in list(hs.trajectory)[-8:]],
                    )
                    gesture = gesture_rec.name
                    gesture_confidence = gesture_rec.confidence

                    # If no static gesture, try swipe
                    if gesture == "UNKNOWN" or gesture == "OPEN_PALM":
                        swipe = self._detect_swipe(hs)
                        if swipe:
                            gesture = swipe
                            # Clear trajectory after swipe is detected to avoid repeat
                            hs.trajectory.clear()

                    if gesture != "UNKNOWN":
                        # Multi-frame hold confirmation (same gesture must persist)
                        if gesture == hs.last_gesture:
                            hold_duration = now - hs.gesture_start_time
                        else:
                            hs.last_gesture = gesture
                            hs.gesture_start_time = now
                            hold_duration = 0.0

                        # Require 0.3s hold (150ms at 15fps ≈ 2-3 frames)
                        if hold_duration >= 0.15 or gesture.startswith("SWIPE_") or gesture.startswith("TWO_FINGER"):
                            self.state["gestures"].append({
                                "name": gesture,
                                "confidence": round(float(gesture_confidence), 2),
                                "x_norm": cx,
                                "y_norm": cy,
                                "hand_idx": hand_idx,
                                "handedness": handedness,
                            })
                    else:
                        hs.last_gesture = ""

            else:
                self.state["hands_detected"] = 0
                # Clear trajectory for hands that disappeared
                for hs in self._hand_states.values():
                    hs.cx_ema = None
                    hs.cy_ema = None
                    hs.last_gesture = ""

            # Remove state for hands that are no longer tracked
            stale_hands = [i for i in self._hand_states if i not in active_hand_indices]
            for i in stale_hands:
                del self._hand_states[i]

            # Forward gestures + coordinates to GestureEngine
            if self.state["gestures"]:
                GESTURE_ENGINE.process_state(self.state)

            # FPS & latency
            latency = time.time() - start_time
            self.state["latency_ms"] = int(latency * 1000)
            self.state["fps"] = int(1.0 / latency) if latency > 0 else _TARGET_FPS
            self.state["last_event_time"] = now

            # Throttle to target FPS
            time.sleep(max(0, _FRAME_INTERVAL - latency))

        # Thread exiting cleanly
        _log.info("VisionEngine processing loop ended")

    def _attempt_reconnect(self, cam_idx: int) -> None:
        """Release and re-open the camera."""
        with self._lock:
            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None
        time.sleep(1.0)
        if self.running:
            with self._lock:
                try:
                    self.cap = cv2.VideoCapture(cam_idx)
                    _log.info(f"Camera reconnect attempt on index {cam_idx}")
                except Exception as e:
                    _log.error(f"Camera reconnect failed: {e}")
                    self.cap = None
            self._consecutive_failures = 0

    def _adapt_tasks_result(self, results: Any) -> Any:
        """Normalize MediaPipe Tasks results to the legacy structure used elsewhere."""
        multi_hand_landmarks = [
            _LandmarkList(list(landmarks))
            for landmarks in getattr(results, "hand_landmarks", []) or []
        ]
        multi_handedness = []
        for handedness in getattr(results, "handedness", []) or []:
            classifications = [
                SimpleNamespace(
                    label=getattr(item, "category_name", None) or getattr(item, "display_name", None) or "",
                    score=float(getattr(item, "score", 0.0) or 0.0),
                )
                for item in handedness
            ]
            multi_handedness.append(_ClassificationList(classifications))
        return SimpleNamespace(
            multi_hand_landmarks=multi_hand_landmarks,
            multi_handedness=multi_handedness,
        )


VISION_ENGINE = VisionEngine()
