"""Confidence-gated target resolution over the existing OCR and input tools."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Optional

from .desktop_input_controller import DESKTOP_INPUT
from .registry import TOOLS, ToolError, register
from .tools_screenshot import _active_window_info
from .visual_access import VISUAL_ACCESS

_APP_PROCESSES = {"word": "winword", "microsoft word": "winword", "excel": "excel",
                  "microsoft excel": "excel", "powerpoint": "powerpnt", "microsoft powerpoint": "powerpnt",
                  "notepad": "notepad"}


def _matches_application(window: Dict[str, Any], application: str) -> bool:
    process = str(window.get("process_name") or "").strip().lower().removesuffix(".exe")
    expected = _APP_PROCESSES.get(_normalize(application), _normalize(application).removesuffix(".exe"))
    return bool(process and expected and process == expected)


def _normalize(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _resolve(text: str, min_confidence: float = 70.0, application: str = "", window_title: str = "") -> Dict[str, Any]:
    query = _normalize(text)
    if not query:
        raise ToolError("Parameter 'text' or 'target' is required.")
    detector = TOOLS.get("detectUiElements")
    if detector is None:
        raise ToolError("UI detection handler is unavailable.")
    detected = detector({})
    observed = detected.get("active_window") if isinstance(detected, dict) else None
    if application and (not isinstance(observed, dict) or not _matches_application(observed, application)):
        raise ToolError(f"The intended application '{application}' is not the active native window.")
    if window_title and (not isinstance(observed, dict) or _normalize(window_title) not in _normalize(observed.get("title"))):
        raise ToolError(f"The intended document window '{window_title}' is not active.")
    elements = detected.get("elements", []) if isinstance(detected, dict) else []
    candidates = []
    for element in elements:
        label = _normalize(element.get("text")) if isinstance(element, dict) else ""
        confidence = float(element.get("confidence", 0)) if isinstance(element, dict) else 0
        if label and query in label and confidence >= min_confidence:
            candidates.append((label == query, confidence, element))
    if not candidates:
        raise ToolError(f"No UI target matching '{text}' met the confidence threshold.")
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best = candidates[0]
    if len(candidates) > 1 and best[0] == candidates[1][0] and best[1] == candidates[1][1]:
        raise ToolError(f"Multiple UI targets match '{text}' with equal confidence.")
    element = best[2]
    center = element.get("center") or {}
    if not isinstance(center, dict) or not {"x", "y"}.issubset(center):
        raise ToolError(f"UI target '{text}' has no usable screen bounds.")
    return {"target_type": "text", "name": element.get("text"), "method": "ocr", "confidence": best[1], "bounds": element.get("bbox"), "center": {"x": int(center["x"]), "y": int(center["y"])}, "window": observed, "observed_at": detected.get("observed_at")}


def _coordinate_is_calibrated(hwnd: int) -> bool:
    """Legacy OCR coordinate clicks are only safe at physical 100% DPI.

    With per-monitor scaling pyautogui and Win32 UIA may disagree about pixel
    units. Until a real Windows calibration suite passes, use UIA instead of
    guessing scaled coordinates.
    """
    import platform
    if platform.system() != "Windows":
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        return int(user32.GetDpiForWindow(int(hwnd))) == 96
    except Exception:
        return False


@register("resolveUiTarget")
def resolve_ui_target(args: Dict[str, Any]) -> Dict[str, Any]:
    target = _resolve(str(args.get("text") or args.get("target") or ""), float(args.get("min_confidence", 70)),
                      str(args.get("application") or ""), str(args.get("window_title") or ""))
    return {"result": "UI target resolved in the observed window; no input was sent.", "target": target, "verified": bool(target.get("window"))}


@register("clickUiTarget")
def click_ui_target(args: Dict[str, Any]) -> Dict[str, Any]:
    application = str(args.get("application") or "").strip()
    if not application:
        raise ToolError("Identify the intended native application before clicking a UI target.")
    target = _resolve(str(args.get("text") or args.get("target") or ""), float(args.get("min_confidence", 80)),
                      application, str(args.get("window_title") or ""))
    current = _active_window_info()
    previous = target.get("window")
    observed_at = target.get("observed_at")
    if not isinstance(observed_at, (int, float)) or not 0 <= time.time() - observed_at <= 1:
        raise ToolError("UI observation is stale; recapture before clicking.")
    if (not isinstance(previous, dict) or not isinstance(current, dict)
            or previous.get("hwnd") != current.get("hwnd")
            or not _matches_application(current, application)
            or _normalize(previous.get("title")) != _normalize(current.get("title"))):
        raise ToolError("The active window changed during target detection; no click was sent.")
    grant, _ = VISUAL_ACCESS.select(current)
    if grant.scope != "application" or grant.application != str(current.get("process_name") or "").lower():
        raise ToolError("Coordinate input requires approval for this exact foreground application.")
    if not _coordinate_is_calibrated(int(current["hwnd"])):
        raise ToolError("Display scaling is uncalibrated; use a UIA locator instead of an OCR coordinate.")
    bounds = current.get("bounds") or {}
    point = target["center"]
    if (not all(isinstance(bounds.get(k), int) for k in ("x", "y", "width", "height")) or
            not bounds["x"] <= point["x"] < bounds["x"] + bounds["width"] or
            not bounds["y"] <= point["y"] < bounds["y"] + bounds["height"]):
        raise ToolError("OCR target is outside the approved window; no click was sent.")
    if args.get("button", "left") != "left" or args.get("clicks", 1) != 1:
        raise ToolError("OCR navigation only permits one primary-button click.")
    VISUAL_ACCESS.unchanged(grant)
    click = DESKTOP_INPUT.click({"x": point["x"], "y": point["y"], "button": "left", "clicks": 1})
    if not click.get("action_sent"):
        raise ToolError("Desktop input did not report a click being sent.")
    return {"result": "A confidence-qualified target was clicked in the intended app; the requested UI change is still unverified.", "target": target, "action_sent": True, "verified": False, "click": click}
