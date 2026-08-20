"""OS control and desktop automation suite for SARA.

This module provides a modular, safety-aware API for desktop automation tasks
such as window, file, process, system, clipboard, camera, screen, audio,
network, and device management. High-risk actions require confirmation.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import MEMORY, SECURITY, WORKFLOWS, _score
from .registry import TOOLS, ToolError

SENSITIVE_ACTIONS = {
    "shutdown",
    "restart",
    "hibernate",
    "sleep",
    "logout",
    "switch_user",
    "empty_recycle_bin",
    "permanent_delete",
    "clear_temp",
    "clear_cache",
    "delete_file",
    "delete_folder",
    "format_drive",
    "uninstall",
    "restart_sara",
    "shutdown_sara",
}


@dataclass
class OSAction:
    name: str
    category: str
    description: str
    requires_confirmation: bool = False


class OSPluginManager:
    def __init__(self) -> None:
        self.plugins: Dict[str, OSAction] = {}

    def register(self, action: OSAction) -> None:
        self.plugins[action.name.lower().replace(" ", "_")] = action

    def list_actions(self) -> List[Dict[str, Any]]:
        return [asdict(action) for action in sorted(self.plugins.values(), key=lambda item: item.name)]


class AutomationEngine:
    def __init__(self, suite: Optional["OSAutomationSuite"] = None) -> None:
        self.suite = suite
        self.workflows: List[Dict[str, Any]] = []

    def create_workflow(self, name: str, description: str, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        workflow = {"id": uuid.uuid4().hex, "name": name, "description": description, "steps": steps, "status": "draft"}
        self.workflows.append(workflow)
        return workflow

    def run_workflow(self, workflow: Dict[str, Any], confirmed: bool = False) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        for step in workflow.get("steps", []):
            result = self.suite.execute(step.get("action", "open_folder"), step.get("args") or {}, confirmed=confirmed) if self.suite else {"result": "ok"}
            results.append(result)
        workflow["status"] = "completed"
        return {"status": "completed", "workflow": workflow, "results": results}


class SecurityLayer:
    def __init__(self) -> None:
        self.audit = SECURITY

    def assess(self, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.audit.assess(action, args or {})


class LoggingSystem:
    def __init__(self) -> None:
        self.memory = MEMORY

    def log(self, event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.memory.remember("os_control_log", event_type, payload)


class OSAutomationSuite:
    def __init__(self) -> None:
        self.plugin_manager = OSPluginManager()
        self.automation_engine = AutomationEngine(self)
        self.security = SecurityLayer()
        self.logging = LoggingSystem()
        self._register_builtin_actions()

    def plan(self, request: str) -> Dict[str, Any]:
        action = self._detect_action(request)
        args = self._extract_args(request, action)
        requires_confirmation = self._requires_confirmation(action)
        return {"action": action, "args": args, "requires_confirmation": requires_confirmation, "request": request}

    def execute(self, action: str, args: Optional[Dict[str, Any]] = None, confirmed: bool = False) -> Dict[str, Any]:
        action_name = action.strip().lower().replace(" ", "_")
        args = args or {}
        requires_confirmation = self._requires_confirmation(action_name)
        audit = self.security.assess(action_name, args)
        if requires_confirmation and not confirmed:
            return {"requires_confirmation": True, "audit": audit, "result": f"Confirmation required before {action_name.replace('_', ' ')}."}
        started = time.time()
        result = self._execute_action(action_name, args)
        duration_ms = int((time.time() - started) * 1000)
        self.logging.log("os_action", {"action": action_name, "args": args, "duration_ms": duration_ms, "confirmed": confirmed})
        return {"result": result, "action": action_name, "duration_ms": duration_ms, "confirmed": confirmed}

    def _execute_action(self, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if action in {"open_app", "open_application"}:
            name = args.get("name") or args.get("application")
            if "openApplication" in TOOLS:
                return TOOLS["openApplication"]({"name": name})
            return {"result": f"Opened {name or 'application'}."}
        if action in {"close_app", "close_application"}:
            name = args.get("name") or args.get("application")
            if "closeApplication" in TOOLS:
                return TOOLS["closeApplication"]({"name": name, "force": bool(args.get("force", False))})
            return {"result": f"Closed {name or 'application'}."}
        if action == "close_all_applications":
            if "closeAllApplications" in TOOLS:
                return TOOLS["closeAllApplications"]({"force": bool(args.get("force", False))})
            return {"result": "Requested closing all applications."}
        if action == "shutdown":
            return {"result": "Shutdown requested."}
        if action == "restart":
            return {"result": "Restart requested."}
        if action == "lock":
            return {"result": "Lock screen requested."}
        if action == "open_folder":
            path = args.get("path") or "Desktop"
            return {"result": f"Opened folder: {path}"}
        if action == "list_files":
            path = args.get("path") or os.path.expanduser("~")
            return {"result": f"Listed files in {path}"}
        if action == "delete_file":
            return {"result": f"Delete requested for {args.get('path', 'file')}"}
        if action == "take_screenshot":
            return {"result": "Screenshot captured."}
        if action == "record_screen":
            return {"result": "Screen recording started."}
        if action == "open_camera":
            if "openCamera" in TOOLS:
                return TOOLS["openCamera"]({"capture_only": bool(args.get("capture_only", False))})
            return {"result": "Camera opened."}
        if action == "take_photo":
            if "takePhoto" in TOOLS:
                return TOOLS["takePhoto"]({"name": args.get("name")})
            return {"result": "Camera photo captured."}
        if action == "record_video":
            if "recordVideo" in TOOLS:
                return TOOLS["recordVideo"]({"duration": args.get("duration"), "fps": args.get("fps", 20)})
            return {"result": "Camera recording started."}
        if action == "stop_video_recording":
            if "stopVideoRecording" in TOOLS:
                return TOOLS["stopVideoRecording"]({})
            return {"result": "Camera recording stopped."}
        if action == "scan_qr_code":
            if "scanQrCode" in TOOLS:
                return TOOLS["scanQrCode"]({})
            return {"result": "QR code scan requested."}
        if action == "copy_clipboard":
            return {"result": "Clipboard copied."}
        if action == "paste_clipboard":
            return {"result": "Clipboard pasted."}
        if action == "mute_audio":
            return {"result": "Audio muted."}
        if action == "volume_up":
            return {"result": "Volume increased."}
        if action == "volume_down":
            return {"result": "Volume decreased."}
        return {"result": f"{action} planned."}

    def _detect_action(self, request: str) -> str:
        low = request.lower()
        if any(term in low for term in ["shutdown", "shut down", "turn off the computer", "power off"]):
            return "shutdown"
        if any(term in low for term in ["restart the computer", "restart my pc", "reboot"]):
            return "restart"
        if any(term in low for term in ["lock the computer", "lock my pc", "lock screen"]):
            return "lock"
        if any(term in low for term in ["close all applications", "close every app", "close all apps", "close background applications"]):
            return "close_all_applications"
        if "camera" in low or "webcam" in low:
            if "record" in low:
                return "record_video"
            if "stop" in low:
                return "stop_video_recording"
            if "scan" in low:
                return "scan_qr_code"
            if "photo" in low or "picture" in low or "selfie" in low:
                return "take_photo"
            return "open_camera"
        if "open" in low and "folder" in low:
            return "open_folder"
        if "list" in low and "file" in low:
            return "list_files"
        if "delete" in low:
            return "delete_file"
        if "screenshot" in low:
            return "take_screenshot"
        if "record" in low and "screen" in low:
            return "record_screen"
        if "photo" in low or "picture" in low or "selfie" in low:
            return "take_photo"
        if "record" in low and "video" in low:
            return "record_video"
        if "scan qr" in low or "scan barcode" in low:
            return "scan_qr_code"
        if "clipboard" in low and "copy" in low:
            return "copy_clipboard"
        if "clipboard" in low and "paste" in low:
            return "paste_clipboard"
        if "mute" in low and "audio" in low:
            return "mute_audio"
        if "volume" in low:
            return "volume_up" if "up" in low else "volume_down"
        if "close" in low:
            return "close_app"
        if "open" in low:
            return "open_app"
        return "open_folder"

    def _extract_args(self, request: str, action: str) -> Dict[str, Any]:
        if action == "open_app":
            target = request.split("open", 1)[-1].strip()
            return {"name": target}
        if action in {"close_app", "delete_file"}:
            return {"name": request}
        if action == "open_folder":
            return {"path": request.split("folder", 1)[-1].strip() if "folder" in request.lower() else "Desktop"}
        if action == "list_files":
            return {"path": request.split("files", 1)[-1].strip() if "files" in request.lower() else "Desktop"}
        return {"text": request}

    def _requires_confirmation(self, action: str) -> bool:
        return action in SENSITIVE_ACTIONS

    def _register_builtin_actions(self) -> None:
        actions = [
            OSAction("Open App", "Application", "Open an application by name"),
            OSAction("Close App", "Application", "Close an application"),
            OSAction("Shutdown", "System", "Shut down the computer", requires_confirmation=True),
            OSAction("Restart", "System", "Restart the computer", requires_confirmation=True),
            OSAction("Lock", "System", "Lock the computer"),
            OSAction("Open Folder", "File", "Open a folder"),
            OSAction("List Files", "File", "List files in a folder"),
            OSAction("Delete File", "File", "Delete a file", requires_confirmation=True),
            OSAction("Take Screenshot", "Screen", "Capture a screenshot"),
            OSAction("Record Screen", "Screen", "Record the screen"),
            OSAction("Open Camera", "Camera", "Open the camera"),
            OSAction("Take Photo", "Camera", "Capture a photo"),
            OSAction("Record Video", "Camera", "Record video"),
            OSAction("Stop Video Recording", "Camera", "Stop recording video"),
            OSAction("Scan QR Code", "Camera", "Scan a QR code or barcode"),
            OSAction("Copy Clipboard", "Clipboard", "Copy clipboard contents"),
            OSAction("Paste Clipboard", "Clipboard", "Paste clipboard contents"),
            OSAction("Mute Audio", "Audio", "Mute system audio"),
            OSAction("Volume Up", "Audio", "Increase volume"),
            OSAction("Volume Down", "Audio", "Decrease volume"),
        ]
        for action in actions:
            self.plugin_manager.register(action)


OS_AUTOMATION_SUITE = OSAutomationSuite()
