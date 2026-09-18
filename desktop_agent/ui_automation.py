import json
import platform
from typing import Optional, Tuple, Dict

if platform.system() != "Windows":
    raise RuntimeError("UI Automation is only supported on Windows.")

try:
    from pywinauto import Desktop
    from pywinauto.controls.uiawrapper import UIAWrapper
except ImportError as e:
    raise RuntimeError("pywinauto is required for UI Automation. Install it via pip.")


def _find_element(title: Optional[str] = None, control_type: Optional[str] = None) -> Optional[UIAWrapper]:
    """Find the first element matching the given criteria.
    Args:
        title: Window or control title substring.
        control_type: UIA control type (e.g., "Button", "Edit").
    Returns:
        UIAWrapper or None.
    """
    desktop = Desktop(backend="uia")
    criteria = {}
    if title:
        criteria["title_re"] = f".*{title}.*"
    if control_type:
        criteria["control_type"] = control_type
    try:
        elems = desktop.window(**criteria)
        if elems.exists():
            return elems.wrapper_object()
    except Exception:
        pass
    return None


def get_element_bounds(title: Optional[str] = None, control_type: Optional[str] = None) -> Dict[str, int]:
    """Return the bounding rectangle of a UI element.
    Returns dict with keys: left, top, right, bottom, width, height.
    Raises RuntimeError if not found.
    """
    elem = _find_element(title, control_type)
    if not elem:
        raise RuntimeError(f"UI element not found (title={title}, control_type={control_type})")
    rect = elem.rectangle()
    return {
        "left": rect.left,
        "top": rect.top,
        "right": rect.right,
        "bottom": rect.bottom,
        "width": rect.width(),
        "height": rect.height(),
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Get UI element bounds via pywinauto")
    parser.add_argument("--title", help="Partial title of the UI element")
    parser.add_argument("--control_type", help="UIA control type")
    args = parser.parse_args()
    result = get_element_bounds(args.title, args.control_type)
    print(json.dumps(result))
