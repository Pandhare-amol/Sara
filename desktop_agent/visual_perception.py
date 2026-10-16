"""On-demand Windows perception. Images stay in memory; only structured, untrusted observations leave this module.

UIA discovery is optional (pywinauto on Windows); OCR uses the existing
Pillow/Tesseract adapter. An OCR word is text, NOT a verified button. No model
prediction is treated as a control or as authorization.
"""

from __future__ import annotations

import hashlib
import platform
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .registry import ToolError
from .visual_access import VISUAL_ACCESS

_MAX_ELEMENTS = 120
_SENSITIVE = re.compile(r"\b(password|passphrase|secret|api[_ -]?key|bearer|one[ -]?time[ -]?passcode|verification code)\b|\b\d{13,19}\b", re.I)
_SUSPICIOUS_TITLE = re.compile(r"\b(not responding|permission|access denied|error|failed)\b", re.I)
_CONTROL_TYPES = {
    "button": "button", "menuitem": "menu", "menu": "menu", "edit": "field",
    "combobox": "field", "listitem": "option", "checkbox": "checkbox", "hyperlink": "link",
    "tabitem": "tab", "image": "icon", "text": "text", "window": "dialog",
    "progressbar": "loading", "pane": "panel",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _label(value: Any) -> str:
    text = " ".join(str(value or "").strip().split())[:160]
    return "[redacted]" if _SENSITIVE.search(text) else text


def _bounds(left: Any, top: Any, width: Any, height: Any) -> Optional[Dict[str, int]]:
    try:
        values = (int(left), int(top), int(width), int(height))
    except (TypeError, ValueError):
        return None
    if not 0 < values[2] <= 16384 or not 0 < values[3] <= 16384:
        return None
    return dict(zip(("x", "y", "width", "height"), values))


def ocr_elements(data: Any, origin: tuple[int, int], timestamp: str) -> list[Dict[str, Any]]:
    """Convert Tesseract's column-oriented dictionary to physical screen boxes."""
    if not isinstance(data, dict) or not isinstance(data.get("text"), list):
        raise ToolError("OCR did not return structured text rows.")
    output: list[Dict[str, Any]] = []
    for index, word in enumerate(data["text"][:300]):
        label = _label(word)
        if not label or label == "[redacted]":
            continue
        try:
            confidence = float(data["conf"][index])
            bounds = _bounds(origin[0] + int(data["left"][index]), origin[1] + int(data["top"][index]),
                             data["width"][index], data["height"][index])
        except (ValueError, TypeError, KeyError, IndexError):
            continue
        if confidence < 30 or confidence > 100 or bounds is None:
            continue
        output.append({"type": "text", "label": label, "bounds": bounds,
                       "confidence": round(confidence / 100, 2), "source": "ocr", "timestamp": timestamp})
        if len(output) >= _MAX_ELEMENTS:
            break
    return output


def uia_elements(hwnd: int, timestamp: str) -> tuple[list[Dict[str, Any]], list[Any], bool]:
    """Read only accessible names/bounds; never read field values or passwords."""
    if platform.system() != "Windows":
        return [], [], False
    try:
        from pywinauto import Desktop
        root = Desktop(backend="uia").window(handle=hwnd)
        wrappers = root.descendants(depth=4)[:_MAX_ELEMENTS]
    except (ImportError, OSError):
        return [], [], False
    except Exception:  # noqa: BLE001
        return [], [], False
    elements: list[Dict[str, Any]] = []
    accepted: list[Any] = []
    for wrapper in wrappers:
        try:
            info = wrapper.element_info
            kind = _CONTROL_TYPES.get(str(info.control_type or "").replace(" ", "").lower())
            if kind is None or bool(getattr(info.element, "CurrentIsPassword", False)):
                continue
            rect = info.rectangle
            bounds = _bounds(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
            if bounds is None or not wrapper.is_visible():
                continue
            # Accessible names for edit/document fields can contain private
            # user-entered values; omit them, not just the OCR pixels.
            label = "" if kind == "field" else _label(info.name)
            if label == "[redacted]":
                continue
            elements.append({"type": kind, "label": label, "bounds": bounds,
                             "confidence": 1.0, "source": "uia", "timestamp": timestamp,
                             "enabled": bool(wrapper.is_enabled()),
                             "automation_id": str(info.automation_id or "")[:80]})
            accepted.append(wrapper)
        except Exception:  # noqa: BLE001
            continue
    return elements, accepted, True


def match_target(observation: Dict[str, Any], label: str, *, actionable: bool = True) -> Dict[str, Any]:
    """Exact, unique, accessible controls only for actions; OCR is never a button."""
    needle = " ".join(str(label or "").casefold().split())
    if not needle or len(needle) > 120 or _SENSITIVE.search(needle):
        raise ToolError("Provide an exact, non-sensitive control label.")
    elements = observation.get("elements") or []
    roles = {"button", "menu", "tab", "checkbox", "link", "option"}
    matches = [item for item in elements
               if isinstance(item, dict) and " ".join(str(item.get("label") or "").casefold().split()) == needle
               and (not actionable or item.get("source") == "uia" and item.get("type") in roles
                    and item.get("enabled") is True and item.get("confidence") == 1.0)]
    if len(matches) != 1:
        raise ToolError("Target is missing, inaccessible, low-confidence or ambiguous; no input was sent.")
    return matches[0]


class VisualPerception:
    def __init__(self, min_interval: float = 0.25, max_cache_age: float = 1.5) -> None:
        self.min_interval = max(0.1, min(min_interval, 2.0))
        self.max_cache_age = max(0.25, min(max_cache_age, 2.0))
        self._semaphore = threading.BoundedSemaphore(1)
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_time = 0.0
        self._cache_generation = -1

    @staticmethod
    def _active_window() -> Dict[str, Any]:
        from .tools_screenshot import _active_window_info
        return _active_window_info() or {}

    @staticmethod
    def _capture(rect: tuple[int, int, int, int]):
        from .tools_screenshot import _capture_region
        x, y, width, height = rect
        return _capture_region((x, y, x + width, y + height))

    @staticmethod
    def _ocr(image):
        from .tools_screenshot import _ocr_data
        return _ocr_data(image)

    def observe(self, task_id: str = "", *, force: bool = False) -> Dict[str, Any]:
        if platform.system() != "Windows":
            raise ToolError("Native visual perception requires an interactive Windows desktop.")
        if not self._semaphore.acquire(timeout=0.1):
            raise ToolError("Visual worker is busy; try again after the current observation.")
        try:
            window = self._active_window()
            grant, rect = VISUAL_ACCESS.select(window)
            if window.get("minimized") or _SUSPICIOUS_TITLE.search(str(window.get("title") or "")):
                raise ToolError("The active window is blocked, not responding or displaying an unexpected prompt.")
            now = time.monotonic()
            if (self._cache is not None and not force and self._cache_generation == grant.generation and
                    now - self._cache_time < min(self.min_interval, self.max_cache_age) and
                    self._cache.get("window", {}).get("hwnd") == window.get("hwnd") and
                    self._cache.get("capture_bounds") == dict(zip(("x", "y", "width", "height"), rect))):
                VISUAL_ACCESS.unchanged(grant)
                return {**self._cache, "cached": True}

            image = self._capture(rect)
            if image.width != rect[2] or image.height != rect[3]:
                raise ToolError("Capture dimensions and the selected window/display disagree; input disabled.")
            # Small perceptual fingerprint, not a proof that the intended action
            # succeeded. Verify postconditions with a *fresh* semantic read.
            thumb = image.convert("L").resize((32, 32))
            fingerprint = hashlib.blake2b(thumb.tobytes(), digest_size=12).hexdigest()
            same = (self._cache is not None and self._cache_generation == grant.generation and
                    self._cache.get("window", {}).get("hwnd") == window.get("hwnd") and
                    self._cache.get("fingerprint") == fingerprint and
                    now - self._cache_time <= self.max_cache_age)
            timestamp = _now()
            if same and not force:
                elements = self._cache.get("elements", [])
                uia_available = self._cache.get("uia_available", False)
                ocr_available = self._cache.get("ocr_available", False)
            else:
                elements, _, uia_available = uia_elements(int(window["hwnd"]), timestamp)
                try:
                    elements += ocr_elements(self._ocr(image), (rect[0], rect[1]), timestamp)
                    ocr_available = True
                except ToolError:
                    ocr_available = False
            current = self._active_window()
            VISUAL_ACCESS.unchanged(grant)
            if current.get("hwnd") != window.get("hwnd") or current.get("process_name") != window.get("process_name"):
                raise ToolError("Active window changed during capture; discard the observation.")
            observation = {
                "task_id": str(task_id or "")[:90], "observed_at": timestamp,
                "window": {"hwnd": window.get("hwnd"), "title": _label(window.get("title")),
                           "process_name": window.get("process_name"), "bounds": window.get("bounds")},
                "capture_bounds": dict(zip(("x", "y", "width", "height"), rect)),
                "display": grant.display if grant.scope == "display" else None,
                "fingerprint": fingerprint, "changed": not same, "cached": False,
                "elements": elements[:_MAX_ELEMENTS], "uia_available": uia_available,
                "ocr_available": ocr_available, "verified": False,
            }
            self._cache, self._cache_time, self._cache_generation = observation, now, grant.generation
            return observation
        finally:
            self._semaphore.release()


VISUAL_PERCEPTION = VisualPerception()
