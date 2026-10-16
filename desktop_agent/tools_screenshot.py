"""
Screenshot & screen-reading: capture, save, OCR, and read on-screen text.

  takeScreenshot    -> capture full screen, return metadata (+ small base64)
  saveScreenshot    -> capture & write to a file under the Screenshots folder
  analyzeScreenshot-> capture, run OCR (pytesseract), return extracted text
  readScreen        -> OCR the active window region + name the active window

OCR requires the Tesseract OCR engine + the pytesseract wrapper. If either is
missing, the OCR tools return a graceful 'unavailable' message instead of
crashing; non-OCR capture still works.
"""

from __future__ import annotations

import base64
import io
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from .registry import ToolError, register
from .visual_access import VISUAL_ACCESS

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "SaraScreenshots"


def _capture() -> "Any":
    """Legacy name retained: only the explicitly approved source is captured."""
    return _authorized_capture()[0]


def _capture_region(bbox):
    try:
        from PIL import ImageGrab

        # Bounding boxes use virtual-desktop coordinates (negative on a
        # secondary display to the left); do not reinterpret them as primary.
        return ImageGrab.grab(bbox=bbox, all_screens=True)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Region capture failed: {e}")


def _active_window_bbox():
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        return rect
    except Exception:
        return None


def _active_window_title() -> str:
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        return win32gui.GetWindowText(hwnd) if hwnd else ""
    except Exception:
        return ""


def _active_window_info() -> Optional[Dict[str, Any]]:
    """Read native process/window identity before OCR or input, not a tab title."""
    from .window_manager import WINDOW_MANAGER
    try:
        return WINDOW_MANAGER.active_window()
    except ToolError:
        return None


def _authorized_capture(*, save: bool = False):
    """Validate scope before AND after capture; never fall back to all screens."""
    import platform
    if platform.system() != "Windows":
        raise ToolError("Desktop capture requires an interactive Windows session.")
    window = _active_window_info()
    grant, (x, y, width, height) = VISUAL_ACCESS.select(window, save=save)
    image = _capture_region((x, y, x + width, y + height))
    VISUAL_ACCESS.unchanged(grant)
    current = _active_window_info()
    if not isinstance(current, dict) or current.get("hwnd") != window.get("hwnd") or current.get("process_name") != window.get("process_name"):
        raise ToolError("Foreground window changed while capturing; discard the frame.")
    if image.width != width or image.height != height:
        raise ToolError("Selected capture dimensions changed unexpectedly.")
    return image, window, (x, y)


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_size_kb(img) -> int:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return len(buf.getvalue()) // 1024


def _run_ocr(img) -> str:
    try:
        import pytesseract
    except ImportError:
        raise ToolError(
            "OCR unavailable: the 'pytesseract' package is not installed."
        )
    # Ensure the Tesseract binary is discoverable.
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
    try:
        return pytesseract.image_to_string(img)
    except Exception as e:  # noqa: BLE001
        raise ToolError(
            "OCR failed (is the Tesseract engine installed?). Detail: " + str(e)
        )


def _find_tesseract_exe() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def _trim_ocr(text: str, max_chars: int = 1500) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = out[:max_chars] + "â€¦"
    return out


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    grant = VISUAL_ACCESS.require()
    img = _capture()
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Captured screen ({img.width}x{img.height}).",
        "screenshot_id": f"screen-{uuid.uuid4().hex}",
        "observed_at": time.time(),
        "width": img.width,
        "height": img.height,
        "observation": {"width": img.width, "height": img.height},
    }
    if include_image:
        # Downscale + JPEG to keep payload small for the WS bridge.
        max_dim = int(args.get("max_dim", 1280))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=60)
        result["image_mime"] = "image/jpeg"
    VISUAL_ACCESS.unchanged(grant)
    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    grant = VISUAL_ACCESS.require(save=True)
    img, _, _ = _authorized_capture(save=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    # Never allow a caller-controlled name to escape the screenshots folder.
    import re
    name = re.sub(r"[^a-zA-Z0-9_-]", "-", str(args.get("name") or ""))[:60].strip("-")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    out_path = SCREENSHOTS_DIR / fname
    VISUAL_ACCESS.unchanged(grant)
    img.save(out_path, format="PNG")
    return {"result": f"Saved screenshot to {out_path}.", "path": str(out_path)}


@register("analyzeScreenshot")
def analyze_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    grant = VISUAL_ACCESS.require()
    img = _capture()
    try:
        text = _run_ocr(img)
    except ToolError as e:
        VISUAL_ACCESS.unchanged(grant)
        return {"result": f"Screenshot captured, but OCR unavailable: {e.message}"}
    VISUAL_ACCESS.unchanged(grant)
    return {
        "result": "Screenshot analyzed via OCR.",
        "text": _trim_ocr(text, int(args.get("max_chars", 1500))),
    }


@register("readScreen")
def read_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """OCR only the approved active source; no fallback to all screens."""
    grant = VISUAL_ACCESS.require()
    img, window, _ = _authorized_capture()
    title = str(window.get("title") or "")
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500))) or "(no readable text)"
    except ToolError as e:
        VISUAL_ACCESS.unchanged(grant)
        return {
            "result": f"Active window: {title or 'unknown'}. OCR unavailable: {e.message}",
            "active_window": title,
        }
    VISUAL_ACCESS.unchanged(grant)
    return {
        "result": f"Active window '{title or 'unknown'}' contains readable text.",
        "active_window": title,
        "text": visible,
    }


@register("detectUiElements")
def detect_ui_elements(args: Dict[str, Any]) -> Dict[str, Any]:
    grant = VISUAL_ACCESS.require()
    # OCR only the approved native window/display. Never
    # interpret another app's labels as controls in the intended application.
    img, window, (left, top) = _authorized_capture()
    try:
        data = _ocr_data(img)
    except ToolError as error:
        VISUAL_ACCESS.unchanged(grant)
        return {"result": f"UI detection unavailable: {error.message}", "elements": [], "active_window": window}
    if not isinstance(data, dict) or not isinstance(data.get("text"), list):
        raise ToolError("OCR returned invalid UI detection data.")
    elements = []
    # pytesseract.Output.DICT is a dict OF COLUMNS, not an iterable of row
    # objects. Iterate by index so labels receive their own bounds/confidence.
    for index, raw_text in enumerate(data["text"][:300]):
        text = str(raw_text or "").strip()
        if not text:
            continue
        try:
            confidence = float(data["conf"][index])
            x = left + int(data["left"][index])
            y = top + int(data["top"][index])
            width = int(data["width"][index])
            height = int(data["height"][index])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if confidence < 30 or width <= 0 or height <= 0:
            continue
        elements.append({"text": text, "confidence": confidence,
                         "bbox": {"left": x, "top": y, "width": width, "height": height},
                         "center": {"x": x + width // 2, "y": y + height // 2}})
    VISUAL_ACCESS.unchanged(grant)
    return {"result": f"Detected {len(elements)} visible UI text elements.",
            "elements": elements[:100], "active_window": window, "observed_at": time.time()}


def _ocr_data(img):
    try:
        import pytesseract
    except ImportError as exc:
        raise ToolError("OCR unavailable: the 'pytesseract' package is not installed.") from exc
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
    try:
        return pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    except Exception as e:  # noqa: BLE001
        raise ToolError("UI detection failed: " + str(e))


__all__ = [
    "take_screenshot",
    "save_screenshot",
    "analyze_screenshot",
    "read_screen",
    "detect_ui_elements",
]

