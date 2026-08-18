from __future__ import annotations

import difflib
import time
from typing import Any, Dict, List, Optional

from .tools_screenshot import _capture, _ocr_data
from .tools_windows import get_active_window, list_windows
from .ui_element import UIElement, element_from_dict

try:
    from pywinauto import Desktop  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Desktop = None  # type: ignore


def _desktop():
    if Desktop is None:
        return None
    try:
        return Desktop(backend="uia")
    except Exception:
        return None


def _safe_rectangle(rect: Any) -> Dict[str, int]:
    try:
        return {
            "x": int(rect.left),
            "y": int(rect.top),
            "width": max(0, int(rect.right - rect.left)),
            "height": max(0, int(rect.bottom - rect.top)),
        }
    except Exception:
        return {"x": 0, "y": 0, "width": 0, "height": 0}


def _from_accessibility(control: Any, *, window_title: str = "") -> Optional[UIElement]:
    try:
        info = control.element_info
        rect = control.rectangle()
        bounds = _safe_rectangle(rect)
        role = str(getattr(info, "control_type", "") or "")
        name = str(getattr(info, "name", "") or "")
        automation_id = str(getattr(info, "automation_id", "") or "")
        enabled = bool(getattr(info, "enabled", True))
        visible = bool(getattr(info, "visible", True))
        focused = bool(getattr(info, "has_keyboard_focus", False))
        clickable = role.lower() in {"button", "hyperlink", "menuitem", "tabitem", "checkbox", "radiobutton", "splitbutton", "listitem"}
        return UIElement(
            role=role.lower(),
            name=name,
            text=name,
            bounds=bounds,
            x=bounds["x"],
            y=bounds["y"],
            width=bounds["width"],
            height=bounds["height"],
            visible=visible,
            enabled=enabled,
            focused=focused,
            clickable=clickable,
            application=str(getattr(info, "process_id", "") or ""),
            window=window_title,
            accessibility_id=automation_id,
            automation_id=automation_id,
            confidence=0.99 if name else 0.85,
            source="ACCESSIBILITY",
            metadata={"control_type": role, "class_name": getattr(info, "class_name", "")},
        )
    except Exception:
        return None


def _enumerate_accessibility(limit: int = 200) -> List[UIElement]:
    desktop = _desktop()
    if desktop is None:
        return []
    found: List[UIElement] = []
    try:
        for window in desktop.windows(visible_only=True):
            title = str(getattr(window.element_info, "name", "") or "")
            root = _from_accessibility(window, window_title=title)
            if root:
                found.append(root)
            try:
                for child in window.descendants(depth=3):
                    el = _from_accessibility(child, window_title=title)
                    if el:
                        found.append(el)
                    if len(found) >= limit:
                        return found
            except Exception:
                continue
    except Exception:
        return found
    return found


def _ocr_elements(max_results: int = 100) -> List[UIElement]:
    try:
        img = _capture()
        data = _ocr_data(img)
    except Exception:
        return []
    items: List[UIElement] = []
    n = len(data.get("text", [])) if isinstance(data, dict) else 0
    for i in range(n):
        txt = str(data["text"][i]).strip()
        if not txt:
            continue
        try:
            conf = float(data["conf"][i])
        except Exception:
            conf = 0.0
        x = int(data["left"][i])
        y = int(data["top"][i])
        w = int(data["width"][i])
        h = int(data["height"][i])
        items.append(UIElement(role="text", name=txt, text=txt, bounds={"x": x, "y": y, "width": w, "height": h}, x=x, y=y, width=w, height=h, visible=True, enabled=False, clickable=False, confidence=max(0.0, min(1.0, conf / 100.0)), source="OCR"))
        if len(items) >= max_results:
            break
    return items


def _match_score(el: UIElement, target: str, active_window: str = "") -> float:
    needle = target.strip().lower()
    if not needle:
        return 0.0
    hay = " ".join(filter(None, [el.name, el.text, el.role, el.window, el.application])).lower()
    score = 0.0
    if hay == needle:
        score += 1.0
    if needle in hay:
        score += 0.8
    score += difflib.SequenceMatcher(None, needle, hay).ratio() * 0.5
    if active_window and active_window.lower() in (el.window or "").lower():
        score += 0.2
    if el.source == "ACCESSIBILITY":
        score += 0.2
    elif el.source == "OCR":
        score += 0.1
    return score + max(0.0, min(0.1, el.confidence))


def inspect_screen() -> Dict[str, Any]:
    try:
        active = get_active_window({}).get("window", {})
    except Exception:
        active = {}
    try:
        windows = list_windows({}).get("windows", [])
    except Exception:
        windows = []
    elements = [el.to_dict() for el in _enumerate_accessibility(limit=150)]
    ocr_items = [el.to_dict() for el in _ocr_elements(max_results=80)]
    try:
        import pyautogui
        x, y = pyautogui.position()
        cursor = {"x": int(x), "y": int(y)}
    except Exception:
        cursor = {"x": 0, "y": 0}
    return {"timestamp": time.time(), "active_window": active, "windows": windows, "elements": elements, "ocr": ocr_items, "cursor": cursor}


def find_elements(target: str, *, limit: int = 20) -> List[Dict[str, Any]]:
    snapshot = inspect_screen()
    active_title = str(snapshot.get("active_window", {}).get("title") or "")
    candidates = [element_from_dict(item) for item in snapshot.get("elements", [])] + [element_from_dict(item) for item in snapshot.get("ocr", [])]
    scored = sorted((( _match_score(el, target, active_title), el) for el in candidates), key=lambda item: item[0], reverse=True)
    results: List[Dict[str, Any]] = []
    for score, el in scored:
        if score < 0.45:
            continue
        item = el.to_dict()
        item["confidence"] = min(1.0, max(item.get("confidence", 0.0), score))
        results.append(item)
        if len(results) >= limit:
            break
    return results


def find_element(target: str) -> Optional[Dict[str, Any]]:
    matches = find_elements(target, limit=1)
    return matches[0] if matches else None


def find_text(text: str) -> List[Dict[str, Any]]:
    return find_elements(text, limit=20)


def find_button(text: str) -> Optional[Dict[str, Any]]:
    match = find_element(text)
    return match


def find_window(target: str) -> Optional[Dict[str, Any]]:
    needle = target.strip().lower()
    if not needle:
        return None
    try:
        windows = list_windows({}).get("windows", [])
    except Exception:
        windows = []
    for win in windows:
        title = str(win.get("title") or "").lower()
        app = str(win.get("application_name") or "").lower()
        if needle and (needle in title or needle in app or needle == app.replace(".exe", "")):
            return dict(win)
    return None


def get_active_application() -> Dict[str, Any]:
    try:
        window = get_active_window({}).get("window", {})
    except Exception:
        window = {}
    return {"window": window, "application": window.get("application_name") or window.get("title") or ""}
