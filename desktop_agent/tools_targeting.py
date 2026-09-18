"""Confidence-gated target resolution over the existing OCR and input tools."""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from .desktop_input_controller import DESKTOP_INPUT
from .registry import TOOLS, ToolError, register


def _normalize(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _resolve(text: str, min_confidence: float = 70.0) -> Dict[str, Any]:
    query = _normalize(text)
    if not query:
        raise ToolError("Parameter 'text' or 'target' is required.")
        
    # Priority 1: Semantic Target Resolution (UI Automation)
    try:
        from .ui_automation import get_element_bounds
        bounds = get_element_bounds(title=text)
        if bounds:
            center_x = bounds["left"] + bounds["width"] // 2
            center_y = bounds["top"] + bounds["height"] // 2
            return {
                "target_type": "text", 
                "name": text, 
                "method": "uia", 
                "confidence": 100.0, 
                "bounds": [bounds["left"], bounds["top"], bounds["right"], bounds["bottom"]], 
                "center": {"x": center_x, "y": center_y}
            }
    except Exception:
        pass # Fallback to OCR
        
    # Priority 2: Computer Vision / OCR
    detector = TOOLS.get("detectUiElements")
    if detector is None:
        raise ToolError("UI detection handler is unavailable and UIA fallback failed.")
    detected = detector({})
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
    return {"target_type": "text", "name": element.get("text"), "method": "ocr", "confidence": best[1], "bounds": element.get("bbox"), "center": {"x": int(center["x"]), "y": int(center["y"])}}


@register("resolveUiTarget")
def resolve_ui_target(args: Dict[str, Any]) -> Dict[str, Any]:
    target = _resolve(str(args.get("text") or args.get("target") or ""), float(args.get("min_confidence", 70)))
    return {
        "actionId": args.get("actionId", ""),
        "type": "ui.resolveTarget",
        "execution": {"success": True},
        "verification": {"success": True, "details": {"target": target}},
    }


@register("clickUiTarget")
def click_ui_target(args: Dict[str, Any]) -> Dict[str, Any]:
    target = _resolve(str(args.get("text") or args.get("target") or ""), float(args.get("min_confidence", 80)))
    click = DESKTOP_INPUT.click({"x": target["center"]["x"], "y": target["center"]["y"], "button": args.get("button", "left"), "clicks": args.get("clicks", 1)})
    return {
        "actionId": args.get("actionId", ""),
        "type": "ui.clickTarget",
        "execution": {"success": click.get("execution", {}).get("success", False)},
        "verification": {"success": click.get("verification", {}).get("success", False), "details": {"target": target}},
    }
