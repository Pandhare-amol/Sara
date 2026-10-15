from __future__ import annotations

from typing import Iterable

WINDOWS_ONLY_TOOLS = frozenset({
    "openApplication", "closeApplication",
    "minimizeWindow", "maximizeWindow", "closeWindow", "listWindows",
    "getActiveWindow", "focusWindow", "switchApplication", "restoreWindow",
    "showDesktop", "restartExplorer", "turnOffDisplay", "listRunningApplications",
    "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
    "hardwareMouseMove", "hardwareMouseClick", "hardwareMouseDrag", "hardwareMouseScroll",
    "hardwareMousePosition", "hardwareMouseButtonDown", "hardwareMouseButtonUp",
    "hardwareKeyboardType", "hardwareKeyboardPress", "hardwareKeyboardHold",
    "hardwareKeyboardRelease", "mouseMove", "mouseMoveRelative", "mouseClick",
    "mouseDoubleClick", "mouseRightClick", "mouseScroll", "mousePosition",
    "keyboardType", "keyPress", "keyDown", "keyUp", "emergencyStop",
    "observeScreen", "getCurrentScreenState", "refreshScreenState", "waitForScreenChange",
})


def build_platform_capabilities(
    system: str,
    tool_names: Iterable[str],
) -> dict:
    """Describe registered tools separately from host-specific support."""
    registered = sorted(set(tool_names))
    is_windows = system == "Windows"
    platform_limited = [] if is_windows else sorted(WINDOWS_ONLY_TOOLS.intersection(registered))
    browser_names = {name for name in registered if name.startswith("desktopBrowser")}
    screen_names = {"takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen"}

    limitations = [
        "Registered tools can still fail when optional dependencies, permissions, devices, or a graphical session are missing.",
        "Browser automation requires an installed Playwright browser and a usable desktop/browser session.",
        "Screen capture and OCR require an accessible display; OCR also requires the Tesseract engine.",
    ]
    if not is_windows:
        limitations.append("Native mouse/keyboard input, Windows window management, and Windows auto-start tools are not supported on this host.")

    return {
        "host_platform": system,
        "capabilities": {
            # These are host/registry support indicators, not a guarantee that a
            # particular tool's optional runtime dependency is operational.
            "desktop": is_windows,
            "browser": bool(browser_names),
            "screen": bool(screen_names.intersection(registered)),
            "power": system in {"Windows", "Linux"},
            "tools": registered,
            "registered_tool_count": len(registered),
            "browser_tools": sorted(browser_names),
            "platform_limited_tools": platform_limited,
            "runtime_check_required": True,
        },
        "limitations": limitations,
    }
