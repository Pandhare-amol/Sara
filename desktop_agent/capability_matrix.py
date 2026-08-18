"""Canonical desktop capability matrix for SARA.

This module maps the requested high-level desktop capability groups to the
actual tools already present in the desktop_agent package. It is intentionally
descriptive: the matrix does not replace execution, it documents which tool
implements each capability, what platform it expects, and how verification is
usually performed.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, List

from .registry import register


@dataclass(frozen=True)
class CapabilityEntry:
    capability: str
    tool: str
    category: str
    supported_os: List[str]
    required_permissions: List[str]
    destructive: bool
    verification_method: str
    live_ui_verification: bool
    can_return_uncertain: bool
    notes: str = ""


CAPABILITY_MATRIX: Dict[str, List[CapabilityEntry]] = {
    "perception": [
        CapabilityEntry("inspect screen", "desktopInspectScreen", "perception", ["Windows"], ["read_screen"], False, "screen_snapshot", True, True),
        CapabilityEntry("find element", "desktopFindElement", "perception", ["Windows"], ["read_screen"], False, "accessibility_ocr_match", True, True),
        CapabilityEntry("find elements", "desktopFindElements", "perception", ["Windows"], ["read_screen"], False, "accessibility_ocr_match", True, True),
        CapabilityEntry("click target", "desktopClickTarget", "perception", ["Windows"], ["input"], False, "target_click_postcondition", True, True),
        CapabilityEntry("double click target", "desktopDoubleClickTarget", "perception", ["Windows"], ["input"], False, "target_click_postcondition", True, True),
        CapabilityEntry("right click target", "desktopRightClickTarget", "perception", ["Windows"], ["input"], False, "target_click_postcondition", True, True),
        CapabilityEntry("move to target", "desktopMoveToTarget", "perception", ["Windows"], ["input"], False, "cursor_position", True, True),
        CapabilityEntry("drag target", "desktopDragTarget", "perception", ["Windows"], ["input"], False, "drag_target_bounds", True, True),
        CapabilityEntry("focus target", "desktopFocusTarget", "perception", ["Windows"], ["input"], False, "foreground_window", True, True),
        CapabilityEntry("type into target", "desktopTypeIntoTarget", "perception", ["Windows"], ["input"], False, "target_text_state", True, True),
    ],
    "mouse": [
        CapabilityEntry("move cursor", "hardwareMouseMove", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "postcondition_cursor_position", True, True),
        CapabilityEntry("left click", "hardwareMouseClick", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("double click", "hardwareMouseClick", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True, "use clicks=2"),
        CapabilityEntry("right click", "hardwareMouseClick", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("middle click", "hardwareMouseClick", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("mouse button hold", "hardwareMouseDrag", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "gesture_state", True, True, "use drag with press/hold semantics"),
        CapabilityEntry("drag/drop", "hardwareMouseDrag", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "postcondition_drag_target", True, True),
        CapabilityEntry("text selection", "hardwareMouseDrag", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "ui_selection", True, True),
        CapabilityEntry("multi-item selection", "hardwareKeyboardPress", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "ui_selection", True, True, "combine with Ctrl/Shift"),
        CapabilityEntry("vertical scrolling", "hardwareMouseScroll", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "scroll_position", True, True),
        CapabilityEntry("horizontal scrolling", "hardwareMouseScroll", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "scroll_position", True, True, "use horizontal=true"),
        CapabilityEntry("cursor sensitivity/acceleration", "hardwareMouseMove", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "hardware_setting", False, True, "not yet exposed as a dedicated tool"),
        CapabilityEntry("move cursor to screen corners", "hardwareMouseMove", "mouse", ["Windows", "macOS", "Linux"], ["input"], False, "postcondition_cursor_position", True, True),
        CapabilityEntry("show/hide cursor", "hardwareMouseMove", "mouse", ["Windows"], ["input"], False, "os_specific", False, True, "no dedicated tool yet"),
    ],
    "keyboard": [
        CapabilityEntry("individual keys", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Enter", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Backspace", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Delete", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Space", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Tab", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Escape", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Shift", "hardwareKeyboardHold", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "key_state", True, True),
        CapabilityEntry("Ctrl", "hardwareKeyboardHold", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "key_state", True, True),
        CapabilityEntry("Alt", "hardwareKeyboardHold", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "key_state", True, True),
        CapabilityEntry("Windows key", "hardwareKeyboardPress", "keyboard", ["Windows"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("F1-F12", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("arrows", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Home/End", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("PageUp/PageDown", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("key combinations", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Ctrl+C/V/X/Z/Y/S/A", "hardwareKeyboardPress", "keyboard", ["Windows", "macOS", "Linux"], ["input"], False, "event_dispatch", True, True),
        CapabilityEntry("Alt+Tab", "switchApplication", "keyboard", ["Windows"], ["input"], False, "foreground_window", True, True),
    ],
    "windows_applications": [
        CapabilityEntry("open", "openApplication", "windows/applications", ["Windows"], ["launch_app"], False, "verify_window_exists", True, True),
        CapabilityEntry("close", "closeWindow", "windows/applications", ["Windows"], ["window_control"], False, "verify_window_gone", True, True),
        CapabilityEntry("minimize", "minimizeWindow", "windows/applications", ["Windows"], ["window_control"], False, "window_state", True, True),
        CapabilityEntry("maximize", "maximizeWindow", "windows/applications", ["Windows"], ["window_control"], False, "window_state", True, True),
        CapabilityEntry("restore", "restoreWindow", "windows/applications", ["Windows"], ["window_control"], False, "window_state", True, True),
        CapabilityEntry("move", "moveWindow", "windows/applications", ["Windows"], ["window_control"], False, "verify_window_bounds", True, True),
        CapabilityEntry("resize", "resizeWindow", "windows/applications", ["Windows"], ["window_control"], False, "verify_window_bounds", True, True),
        CapabilityEntry("snap", "minimizeOtherWindows", "windows/applications", ["Windows"], ["window_control"], False, "foreground_window", True, True),
        CapabilityEntry("focus", "focusWindow", "windows/applications", ["Windows"], ["window_control"], False, "verify_foreground_window", True, True),
        CapabilityEntry("switch", "switchApplication", "windows/applications", ["Windows"], ["window_control"], False, "verify_foreground_window", True, True),
        CapabilityEntry("virtual desktops", "switchApplication", "windows/applications", ["Windows"], ["window_control"], False, "foreground_window", True, True, "no dedicated desktop switcher yet"),
        CapabilityEntry("show desktop", "showDesktop", "windows/applications", ["Windows"], ["window_control"], False, "foreground_window", True, True),
        CapabilityEntry("task/application switcher", "switchApplication", "windows/applications", ["Windows"], ["window_control"], False, "foreground_window", True, True),
    ],
    "browser": [
        CapabilityEntry("new tab", "desktopBrowserOpenTab", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("close tab", "desktopBrowserCloseTab", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("switch tab", "browserTabAction", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("previous/next tab", "browserTabAction", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("new window", "desktopBrowserOpen", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
        CapabilityEntry("close window", "desktopBrowserCloseTab", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("back", "desktopBrowserGoBack", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
        CapabilityEntry("forward", "desktopBrowserGoForward", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
        CapabilityEntry("refresh", "desktopBrowserReload", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
        CapabilityEntry("stop", "desktopBrowserMedia", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "browser_media_state", True, True, "no dedicated stop tool yet"),
        CapabilityEntry("zoom", "desktopBrowserZoom", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_zoom", True, True),
        CapabilityEntry("reset zoom", "desktopBrowserZoom", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_zoom", True, True),
        CapabilityEntry("page scrolling", "desktopBrowserScroll", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_scroll_position", True, True),
        CapabilityEntry("open link", "desktopBrowserClick", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
        CapabilityEntry("open link in new tab", "desktopBrowserOpenTab", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_active_browser_tab", True, True),
        CapabilityEntry("search", "desktopBrowserSearch", "browser", ["Windows", "macOS", "Linux"], ["browser"], False, "verify_browser_url", True, True),
    ],
    "audio_media": [
        CapabilityEntry("volume", "setVolume", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_volume", False, True),
        CapabilityEntry("mute", "muteToggle", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_volume", False, True),
        CapabilityEntry("play/pause", "youtube_play", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_media_state", True, True),
        CapabilityEntry("next/previous", "youtube_seek", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_media_state", True, True, "media key mapping only"),
        CapabilityEntry("seek", "youtube_seek", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_media_state", True, True),
        CapabilityEntry("audio output", "setVolume", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "device_selection", False, True, "no dedicated output selector yet"),
        CapabilityEntry("microphone mute", "muteToggle", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "device_state", False, True, "system-level mic mute not yet dedicated"),
        CapabilityEntry("playback speed", "browserMediaControl", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "media_state", True, True, "browser-dependent"),
        CapabilityEntry("fullscreen", "youtube_fullscreen", "audio/media", ["Windows", "macOS", "Linux"], ["media"], False, "verify_media_state", True, True),
    ],
    "display": [
        CapabilityEntry("brightness", "setBrightness", "display", ["Windows", "macOS"], ["display"], False, "verify_brightness", False, True),
        CapabilityEntry("night mode", "setBrightness", "display", ["Windows", "macOS"], ["display"], False, "system_setting", False, True, "no dedicated tool yet"),
        CapabilityEntry("scaling", "systemInfo", "display", ["Windows", "macOS", "Linux"], ["display"], False, "system_setting", False, True, "read-only only"),
        CapabilityEntry("rotation", "systemInfo", "display", ["Windows", "macOS", "Linux"], ["display"], False, "system_setting", False, True, "no dedicated tool yet"),
        CapabilityEntry("monitor switching", "saraScreenGetMonitors", "display", ["Windows", "macOS", "Linux"], ["display"], False, "verify_display_state", True, True),
        CapabilityEntry("extend/mirror", "saraScreenGetMonitors", "display", ["Windows"], ["display"], False, "verify_display_state", True, True, "no dedicated switch tool yet"),
        CapabilityEntry("display off", "turnOffDisplay", "display", ["Windows"], ["display"], False, "verify_display_state", False, True),
        CapabilityEntry("screenshot", "takeScreenshot", "display", ["Windows", "macOS", "Linux"], ["screen"], False, "verify_image_capture", True, True),
        CapabilityEntry("screen recording", "saraScreenLiveStart", "display", ["Windows", "macOS", "Linux"], ["screen"], False, "recording_state", True, True),
        CapabilityEntry("magnification", "systemInfo", "display", ["Windows", "macOS", "Linux"], ["display"], False, "system_setting", False, True, "no dedicated tool yet"),
    ],
    "files": [
        CapabilityEntry("open/close folder", "openFolder", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_folder_exists", True, True),
        CapabilityEntry("create folder", "createFolder", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_exists", True, True),
        CapabilityEntry("rename", "renameFile", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_renamed", True, True),
        CapabilityEntry("delete", "deleteFile", "files", ["Windows", "macOS", "Linux"], ["filesystem"], True, "verify_file_gone", True, True),
        CapabilityEntry("copy", "copyFile", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_copied", True, True),
        CapabilityEntry("cut", "moveFile", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_moved", True, True),
        CapabilityEntry("paste", "pasteClipboard", "files", ["Windows", "macOS", "Linux"], ["clipboard"], False, "verify_clipboard_state", False, True),
        CapabilityEntry("select", "copySelected", "files", ["Windows", "macOS", "Linux"], ["clipboard"], False, "verify_clipboard_state", False, True),
        CapabilityEntry("multi-select", "copySelected", "files", ["Windows", "macOS", "Linux"], ["clipboard"], False, "verify_clipboard_state", False, True),
        CapabilityEntry("open", "openPath", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_exists", True, True),
        CapabilityEntry("move", "moveFile", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "verify_file_moved", True, True),
        CapabilityEntry("search", "searchFiles", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "search_result", True, True),
        CapabilityEntry("hidden files", "searchFiles", "files", ["Windows", "macOS", "Linux"], ["filesystem"], False, "search_result", True, True, "no dedicated toggle tool yet"),
    ],
    "system": [
        CapabilityEntry("lock", "executePowerAction", "system", ["Windows", "Linux"], ["power"], True, "verify_system_state", False, True),
        CapabilityEntry("logout", "executePowerAction", "system", ["Windows", "Linux"], ["power"], True, "verify_system_state", False, True, "no dedicated logout tool yet"),
        CapabilityEntry("sleep", "executePowerAction", "system", ["Windows", "Linux"], ["power"], True, "verify_system_state", False, True),
        CapabilityEntry("hibernate", "executePowerAction", "system", ["Windows"], ["power"], True, "verify_system_state", False, True),
        CapabilityEntry("shutdown", "executePowerAction", "system", ["Windows", "Linux"], ["power"], True, "verify_system_state", False, True),
        CapabilityEntry("restart", "executePowerAction", "system", ["Windows", "Linux"], ["power"], True, "verify_system_state", False, True),
        CapabilityEntry("settings", "openApplication", "system", ["Windows"], ["launch_app"], False, "verify_window_exists", True, True),
        CapabilityEntry("task manager", "openApplication", "system", ["Windows"], ["launch_app"], False, "verify_window_exists", True, True),
        CapabilityEntry("terminal", "openApplication", "system", ["Windows", "Linux", "macOS"], ["launch_app"], False, "verify_window_exists", True, True),
        CapabilityEntry("system monitor", "systemInfo", "system", ["Windows", "Linux", "macOS"], ["read_system"], False, "system_state", False, False),
        CapabilityEntry("Bluetooth", "systemInfo", "system", ["Windows", "Linux", "macOS"], ["read_system"], False, "system_state", False, False),
        CapabilityEntry("Wi-Fi", "systemInfo", "system", ["Windows", "Linux", "macOS"], ["read_system"], False, "system_state", False, False),
        CapabilityEntry("network", "systemInfo", "system", ["Windows", "Linux", "macOS"], ["read_system"], False, "system_state", False, False),
    ],
    "camera": [
        CapabilityEntry("screenshot", "takeScreenshot", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "verify_image_capture", True, True),
        CapabilityEntry("photo", "takePhoto", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "verify_media_state", True, True),
        CapabilityEntry("recording", "recordVideo", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "verify_media_state", True, True),
        CapabilityEntry("stop recording", "stopVideoRecording", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "verify_media_state", True, True),
        CapabilityEntry("zoom", "getVisionState", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True, "no dedicated zoom tool yet"),
        CapabilityEntry("camera selection", "getVisionState", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True, "no dedicated selector yet"),
        CapabilityEntry("enable/disable", "gestureControlStart", "camera", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True),
    ],
    "gesture_control": [
        CapabilityEntry("start", "gestureControlStart", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True),
        CapabilityEntry("stop", "gestureControlStop", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True),
        CapabilityEntry("pause", "gestureControlPause", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("resume", "gestureControlResume", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("status", "gestureControlStatus", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("calibrate", "gestureControlCalibrate", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_config", False, True),
        CapabilityEntry("set mapping", "gestureControlSetMapping", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_mapping_store", False, True),
        CapabilityEntry("set monitor", "gestureControlSetMonitor", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True),
        CapabilityEntry("set sensitivity", "gestureControlSetSensitivity", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_config", False, True),
        CapabilityEntry("set thresholds", "gestureControlSetThresholds", "gesture_control", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_config", False, True),
    ],
    "advanced_gestures": [
        CapabilityEntry("finger count", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("finger positions", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("finger direction", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("palm orientation", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("hand rotation", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("movement direction", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("velocity", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("distance between fingers", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("distance between hands", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("trajectories", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("swipe", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("pinch", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("grab/release", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("finger tapping", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("multi-finger gestures", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("left/right hand detection", "getVisionState", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("two-hand gestures", "getVisionState", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("open palm", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("closed fist", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("pointing", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("two-finger gesture", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_to_action_mapping", False, True),
        CapabilityEntry("gesture confidence scoring", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("gesture smoothing", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("gesture debouncing", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("gesture cooldowns", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("gesture safety controls", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("gesture recording/replay", "gestureControlStatus", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_state", False, True),
        CapabilityEntry("runtime enable/disable", "gestureControlStart", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "camera_state", False, True),
        CapabilityEntry("user-configurable gesture mappings", "gestureControlSetMapping", "advanced_gestures", ["Windows", "macOS", "Linux"], ["camera"], False, "gesture_mapping_store", False, True),
    ],
}


def list_capability_groups() -> List[str]:
    return sorted(CAPABILITY_MATRIX)


def get_capability_matrix() -> Dict[str, List[Dict[str, Any]]]:
    return {group: [asdict(entry) for entry in entries] for group, entries in CAPABILITY_MATRIX.items()}


def find_capability(capability: str) -> List[Dict[str, Any]]:
    needle = capability.strip().lower()
    matches: List[Dict[str, Any]] = []
    for group, entries in CAPABILITY_MATRIX.items():
        for entry in entries:
            if needle in entry.capability.lower() or needle in entry.tool.lower():
                item = asdict(entry)
                item["group"] = group
                matches.append(item)
    return matches


@register(
    "saraDesktopCapabilityMatrix",
    description="Return SARA's canonical desktop capability matrix.",
    permission_level="LOW",
    risk_level="LOW",
    execution_method="registry_lookup",
    verification_method="static_catalog",
    tags=["desktop", "matrix", "capability"],
)
def sara_desktop_capability_matrix(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if query:
        return {"result": "Capability matches found.", "query": query, "matches": find_capability(query), "verified": True, "verification": "VERIFIED"}
    return {"result": "Desktop capability matrix loaded.", "matrix": get_capability_matrix(), "verified": True, "verification": "VERIFIED"}
