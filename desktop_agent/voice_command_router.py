"""Natural-language voice command parser for SARA desktop automation."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional


@dataclass
class ParsedCommand:
    intent: str
    tool: str
    args: Dict[str, Any]
    confidence: float
    requires_confirmation: bool = False
    response: str = ""


def parse_voice_command(text: str, context: Optional[Dict[str, Any]] = None) -> ParsedCommand:
    raw = text.strip()
    low = raw.lower().strip()
    context = context or {}
    last_app = str(context.get("last_app") or context.get("active_app") or "").strip().lower()
    last_goal = str(context.get("last_goal") or context.get("active_goal") or "").strip()
    last_project = str(context.get("last_project") or context.get("active_project") or "").strip()
    followup_hint = context.get("followup_hint")

    if not low:
        return ParsedCommand("empty", "none", {}, 0.0, response="I did not hear a command.")

    if any(phrase in low for phrase in ("shut yourself down", "shutdown yourself", "close sara", "exit sara", "stop yourself")):
        return ParsedCommand("sara.self_shutdown", "saraSelfShutdown", {}, 0.99, response="I will shut SARA down without shutting down the computer.")

    if low in {"shutdown", "shut down", "close", "stop", "exit"}:
        return ParsedCommand("power.ambiguous", "saraShutdownClarification", {}, 0.99, response="Do you want me to shut down SARA or the computer?")

    power = _power_intent(low)
    if power:
        return ParsedCommand(
            intent=f"power.{power}",
            tool="requestPowerAction",
            args={"action": power},
            confidence=0.94,
            requires_confirmation=True,
            response=f"I need confirmation before I {power} the computer.",
        )

    if low in {"show desktop", "go to desktop", "show the desktop"}:
        return ParsedCommand("agent.execute", "saraAgentExecute", {"goal": raw}, 0.96, response="Iâ€™ll route that through SARAâ€™s system-control flow.")
    if low.startswith(("show ", "focus ", "bring ")) and any(app in low for app in ["chrome", "vscode", "code", "spotify", "explorer", "terminal", "notepad", "calculator", "task manager", "settings"]):
        target = _extract_app(low) or _extract_window_target(low)
        return ParsedCommand("agent.execute", "saraAgentExecute", {"goal": raw}, 0.86, response=f"Iâ€™ll bring {target or low} to the foreground.")
    if any(phrase in low for phrase in ["minimize ", "maximize ", "restore ", "full screen", "fullscreen"]):
        target = _extract_app(low) or _extract_window_target(low)
        action = "maximizeWindow" if "maximize" in low else "minimizeWindow" if "minimize" in low else "restoreWindow"
        return ParsedCommand("window.manage", action, {"application": target or low}, 0.84, response=f"Adjusting the window.")
    if "restart file explorer" in low or "restart explorer" in low:
        return ParsedCommand("desktop.restart_explorer", "restartExplorer", {}, 0.95, response="Restarting File Explorer.")
    if "turn off the display" in low or "turn off monitor" in low:
        return ParsedCommand("desktop.display_off", "turnOffDisplay", {}, 0.95, response="Turning off the display.")
    if "task manager" in low:
        return ParsedCommand("app.open", "openApplication", {"name": "task manager"}, 0.91, response="Opening Task Manager.")
    if "settings" in low:
        return ParsedCommand("app.open", "openApplication", {"name": "settings"}, 0.88, response="Opening Settings.")
    if any(term in low for term in ("close all applications", "close every app", "close all apps", "close background applications")):
        return ParsedCommand("system.close_all_apps", "closeAllApplications", {}, 0.94, requires_confirmation=True, response="I need confirmation before closing all applications.")
    if any(term in low for term in ("memory sync", "sync memory", "save memory", "flush memory")):
        return ParsedCommand("memory.sync", "saraMemorySync", {}, 0.92, response="Saving memory locally.")
    if any(term in low for term in ("export memory", "backup memory", "save memory export")):
        return ParsedCommand("memory.export", "saraMemoryExport", {}, 0.88, response="Exporting memory to a local file.")
    if any(term in low for term in ("forget everything about this project", "forget this project", "forget what i told you yesterday", "forget memory")):
        return ParsedCommand("memory.forget", "saraMemoryForget", {"query": raw}, 0.9, requires_confirmation=True, response="I need confirmation before forgetting memory.")
    if any(term in low for term in ("background tasks", "running tasks", "task status", "what are you doing", "what is running")):
        return ParsedCommand("task.status", "saraTaskList", {"limit": 20}, 0.9, response="Checking background tasks.")
    if any(term in low for term in ("self monitor", "monitor yourself", "system health", "health check", "diagnose yourself")):
        return ParsedCommand("self.monitor", "saraHealthRun", {}, 0.9, response="Running a self-monitoring health check.")
    if any(term in low for term in ("self improve", "improve yourself", "learn from mistakes", "reinforcement summary")):
        return ParsedCommand("self.improve", "saraExperienceInsights", {}, 0.86, response="Reviewing local experience and reinforcement signals.")
    if any(term in low for term in ("save this to brain", "remember this", "save in brain", "save to memory")):
        memory_text = _after(raw, ["save this to brain ", "remember this ", "save in brain ", "save to memory "]) or raw
        return ParsedCommand("memory.remember", "saraMemoryRemember", {"kind": "voice_memory", "content": memory_text, "metadata": {"source": "voice"}}, 0.9, response="Saving that in local memory.")
    if any(term in low for term in ("can i train sara", "train mode", "start training", "teach mode")):
        return ParsedCommand("learning.training_mode", "saraLearningTeach", {"title": raw, "domain": "voice_training", "steps": [], "examples": [raw], "metadata": {"training_mode": True}}, 0.84, response="Training mode is ready. Tell me the workflow steps and I will save them locally.")
    if any(term in low for term in ("start goal", "create goal", "track goal")):
        return ParsedCommand("goal.create", "saraGoalCreate", {"title": raw}, 0.8, response="Creating a long-term goal.")
    if any(term in low for term in ("teach sara", "train sara", "learn this", "learn workflow", "save as workflow", "save as skill")):
        return ParsedCommand("learning.teach", "saraLearningTeach", {"title": raw, "domain": "general", "steps": []}, 0.84, response="Iâ€™ll store this as a teachable workflow.")
    if any(term in low for term in ("memory status", "memory health")):
        return ParsedCommand("memory.status", "saraMemorySearch", {"query": "", "limit": 1}, 0.7, response="Checking memory.")
    if any(term in low for term in ("copy this", "copy selection", "copy selected text")):
        return ParsedCommand("clipboard.copy", "copySelected", {}, 0.9, response="Copying the selected text.")
    if any(term in low for term in ("paste this", "paste clipboard", "paste selected")):
        return ParsedCommand("clipboard.paste", "pasteClipboard", {}, 0.9, response="Pasting it now.")
    keyboard_shortcuts = {
        "copy": ("copy", ("copy", "copy selection", "copy selected text")),
        "paste": ("paste", ("paste", "paste clipboard")),
        "cut": ("cut", ("cut", "cut selection")),
        "select_all": ("select_all", ("select all", "select everything")),
        "undo": ("undo", ("undo", "undo that")),
        "redo": ("redo", ("redo", "redo that")),
        "save": ("save", ("save", "save file")),
        "find": ("find", ("find", "search in this")),
        "new_tab": ("new_tab", ("new tab", "open a new tab")),
        "close_tab": ("close_tab", ("close tab", "close this tab")),
        "close_window": ("close_window", ("close window", "close this window")),
        "alt_tab": ("alt_tab", ("switch window", "alt tab", "alt-tab")),
        "show_desktop": ("show_desktop", ("show desktop", "go to desktop")),
        "lock_screen": ("lock_screen", ("lock computer", "lock the screen")),
    }
    for shortcut_name, (shortcut, phrases) in keyboard_shortcuts.items():
        if low in phrases:
            return ParsedCommand("keyboard.shortcut", "keyboardShortcut", {"name": shortcut}, 0.94, response=f"Pressing {shortcut_name.replace('_', ' ')}.")
    if any(term in low for term in ("open camera", "open webcam", "open the camera", "open the webcam")):
        return ParsedCommand("camera.open", "openCamera", {"capture_only": False}, 0.93, response="Opening the camera.")
    if any(term in low for term in ("take photo", "take a photo", "capture photo", "capture a photo", "take picture", "take a picture", "selfie")):
        return ParsedCommand("camera.photo", "takePhoto", {}, 0.93, response="Taking a photo.")
    if "record video" in low or "start recording" in low:
        duration = _extract_duration_seconds(low)
        args = {"duration": duration} if duration else {}
        return ParsedCommand("camera.record", "recordVideo", args, 0.9, response="Starting video recording.")
    if "stop recording" in low or "stop video" in low:
        return ParsedCommand("camera.stop_recording", "stopVideoRecording", {}, 0.9, response="Stopping the recording.")
    if "scan qr" in low or "scan barcode" in low:
        return ParsedCommand("camera.scan_qr", "scanQrCode", {}, 0.9, response="Scanning for a QR code or barcode.")

    if _is_browser_suite_goal(low):
        requires_confirmation = any(word in low for word in ("send", "submit", "purchase", "pay", "checkout", "delete account", "change password"))
        return ParsedCommand(
            "browser.automation",
            "saraBrowserExecuteGoal",
            {"goal": raw},
            0.84,
            requires_confirmation=requires_confirmation,
            response="I will handle that through SARA's browser automation.",
        )

    simple_app = _extract_app(low)
    if simple_app and low.startswith(("open ", "launch ", "start ")):
        return ParsedCommand("app.open", "openApplication", {"name": simple_app}, 0.88, response=f"Opening {simple_app}.")
    if simple_app and low.startswith(("close ", "quit ", "exit ")):
        return ParsedCommand("app.close", "closeApplication", {"name": simple_app}, 0.88, response=f"Closing {simple_app}.")
    if simple_app and low.startswith(("switch to ", "focus ", "bring ")):
        return ParsedCommand("window.switch", "switchApplication", {"application": simple_app}, 0.86, response=f"Switching to {simple_app}.")

    # Keep SARA as the single voice entry point for application-specific
    # automation.  The suite itself chooses an official API when configured,
    # otherwise it uses the existing browser or desktop fallback and applies
    # its confirmation policy to sensitive requests.
    if _is_application_suite_goal(low):
        requires_confirmation = any(word in low for word in ("send", "delete", "remove", "share", "commit", "push", "merge", "pull request", "create repository"))
        return ParsedCommand(
            "application.automation",
            "saraAppExecuteGoal",
            {"goal": raw},
            0.84,
            requires_confirmation=requires_confirmation,
            response="I will handle that through SARA's application automation.",
        )

    app = _extract_app(low)
    if app and low.startswith(("open ", "launch ", "start ")):
        return ParsedCommand("app.open", "openApplication", {"name": app}, 0.88, response=f"Opening {app}.")
    if app and low.startswith(("close ", "quit ", "exit ")):
        return ParsedCommand("app.close", "closeApplication", {"name": app}, 0.88, response=f"Closing {app}.")
    if app and low.startswith(("switch to ", "focus ", "bring ")):
        return ParsedCommand("window.switch", "switchApplication", {"application": app}, 0.86, response=f"Switching to {app}.")
    if app and "maximize" in low:
        return ParsedCommand("window.maximize", "maximizeWindow", {"application": app}, 0.84, response=f"Maximizing {app}.")
    if app and "minimize" in low:
        return ParsedCommand("window.minimize", "minimizeWindow", {"application": app}, 0.84, response=f"Minimizing {app}.")

    folder = _extract_folder(low)
    if folder and low.startswith(("open ", "show ", "list ")):
        tool = "listFiles" if low.startswith("list ") else "openFolder"
        return ParsedCommand("file.folder", tool, {"name": folder}, 0.9, response=f"Opening {folder}." if tool == "openFolder" else f"Listing {folder}.")
    if any(term in low for term in ("create a folder", "create folder", "make a folder", "new folder")):
        name = _after(raw, ["named ", "called ", "folder "]) or "New Folder"
        return ParsedCommand("file.create_folder", "createFolder", {"path": name}, 0.82, response=f"Creating folder {name}.")
    if low.startswith(("open file ", "open path ")):
        target = _after(raw, ["open file ", "open path "])
        return ParsedCommand("file.open", "openPath", {"path": target}, 0.82, response=f"Opening {target}.")
    if low.startswith(("read file ", "read ")) and not any(term in low for term in ("read screen", "read page")):
        target = _after(raw, ["read file ", "read "])
        return ParsedCommand("file.read", "readFile", {"path": target}, 0.8, response=f"Reading {target}.")
    if "rename " in low:
        target = _after(raw, ["rename "])
        parts = re.split(r"\s+(?:to|as)\s+", target, maxsplit=1, flags=re.IGNORECASE)
        args = {"path": parts[0].strip(), "new_name": parts[1].strip()} if len(parts) == 2 else {"path": target, "new_name": "renamed"}
        return ParsedCommand("file.rename", "renameFile", args, 0.8, response="Renaming the file.")
    if low.startswith("copy ") and " to " in low:
        target = _after(raw, ["copy "])
        parts = re.split(r"\s+to\s+", target, maxsplit=1, flags=re.IGNORECASE)
        return ParsedCommand("file.copy", "copyFile", {"path": parts[0].strip(), "destination": parts[1].strip()}, 0.8, response="Copying the file.")
    if low.startswith("move ") and " to " in low:
        target = _after(raw, ["move "])
        parts = re.split(r"\s+to\s+", target, maxsplit=1, flags=re.IGNORECASE)
        return ParsedCommand("file.move", "moveFile", {"path": parts[0].strip(), "destination": parts[1].strip()}, 0.8, response="Moving the file.")
    if any(term in low for term in ("duplicate file", "make a copy of")):
        target = _after(raw, ["duplicate file ", "make a copy of "])
        return ParsedCommand("file.duplicate", "duplicateFile", {"path": target}, 0.78, response=f"Duplicating {target}.")
    if any(term in low for term in ("zip ", "compress ")):
        target = _after(raw, ["zip ", "compress "])
        return ParsedCommand("file.compress", "compressPath", {"path": target}, 0.78, response=f"Compressing {target}.")
    if any(term in low for term in ("extract ", "unzip ")):
        target = _after(raw, ["extract ", "unzip "])
        return ParsedCommand("file.extract", "extractZip", {"path": target}, 0.78, response=f"Extracting {target}.")
    if "find " in low or "search for " in low:
        query = _after(raw, ["find ", "search for "])
        return ParsedCommand("file.search", "searchFiles", {"folder": "home", "name": f"*{query}*", "limit": 50}, 0.78, response=f"Searching for {query}.")
    if "delete " in low or "remove " in low:
        target = _after(raw, ["delete ", "remove "])
        return ParsedCommand(
            "file.delete",
            "deleteFile",
            {"path": target, "permanent": False},
            0.78,
            requires_confirmation=True,
            response=f"I need confirmation before deleting {target}.",
        )

    if low.startswith(("search google", "google ")):
        query = _after(raw, ["search google for ", "google "])
        return ParsedCommand("browser.search", "desktopBrowserSearch", {"engine": "google", "query": query}, 0.9, response=f"Searching Google for {query}.")
    if low.startswith(("search youtube", "youtube search")) or ("youtube" in low and "search" in low):
        query = _after(raw, ["search youtube for ", "youtube search ", "for "])
        return ParsedCommand("browser.search", "desktopBrowserSearch", {"engine": "youtube", "query": query}, 0.9, response=f"Searching YouTube for {query}.")
    if "youtube" in low and any(word in low for word in ("play", "watch")):
        query = _after(raw, ["play youtube ", "watch youtube ", "play ", "watch "]) or "popular videos"
        return ParsedCommand("youtube.play", "youtube_play", {"query": query}, 0.92, response=f"Playing {query} on YouTube.")
    if low.startswith(("open youtube", "open google", "open github", "open gmail", "open chatgpt")):
        return ParsedCommand("browser.open", "desktopBrowserOpen", {"url": _site_url(low)}, 0.91, response="Opening it in the browser.")
    if low.startswith(("open instagram", "open insta")):
        return ParsedCommand("browser.open", "desktopBrowserOpen", {"url": "https://www.instagram.com"}, 0.92, response="Opening Instagram.")
    if "now open the sara project" in low or "open the sara project" in low:
        target = last_app or "vscode"
        return ParsedCommand("followup.project", "openApplication", {"name": target}, 0.94, response=f"Opening the SARA project in {target}.")
    if "instagram" in low and any(word in low for word in ("post", "publish", "dm", "message", "comment", "like", "follow", "unfollow", "story", "reel")):
        return ParsedCommand("application.automation", "saraAppExecuteGoal", {"goal": raw}, 0.84, requires_confirmation=any(word in low for word in ("post", "publish", "dm", "message", "comment", "follow", "unfollow", "like")), response="I will handle that through SARA's application automation.")
    if "new tab" in low:
        return ParsedCommand("browser.new_tab", "desktopBrowserOpenTab", {}, 0.86, response="Opening a new tab.")
    if "close tab" in low:
        return ParsedCommand("browser.close_tab", "desktopBrowserCloseTab", {}, 0.86, response="Closing the current tab.")
    if "refresh" in low:
        return ParsedCommand("browser.refresh", "desktopBrowserReload", {}, 0.86, response="Refreshing the page.")
    if "scroll" in low:
        direction = "up" if "up" in low else "down"
        return ParsedCommand("browser.scroll", "desktopBrowserScroll", {"direction": direction, "amount": 700}, 0.82, response=f"Scrolling {direction}.")

    if low.startswith("type "):
        typed = raw[5:].strip()
        return ParsedCommand("keyboard.type", "hardwareKeyboardType", {"text": typed}, 0.84, response="Typing that.")
    if low.startswith("press "):
        keys = raw[6:].strip()
        return ParsedCommand("keyboard.press", "hardwareKeyboardPress", {"keys": keys}, 0.86, response=f"Pressing {keys}.")
    if low.startswith("click"):
        coords = re.findall(r"-?\d+", low)
        args: Dict[str, Any] = {}
        if len(coords) >= 2:
            args = {"x": int(coords[0]), "y": int(coords[1])}
        return ParsedCommand("mouse.click", "hardwareMouseClick", args, 0.72, response="Clicking.")

    if "see what's in this" in low or "what's in this" in low or "what is in this" in low or "see what is on this screen" in low:
        return ParsedCommand("vision.read_screen", "readScreen", {}, 0.92, response="Reading what is visible on the screen.")
    if any(term in low for term in ("start screen monitor", "monitor screen", "watch screen", "continuous screen monitoring", "keep watching the screen")):
        return ParsedCommand("screen.monitor_start", "saraScreenMonitorStart", {}, 0.91, response="Starting continuous screen monitoring.")
    if any(term in low for term in ("stop screen monitor", "stop watching the screen", "pause screen monitor")):
        return ParsedCommand("screen.monitor_stop", "saraScreenMonitorStop", {}, 0.91, response="Stopping screen monitoring.")
    if any(term in low for term in ("screen monitor status", "monitor status", "screen status")):
        return ParsedCommand("screen.monitor_status", "saraScreenMonitorStatus", {}, 0.9, response="Checking screen monitor status.")
    if any(term in low for term in ("sample screen", "screen sample", "check the screen now")):
        return ParsedCommand("screen.monitor_sample", "saraScreenMonitorSample", {}, 0.89, response="Sampling the current screen.")
    if any(term in low for term in ("stop sara", "emergency stop", "kill switch")):
        return ParsedCommand("safety.emergency_stop", "saraAgentEmergencyStop", {}, 0.98, requires_confirmation=True, response="Emergency stop requested.")
    if low in {"sara stop", "stop speaking", "stop talking", "interrupt", "quiet"} or low.startswith("sara, stop"):
        return ParsedCommand("voice.interrupt", "saraVoiceStopSpeaking", {}, 0.99, response="Stopping speech.")
    if "screenshot" in low:
        return ParsedCommand("vision.screenshot", "saveScreenshot", {}, 0.9, response="Taking a screenshot.")
    if "read screen" in low or "what is on screen" in low:
        return ParsedCommand("vision.read_screen", "readScreen", {}, 0.86, response="Reading the screen.")
    if any(term in low for term in ("what should i do next", "suggest next step", "proactive suggestion", "recommend next step")):
        return ParsedCommand("companion.suggest_next", "saraCompanionSuggestNext", {"last_goal": last_goal, "last_project": last_project, "last_app": last_app, "hint": followup_hint}, 0.77, response="I can suggest the next step.")

    return ParsedCommand("agent.execute", "saraAgentExecute", {"goal": raw}, 0.55, response="I will plan this through SARA's agent manager.")


def parse_to_dict(text: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return asdict(parse_voice_command(text, context))


def _extract_app(text: str) -> str:
    aliases = {
        "chrome": "chrome",
        "google chrome": "chrome",
        "edge": "edge",
        "vs code": "vscode",
        "vscode": "vscode",
        "visual studio code": "vscode",
        "notepad": "notepad",
        "calculator": "calculator",
        "word": "word",
        "microsoft word": "word",
        "excel": "excel",
        "microsoft excel": "excel",
        "powerpoint": "powerpoint",
        "outlook": "outlook",
        "powershell": "powershell",
        "terminal": "powershell",
        "command prompt": "command prompt",
        "spotify": "spotify",
        "vlc": "vlc",
        "file explorer": "file explorer",
        "explorer": "file explorer",
    }
    for phrase, app in sorted(aliases.items(), key=lambda item: len(item[0]), reverse=True):
        if phrase in text:
            return app
    return ""


def _extract_folder(text: str) -> str:
    for folder in ["desktop", "documents", "downloads", "pictures", "music", "videos", "home"]:
        if folder in text:
            return folder
    return ""


def _extract_window_target(text: str) -> str:
    for phrase in ["chrome", "vscode", "code", "spotify", "explorer", "terminal", "notepad", "calculator", "task manager", "settings", "file explorer"]:
        if phrase in text:
            return phrase
    return ""


def _power_intent(text: str) -> str:
    # Explicitly separate SARA shutdown/self-close from Windows power actions.
    power_targets = ("pc", "computer", "system", "desktop")

    if "restart" in text and any(term in text for term in power_targets):
        return "restart"
    if any(phrase in text for phrase in ("shutdown", "shut down", "turn off", "power off", "power down")) and any(term in text for term in power_targets):
        return "shutdown"
    if "sleep" in text and any(term in text for term in power_targets):
        return "sleep"
    if "hibernate" in text and any(term in text for term in power_targets):
        return "sleep"
    if "lock" in text and any(term in text for term in ("computer", "pc", "system")):
        return "lock"
    return ""


def _after(text: str, markers: List[str]) -> str:
    low = text.lower()
    for marker in markers:
        idx = low.find(marker)
        if idx >= 0:
            return text[idx + len(marker) :].strip()
    return ""


def _site_url(text: str) -> str:
    sites = {
        "youtube": "https://www.youtube.com",
        "google": "https://www.google.com",
        "github": "https://github.com",
        "gmail": "https://mail.google.com",
        "chatgpt": "https://chatgpt.com",
        "instagram": "https://www.instagram.com",
    }
    for key, url in sites.items():
        if key in text:
            return url
    return "https://www.google.com"


def _extract_duration_seconds(text: str) -> Optional[int]:
    match = re.search(r"(\d+)\s*(second|seconds|minute|minutes)", text)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2)
    return amount * 60 if "minute" in unit else amount


def _is_application_suite_goal(text: str) -> bool:
    applications = (
        "whatsapp", "telegram", "discord", "slack", "teams", "zoom", "google meet", "skype",
        "gmail", "outlook", "thunderbird", "visual studio", "jetbrains", "pycharm",
        "github desktop", "docker", "word", "excel", "powerpoint", "onenote", "libreoffice",
        "spotify", "vlc", "google drive", "onedrive", "dropbox", "notion", "obsidian",
        "todoist", "trello", "asana", "clickup", "calendar",
    )
    return any(application in text for application in applications)

def _is_browser_suite_goal(text: str) -> bool:
    browser_terms = (
        "research", "browse", "go to ", "navigate to", "open url", "open website",
        "fill form", "submit form", "read page", "summarize page",
        "click link", "click button", "login", "sign in", "checkout", "compare prices",
    )
    if any(term in text for term in browser_terms):
        return True
    return bool(re.search(r"\b(download|upload)\b", text))




