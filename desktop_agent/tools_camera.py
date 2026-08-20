"""Camera automation tools for SARA.

The camera layer uses optional local dependencies when available:
- `cv2` for webcam capture and recording
- `pyzbar` or OpenCV QR detection for code scanning

When those libraries are missing, the tools still degrade gracefully by
opening the system camera app or returning a clear availability message.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .registry import ToolError, register

CAMERA_DIR = Path(os.path.expanduser("~")) / "Pictures" / "SaraCamera"


@dataclass
class CameraState:
    capture: Any = None
    writer: Any = None
    recording_path: Optional[Path] = None


STATE = CameraState()


def _open_camera_app() -> Dict[str, Any]:
    if os.name != "nt":
        raise ToolError("Opening the camera app is only supported on Windows in this build.")
    try:
        subprocess.Popen(["cmd", "/c", "start", "", "microsoft.windows.camera:"], close_fds=True)
        return {"result": "Opened the camera app."}
    except Exception:
        try:
            subprocess.Popen(["cmd", "/c", "start", "", "camera:"], close_fds=True)
            return {"result": "Opened the camera app."}
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Could not open the camera app: {exc}")


def _ensure_cv2():
    try:
        import cv2

        return cv2
    except Exception as exc:  # noqa: BLE001
        raise ToolError(
            "Camera capture unavailable: the optional 'opencv-python' package is not installed."
        ) from exc


def _ensure_camera(index: int = 0):
    cv2 = _ensure_cv2()
    if STATE.capture is not None:
        return cv2, STATE.capture
    capture = cv2.VideoCapture(index, cv2.CAP_DSHOW if os.name == "nt" else 0)
    if not capture.isOpened():
        raise ToolError("No camera could be opened.")
    STATE.capture = capture
    return cv2, capture


def _read_frame() -> Any:
    cv2, capture = _ensure_camera()
    ok, frame = capture.read()
    if not ok or frame is None:
        raise ToolError("Could not read a frame from the camera.")
    return cv2, frame


def _save_image(frame: Any, name: Optional[str] = None) -> Path:
    cv2 = _ensure_cv2()
    CAMERA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    filename = f"{name}-{stamp}.png" if name else f"camera-{stamp}.png"
    path = CAMERA_DIR / filename
    cv2.imwrite(str(path), frame)
    return path


def _start_recording(duration: Optional[int] = None, fps: int = 20) -> Dict[str, Any]:
    cv2, capture = _ensure_camera()
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    CAMERA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = CAMERA_DIR / f"recording-{stamp}.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(path), fourcc, fps, (width, height))
    if not writer.isOpened():
        raise ToolError("Could not start video recording.")
    STATE.writer = writer
    STATE.recording_path = path

    if duration and duration > 0:
        end = time.time() + duration
        while time.time() < end:
            ok, frame = capture.read()
            if not ok:
                break
            writer.write(frame)
        writer.release()
        STATE.writer = None
        recorded_path = STATE.recording_path
        STATE.recording_path = None
        return {"result": f"Recorded video to {recorded_path}.", "path": str(recorded_path)}

    return {"result": f"Recording started to {path}.", "path": str(path)}


def _stop_recording() -> Dict[str, Any]:
    if STATE.writer is None:
        return {"result": "No active camera recording was running."}
    STATE.writer.release()
    path = STATE.recording_path
    STATE.writer = None
    STATE.recording_path = None
    return {"result": f"Stopped recording. Saved to {path}.", "path": str(path) if path else None}


def _scan_qr(frame: Any) -> Dict[str, Any]:
    try:
        import cv2
    except Exception as exc:  # noqa: BLE001
        raise ToolError("QR scanning requires the optional 'opencv-python' package.") from exc

    detector = cv2.QRCodeDetector()
    value, points, _ = detector.detectAndDecode(frame)
    if value:
        return {"result": "Detected a QR code.", "text": value}

    try:
        from pyzbar.pyzbar import decode

        decoded = decode(frame)
        if decoded:
            payloads = [item.data.decode("utf-8", errors="ignore") for item in decoded]
            return {"result": "Detected a barcode or QR code.", "text": payloads[0], "all": payloads}
    except Exception:
        pass
    return {"result": "No QR code or barcode detected.", "text": ""}


@register("openCamera")
def open_camera(args: Dict[str, Any]) -> Dict[str, Any]:
    if args.get("capture_only"):
        _ensure_camera(int(args.get("index", 0)))
        return {"result": "Camera opened for capture."}
    return _open_camera_app()


@register("takePhoto")
def take_photo(args: Dict[str, Any]) -> Dict[str, Any]:
    cv2, frame = _read_frame()
    path = _save_image(frame, args.get("name"))
    return {"result": f"Captured photo to {path}.", "path": str(path)}


@register("recordVideo")
def record_video(args: Dict[str, Any]) -> Dict[str, Any]:
    duration = args.get("duration")
    duration_value = int(duration) if duration is not None and str(duration).strip() else None
    return _start_recording(duration_value, int(args.get("fps", 20)))


@register("stopVideoRecording")
def stop_video_recording(args: Dict[str, Any]) -> Dict[str, Any]:
    return _stop_recording()


@register("scanQrCode")
def scan_qr_code(args: Dict[str, Any]) -> Dict[str, Any]:
    cv2, frame = _read_frame()
    return _scan_qr(frame)


@register("saveCapturedPhoto")
def save_captured_photo(args: Dict[str, Any]) -> Dict[str, Any]:
    cv2, frame = _read_frame()
    path = _save_image(frame, args.get("name"))
    return {"result": f"Saved camera photo to {path}.", "path": str(path)}


@register("showCapturedMedia")
def show_captured_media(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": "Camera media is stored locally in Pictures/SaraCamera.",
        "path": str(CAMERA_DIR),
    }

