# desktop_agent/tools_ui_automation.py
"""Tool registration for UI Automation helper functions.
Provides a tool to retrieve bounding box of a UI element using pywinauto.
"""

from __future__ import annotations

from .registry import register, ToolError

# Import the helper we added earlier
from .ui_automation import get_element_bounds

@register("getElementBounds")
def get_element_bounds_tool(args: dict) -> dict:
    """Return bounds for a UI element.
    Expected args: {"title": <partial title>, "control_type": <UIA control type>}
    """
    title = args.get("title")
    control_type = args.get("control_type")
    try:
        bounds = get_element_bounds(title=title, control_type=control_type)
        return {"actionId": args.get("actionId", ""), "type": "ui.getElementBounds", "execution": {"success": True}, "verification": {"success": True, "details": {"bounds": bounds}}}
    except Exception as e:
        raise ToolError(f"Failed to get element bounds: {e}")
