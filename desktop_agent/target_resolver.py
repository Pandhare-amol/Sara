from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from .perception import find_button, find_element, find_elements, find_window, get_active_application
from .ui_element import UIElement, element_from_dict


@dataclass
class TargetResolution:
    target: str
    element: Optional[UIElement]
    source: str
    confidence: float
    method: str
    reason: str = ""
    active_window: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"target": self.target, "element": self.element.to_dict() if self.element else None, "source": self.source, "confidence": self.confidence, "method": self.method, "reason": self.reason, "active_window": self.active_window}


def _coord_element(x: int, y: int) -> UIElement:
    return UIElement(role="point", name=f"({x}, {y})", text="", bounds={"x": x, "y": y, "width": 1, "height": 1}, x=x, y=y, width=1, height=1, visible=True, enabled=True, clickable=True, confidence=1.0, source="COORDINATE")


def _normalize_target(target: Any) -> str:
    if isinstance(target, dict):
        for key in ("target", "name", "text", "label", "query"):
            if target.get(key):
                return str(target[key])
    return str(target or "").strip()


def _parse_coordinate_target(target: str) -> Optional[UIElement]:
    nums = []
    for part in target.replace("@", " ").replace(",", " ").split():
        try:
            nums.append(int(float(part)))
        except Exception:
            continue
    if len(nums) >= 2:
        return _coord_element(nums[0], nums[1])
    return None


def resolve_target(target: Any, *, prefer_active_window: bool = True) -> TargetResolution:
    query = _normalize_target(target)
    active = get_active_application()
    active_title = str(active.get("window", {}).get("title") or "")
    if isinstance(target, dict) and target.get("x") is not None and target.get("y") is not None:
        el = _coord_element(int(target["x"]), int(target["y"]))
        return TargetResolution(query, el, "COORDINATE", 1.0, "explicit_coordinate", active_window=active_title)
    if not query:
        return TargetResolution(query, None, "UNKNOWN", 0.0, "empty", reason="No target provided", active_window=active_title)
    coord = _parse_coordinate_target(query)
    if coord:
        return TargetResolution(query, coord, "COORDINATE", 1.0, "parsed_coordinate", active_window=active_title)
    window = find_window(query)
    if window:
        el = element_from_dict(window)
        return TargetResolution(query, el, "ACCESSIBILITY", max(0.8, el.confidence), "window_match", active_window=active_title)
    button = find_button(query)
    if button:
        el = element_from_dict(button)
        if prefer_active_window and active_title and active_title.lower() in (el.window or "").lower():
            el.confidence = min(1.0, el.confidence + 0.05)
        return TargetResolution(query, el, str(button.get("source") or "ACCESSIBILITY"), max(0.6, el.confidence), "button_or_actionable", active_window=active_title)
    semantic = find_element(query)
    if semantic:
        el = element_from_dict(semantic)
        if prefer_active_window and active_title and active_title.lower() in (el.window or "").lower():
            el.confidence = min(1.0, el.confidence + 0.05)
        return TargetResolution(query, el, str(semantic.get("source") or "ACCESSIBILITY"), max(0.55, el.confidence), "semantic_match", active_window=active_title)
    fuzzy = find_elements(query, limit=5)
    if fuzzy:
        best = element_from_dict(fuzzy[0])
        return TargetResolution(query, best, str(fuzzy[0].get("source") or "OCR"), max(0.45, best.confidence), "fuzzy_match", active_window=active_title)
    return TargetResolution(query, None, "UNKNOWN", 0.0, "unresolved", reason="No semantic or OCR target could be proven", active_window=active_title)


def safe_click_point(element: UIElement) -> Optional[Tuple[int, int]]:
    if not element or element.width < 3 or element.height < 3:
        return None
    return int(math.floor(element.x + element.width / 2)), int(math.floor(element.y + element.height / 2))
