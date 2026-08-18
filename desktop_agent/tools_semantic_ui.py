from __future__ import annotations

from typing import Any, Dict, Optional

from .perception import find_elements, inspect_screen
from .registry import ToolError, register
from .target_resolver import resolve_target, safe_click_point
from .tools_hardware import hardware_keyboard_type, hardware_mouse_click, hardware_mouse_drag, hardware_mouse_move
from .tools_windows import focus_window, switch_application


def _resolution_payload(resolution) -> Dict[str, Any]:
    return resolution.to_dict() if hasattr(resolution, "to_dict") else dict(resolution or {})


def _result(tool: str, executed: bool, verified: bool, message: str, *, target: str = "", resolution: Optional[Dict[str, Any]] = None, action: str = "", changed_state: Optional[bool] = None, error: str = "") -> Dict[str, Any]:
    status = "SUCCESS" if executed and verified else "UNCERTAIN" if executed else "FAILED"
    return {"tool": tool, "status": status, "executed": executed, "verified": verified, "changed_state": changed_state, "message": message, "target": target, "resolution": resolution or {}, "action": action, "error": error, "data": resolution or {}, "verification": {"status": "VERIFIED" if verified else "UNCERTAIN", "method": (resolution or {}).get("method", "semantic_target")}, "duration_ms": None}


def _click_point(point, *, button: str = "left", clicks: int = 1) -> Dict[str, Any]:
    return hardware_mouse_click({"x": point[0], "y": point[1], "button": button, "clicks": clicks})


@register("desktopInspectScreen", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="screen_snapshot", tags=["desktop", "perception", "ui"])
def desktop_inspect_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = inspect_screen()
    snapshot.update({"tool": "desktopInspectScreen", "status": "SUCCESS", "executed": True, "verified": True, "changed_state": False, "result": f"Captured desktop snapshot with {len(snapshot.get('elements', []))} accessibility elements.", "verification": {"status": "VERIFIED", "method": "screen_snapshot"}})
    return snapshot


@register("desktopFindElements", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="accessibility_ocr_match", tags=["desktop", "perception", "ui"])
def desktop_find_elements(args: Dict[str, Any]) -> Dict[str, Any]:
    target = str(args.get("target") or args.get("text") or args.get("name") or args.get("query") or "").strip()
    if not target:
        raise ToolError("Parameter 'target' is required.")
    matches = find_elements(target, limit=int(args.get("limit", 20)))
    verified = bool(matches)
    return {"tool": "desktopFindElements", "target": target, "matches": matches, "result": f"Found {len(matches)} matching UI element(s)." if matches else f"Could not prove a UI match for '{target}'.", "executed": True, "verified": verified, "status": "SUCCESS" if verified else "UNCERTAIN", "changed_state": False, "verification": {"status": "VERIFIED" if verified else "UNCERTAIN", "method": "accessibility_ocr_match"}, "data": {"matches": matches}}


@register("desktopFindElement", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="accessibility_ocr_match", tags=["desktop", "perception", "ui"])
def desktop_find_element(args: Dict[str, Any]) -> Dict[str, Any]:
    target = str(args.get("target") or args.get("text") or args.get("name") or args.get("query") or "").strip()
    if not target:
        raise ToolError("Parameter 'target' is required.")
    resolution = resolve_target(target)
    payload = _resolution_payload(resolution)
    verified = resolution.element is not None and resolution.confidence >= float(args.get("min_confidence", 0.5))
    return {"tool": "desktopFindElement", "target": target, "result": f"Resolved target '{target}'." if verified else f"Could not reliably resolve target '{target}'.", "executed": True, "verified": verified, "status": "SUCCESS" if verified else "UNCERTAIN", "changed_state": False, "resolution": payload, "element": payload.get("element"), "verification": {"status": "VERIFIED" if verified else "UNCERTAIN", "method": resolution.method}, "data": payload}


def _click_or_focus(tool_name: str, target: Any, *, double: bool = False, right: bool = False, move_only: bool = False) -> Dict[str, Any]:
    resolution = resolve_target(target)
    payload = _resolution_payload(resolution)
    element = resolution.element
    if element is None:
        return _result(tool_name, False, False, f"Could not resolve target '{target}'.", target=str(target), resolution=payload, error="unresolved_target")
    point = safe_click_point(element)
    if point is None:
        return _result(tool_name, True, False, f"Target '{target}' is too small or unsafe to click directly.", target=str(target), resolution=payload, error="unsafe_click_point")
    if move_only:
        move_res = hardware_mouse_move({"x": point[0], "y": point[1]})
        return _result(tool_name, True, bool(move_res.get("verified")), move_res.get("result", "Moved to target."), target=str(target), resolution=payload, action="move", changed_state=False)
    hardware_mouse_move({"x": point[0], "y": point[1]})
    click_res = _click_point(point, button=("right" if right else "left"), clicks=(2 if double else 1))
    verified = bool(click_res.get("verified"))
    return _result(tool_name, True, verified, click_res.get("result", f"Clicked {target}."), target=str(target), resolution=payload, action="click", changed_state=True if verified else None)


@register("desktopMoveToTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="cursor_position", tags=["desktop", "perception", "mouse"])
def desktop_move_to_target(args: Dict[str, Any]) -> Dict[str, Any]:
    return _click_or_focus("desktopMoveToTarget", args.get("target") or args.get("name") or args.get("text") or args.get("query"), move_only=True)


@register("desktopClickTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="target_click_postcondition", tags=["desktop", "perception", "mouse"])
def desktop_click_target(args: Dict[str, Any]) -> Dict[str, Any]:
    return _click_or_focus("desktopClickTarget", args.get("target") or args.get("name") or args.get("text") or args.get("query"))


@register("desktopDoubleClickTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="target_click_postcondition", tags=["desktop", "perception", "mouse"])
def desktop_double_click_target(args: Dict[str, Any]) -> Dict[str, Any]:
    return _click_or_focus("desktopDoubleClickTarget", args.get("target") or args.get("name") or args.get("text") or args.get("query"), double=True)


@register("desktopRightClickTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="target_click_postcondition", tags=["desktop", "perception", "mouse"])
def desktop_right_click_target(args: Dict[str, Any]) -> Dict[str, Any]:
    return _click_or_focus("desktopRightClickTarget", args.get("target") or args.get("name") or args.get("text") or args.get("query"), right=True)


@register("desktopFocusTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="foreground_window", tags=["desktop", "perception", "window"])
def desktop_focus_target(args: Dict[str, Any]) -> Dict[str, Any]:
    target = args.get("target") or args.get("name") or args.get("application") or args.get("text") or args.get("query")
    if not target:
        raise ToolError("Parameter 'target' is required.")
    target_str = str(target)
    try:
        res = focus_window({"application": target_str})
        if res.get("verified"):
            res.update({"tool": "desktopFocusTarget", "status": "SUCCESS", "target": target_str})
            return res
    except Exception:
        pass
    res = switch_application({"title": target_str})
    res.update({"tool": "desktopFocusTarget", "status": "SUCCESS" if res.get("verified") else "UNCERTAIN", "target": target_str})
    return res


@register("desktopTypeIntoTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="target_text_state", tags=["desktop", "perception", "keyboard"])
def desktop_type_into_target(args: Dict[str, Any]) -> Dict[str, Any]:
    target = args.get("target") or args.get("name") or args.get("text") or args.get("query")
    text = str(args.get("value") or args.get("text") or args.get("content") or "")
    if not target:
        raise ToolError("Parameter 'target' is required.")
    if text == "":
        raise ToolError("Parameter 'text' or 'value' is required.")
    resolution = resolve_target(target)
    payload = _resolution_payload(resolution)
    element = resolution.element
    if element is None:
        return _result("desktopTypeIntoTarget", False, False, f"Could not resolve target '{target}'.", target=str(target), resolution=payload, error="unresolved_target")
    point = safe_click_point(element)
    if point:
        hardware_mouse_move({"x": point[0], "y": point[1]})
        _click_point(point, button="left", clicks=1)
    type_res = hardware_keyboard_type({"text": text})
    verified = bool(type_res.get("verified"))
    return _result("desktopTypeIntoTarget", True, verified, type_res.get("result", f"Typed into {target}."), target=str(target), resolution=payload, action="type", changed_state=True if verified else None)


@register("desktopDragTarget", permission_level="LOW", risk_level="LOW", supported_os=["Windows"], destructive=False, live_ui_verification=True, can_return_uncertain=True, verification_method="drag_target_bounds", tags=["desktop", "perception", "mouse"])
def desktop_drag_target(args: Dict[str, Any]) -> Dict[str, Any]:
    source = args.get("source") or args.get("from")
    destination = args.get("destination") or args.get("to")
    if not source or not destination:
        raise ToolError("Parameters 'source' and 'destination' are required.")
    src_res = resolve_target(source)
    dst_res = resolve_target(destination)
    if not src_res.element or not dst_res.element:
        return _result("desktopDragTarget", False, False, "Could not resolve source or destination target.", target=f"{source} -> {destination}", resolution={"source": src_res.to_dict(), "destination": dst_res.to_dict()}, error="unresolved_target")
    src_pt = safe_click_point(src_res.element)
    dst_pt = safe_click_point(dst_res.element)
    if not src_pt or not dst_pt:
        return _result("desktopDragTarget", True, False, "Source or destination is too small or unsafe to drag.", target=f"{source} -> {destination}", resolution={"source": src_res.to_dict(), "destination": dst_res.to_dict()}, error="unsafe_drag_point")
    hardware_mouse_move({"x": src_pt[0], "y": src_pt[1]})
    drag_res = hardware_mouse_drag({"x": dst_pt[0], "y": dst_pt[1], "button": "left"})
    verified = bool(drag_res.get("verified"))
    return _result("desktopDragTarget", True, verified, drag_res.get("result", "Dragged target."), target=f"{source} -> {destination}", resolution={"source": src_res.to_dict(), "destination": dst_res.to_dict()}, action="drag", changed_state=True if verified else None)
