"""
SARA Desktop Control Agent — Central tool registry.

Each tool module registers handlers into a flat dict `TOOLS` mapping
tool_name -> callable(args: dict) -> dict.

Handlers return a plain dict, typically {"result": "<status string>"}.
Errors should raise ToolError(message) so main.py can map them to {error}.
Shared singletons (Playwright browser/page, confirmation store, etc.) live
on the `State` object so handlers stay stateless and easy to test.
"""

from __future__ import annotations

import importlib
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


class ToolError(Exception):
    """Raised by a tool handler to signal a clean, user-facing failure."""

    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


@dataclass
class ToolDefinition:
    name: str
    description: str = ""
    input_schema: Dict[str, Any] = field(default_factory=dict)
    output_schema: Dict[str, Any] = field(default_factory=dict)
    permission_level: str = "LOW"
    risk_level: str = "LOW"
    supported_os: List[str] = field(default_factory=list)
    destructive: bool = False
    live_ui_verification: bool = False
    can_return_uncertain: bool = True
    execution_method: str = "registered_tool"
    verification_method: str = "semantic_result_check"
    timeout: int = 30000
    retry_policy: str = "retry_on_transient"
    rollback_policy: str = "none"
    tags: List[str] = field(default_factory=list)


class ToolRegistry:
    """Central catalog of SARA capabilities and permission metadata."""

    def __init__(self) -> None:
        self.tools: Dict[str, Dict[str, Any]] = {}

    def register(self, name: str, description: str = "", **overrides: Any) -> Dict[str, Any]:
        metadata = {
            "name": name,
            "description": description or f"Registered SARA capability: {name}",
            "input_schema": {"type": "object", "properties": {}},
            "output_schema": {"type": "object", "properties": {"result": {"type": "string"}}},
            "permission_level": "LOW",
            "risk_level": "LOW",
            "supported_os": [],
            "destructive": False,
            "live_ui_verification": False,
            "can_return_uncertain": True,
            "execution_method": "registered_tool",
            "verification_method": "semantic_result_check",
            "timeout": 30000,
            "retry_policy": "retry_on_transient",
            "rollback_policy": "none",
            "tags": [],
        }
        metadata.update(self.tools.get(name, {}))
        metadata.update(overrides)
        metadata["name"] = name
        if "description" not in overrides:
            metadata["description"] = description or metadata.get("description") or f"Registered SARA capability: {name}"
        self.tools[name] = metadata
        return dict(metadata)

    def get(self, name: str) -> Optional[Dict[str, Any]]:
        return self.tools.get(name)

    def list(self) -> List[Dict[str, Any]]:
        return [dict(item) for item in self.tools.values()]

    def is_allowed(self, tool_name: str, args: Optional[Dict[str, Any]] = None) -> bool:
        tool = self.get(tool_name)
        if tool is None:
            return False
        risk = str(tool.get("risk_level") or "LOW").upper()
        permission = str(tool.get("permission_level") or "LOW").upper()
        payload = dict(args or {})
        confirmed = bool(payload.get("confirmed") or payload.get("confirmation") or payload.get("token") or payload.get("execute_token"))
        action_name = str(payload.get("action") or "").lower()
        high_risk_actions = {"shutdown", "restart", "sleep", "hibernate", "delete", "wipe", "format", "send_external_message", "send_email", "purchase", "financial_transaction"}

        # openApplication is non-destructive — allow freely.
        # closeApplication and requestPowerAction require confirmation because
        # closing an app can lose unsaved work and power actions are irreversible.
        if tool_name in {"closeApplication", "requestPowerAction"} and not confirmed:
            return False

        if risk in {"HIGH", "CRITICAL"} and not confirmed:
            return False
        if permission == "HIGH" and not confirmed and action_name in high_risk_actions:
            return False
        if tool_name in {"requestPowerAction", "executePowerAction", "deleteFile", "deleteFolder", "closeAllApplications", "power_shutdown", "power_restart", "power_sleep", "power_lock"}:
            if action_name in {"shutdown", "restart", "sleep", "hibernate", "lock", "delete", "wipe", "format"} and not confirmed:
                return False
        return True

    def bootstrap_from_module_registry(self) -> Dict[str, Dict[str, Any]]:
        for name in sorted(TOOLS):
            self.register(name, description=f"Registered SARA desktop capability: {name}", tags=["desktop"])
        return self.tools


class State:
    """Process-wide shared state for tool handlers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Confirmation tokens for dangerous (power) actions.
        # token -> {"action": <tool_name>, "expires": <epoch>}
        self.confirmations: Dict[str, Dict[str, Any]] = {}
        # Playwright singletons — lazily initialized on first browser tool use.
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None

    def reset_playwright(self) -> None:
        """Tear down any cached Playwright resources (used on errors)."""
        try:
            if self.page is not None:
                self.page = None
            if self.context is not None:
                self.context = None
            if self.browser is not None:
                self.browser = None
            if self.playwright is not None:
                self.playwright = None
        except Exception:
            pass


STATE = State()

# tool_name -> handler(args: dict) -> dict
TOOLS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}
TOOL_REGISTRY = ToolRegistry()


def register(name: str, *, description: str = "", **metadata: Any):
    """Decorator to register a handler under a tool name."""

    def deco(fn: Callable[[Dict[str, Any]], Dict[str, Any]]):
        TOOLS[name] = fn
        TOOL_REGISTRY.register(name, description=description or getattr(fn, "__doc__", "") or f"Registered SARA capability: {name}", **metadata)
        return fn

    return deco


# The set of all tool names SARA may route to this agent.
# Kept in sync with the functionDeclarations added in server.ts.
DESKTOP_TOOL_NAMES = [
    # applications / websites / search
    "openApplication",
    "closeApplication",
    "openAnyApplication",
    "closeAnyApplication",
    "openWebsite",
    "searchWeb",
    "searchYouTube",
    "searchGoogle",
    "searchGitHub",
    # files
    "createFile",
    "readFile",
    "renameFile",
    "deleteFile",
    "moveFile",
    "copyFile",
    "duplicateFile",
    "createFolder",
    "compressPath",
    "extractZip",
    "openPath",
    "openFolder",
    "listFiles",
    "searchFiles",
    # pc control (volume + gated power)
    "volumeUp",
    "volumeDown",
    "muteToggle",
    "setVolume",
    "requestPowerAction",  # first step: issues a confirmation token
    "executePowerAction",  # second step: runs the gated action
    # windows
    "minimizeWindow",
    "maximizeWindow",
    "closeWindow",
    "switchApplication",
    "restoreWindow",
    "showDesktop",
    "restartExplorer",
    "turnOffDisplay",
    "listRunningApplications",
    "closeAllApplications",
    # clipboard
    "copySelected",
    "pasteClipboard",
    "getClipboard",
    "clearClipboard",
    # screenshot / screen reading
    "takeScreenshot",
    "saveScreenshot",
    "analyzeScreenshot",
    "readScreen",
    "detectUiElements",
    "desktopInspectScreen",
    "desktopFindElement",
    "desktopFindElements",
    "desktopClickTarget",
    "desktopDoubleClickTarget",
    "desktopRightClickTarget",
    "desktopMoveToTarget",
    "desktopDragTarget",
    "desktopFocusTarget",
    "desktopTypeIntoTarget",
    # camera
    "openCamera",
    "takePhoto",
    "recordVideo",
    "stopVideoRecording",
    "scanQrCode",
    "saveCapturedPhoto",
    "showCapturedMedia",
    "saraCameraOpen",
    "saraCameraTakePhoto",
    "saraCameraRecordVideo",
    "saraCameraStopRecording",
    "saraCameraScanQr",
    "saraCameraObserve",
    # gesture control
    "gestureControlStart",
    "gestureControlStop",
    "gestureControlPause",
    "gestureControlResume",
    "gestureControlStatus",
    "gestureControlCalibrate",
    "gestureControlSetMapping",
    "gestureControlSetMonitor",
    "gestureControlSetSensitivity",
    "gestureControlSetThresholds",
    "gestureControlGetConfig",
    "gestureControlSetConfig",
    "gestureControlGetMappings",
    "gestureControlSetMappings",
    "gestureControlEnable",
    "gestureControlDisable",
    "gestureControlSetProfile",
    # browser automation (Playwright â€” desktop-owned, separate from holographic UI)
    "desktopBrowserOpen",
    "desktopBrowserNavigate",
    "desktopBrowserOpenTab",
    "desktopBrowserCloseTab",
    "desktopBrowserSearch",
    "desktopBrowserClick",
    "desktopBrowserType",
    "desktopBrowserFillForm",
    "desktopBrowserGoBack",
    "desktopBrowserGoForward",
    "desktopBrowserScroll",
    "desktopBrowserReload", "desktopBrowserKey", "desktopBrowserZoom",
    "desktopBrowserMedia", "desktopBrowserReadPage", "desktopBrowserScreenshot",
    "browserOpen",
    "browserSearch",
    "browserClick",
    "browserType",
    "browserScroll",
    "browserGoBack",
    "browserMediaControl",
    "browserTabAction",
    # coding assistance
    "createPythonFile",
    "runPythonScript",
    "createProjectFolder",
    "writeCodeFile",
    # system information
    "systemInfo",
    "gpuInfo",
    "temperatureInfo",
    # brightness control (V2)
    "brightnessUp",
    "brightnessDown",
    "setBrightness",
    # Windows auto-start management (V2)
    "enableAutoStart",
    "disableAutoStart",
    "getAutoStartStatus",
    # SARA master-orchestrator / multi-agent runtime
    "saraAgentExecute",
    "saraAgentStatus",
    "saraAgentUnloadIdle",
    "saraAgentEmergencyStop",
    # Local-first AI OS platform services
    "saraMemoryRemember",
    "saraMemorySearch",
    "saraMemorySync",
    "saraMemoryExport",
    "saraMemoryFlush",
    "saraMemoryForget",
    "saraMemoryConsolidate",
    "saraRagIndex",
    "saraRagRetrieve",
    "saraRagRemoveDeleted",
    "saraRagSync",
    "saraRagExport",
    "saraGoalCreate",
    "saraGoalUpdate",
    "saraGoalCheckpoint",
    "saraGoalList",
    "saraGoalGet",
    "saraKnowledgeAdd",
    "saraKnowledgeQuery",
    "saraRecoverySave",
    "saraRecoveryLatest",
    "saraLearningTeach",
    "saraLearningList",
    "saraLearningMatch",
    "saraLearningForget",
    "saraExperienceRecord",
    "saraExperienceList",
    "saraExperienceInsights",
    "saraEvolutionPropose",
    "saraEvolutionList",
    "saraEvolutionApprove",
    "saraEvolutionReject",
    "saraKnowledgeIngest",
    "saraKnowledgeValidate",
    "saraKnowledgeSourceList",
    "saraHealthRun",
    "saraHealthLatest",
    "saraRlRecord",
    "saraRlSummary",
    "saraRlConfigureRewards",
    "saraStrategyBest",
    "saraWorkflowSave",
    "saraWorkflowList",
    "saraSkillSave",
    "saraSkillMatch",
    "saraSkillList",
    "saraPluginDiscover",
    "saraSecurityAssess",
    "saraCredentialStore",
    "saraCredentialLoad",
    "saraCredentialList",
    "saraCredentialRemove",
    "saraScheduleJob",
    "saraRunDueJobs",
    "saraDueJobs",
    "saraServiceList",
    "saraServiceConnect",
    "saraServiceSession",
    "saraServiceExecute",
    # Real hardware input control
    "hardwareMouseMove",
    "hardwareMouseClick",
    "hardwareMouseDrag",
    "hardwareMouseScroll",
    "hardwareMousePosition",
    "hardwareKeyboardType",
    "hardwareKeyboardPress",
    "hardwareKeyboardHold",
    "hardwareKeyboardRelease",
    "hardwareMacroReplay",
    # High-level voice command routing / training
    "saraVoiceParseCommand",
    "saraVoiceExecuteCommand",
    "saraVoiceTrainCommand",
    "saraVoiceStopSpeaking",
    "saraCompanionSuggestNext",
    # Screen monitoring
    "saraScreenMonitorStart",
    "saraScreenMonitorStop",
    "saraScreenMonitorStatus",
    "saraScreenMonitorSample",
    "saraScreenLiveStart",
    "saraScreenLiveStop",
    "saraScreenLiveStatus",
    # Application Automation Suite
    "saraAppListPlugins",
    "saraAppPlan",
    "saraAppExecute",
    "saraAppExecuteGoal",
    # Browser Automation Suite
    "saraBrowserPlan",
    "saraBrowserExecute",
    "saraBrowserExecuteGoal",
    # Android Companion Suite
    "saraAndroidPair",
    "saraAndroidPlan",
    "saraAndroidExecute",
    # Email Automation
    "email_send",
    "email_read",
    "email_search",
    "email_draft",
    "email_reply",
    "email_forward",
    "email_create_task_from_email",
    "email_schedule_send",
    # WhatsApp Extra Capabilities
    "whatsapp_read_messages",
    "whatsapp_reply",
    "whatsapp_send_media",
    "whatsapp_group_send",
    "whatsapp_schedule_send",
    "whatsapp_resolve_contact",
    # YouTube Extra Capabilities
    "youtube_pause",
    "youtube_resume",
    "youtube_seek",
    "youtube_volume",
    "youtube_fullscreen",
    "youtube_captions",
    "youtube_get_info",
    "youtube_add_to_watch_later",
    "youtube_upload",
    # RAG ingestion (tools_rag.py)
    "saraRagIngestDocument",
    "saraRagIndexFolder",
    # Universal Command Center
    "saraUniversalCommand",
]


# --- Auto-discover tool modules so new tools are registered without editing a fixed list. ---
# Keep the discovery deterministic by scanning the desktop_agent package for modules that
# match the tools_* naming pattern and importing only those modules.
def _discover_tool_modules() -> List[str]:
    import pkgutil
    from pathlib import Path

    package_path = Path(__file__).resolve().parent
    discovered: List[str] = []
    for module_info in sorted(pkgutil.iter_modules([str(package_path)]), key=lambda item: item.name):
        name = module_info.name
        if not name.startswith("tools_") and name != "android_tools":
            continue
        if name.startswith("tools_") or name == "android_tools":
            discovered.append(name)
    return discovered


def load_all() -> None:
    discovered = _discover_tool_modules()
    imported = []
    failed = []
    try:
        importlib.import_module(".capability_matrix", package="desktop_agent")
    except Exception as exc:  # pragma: no cover - keep agent alive
        failed.append("capability_matrix")
        print(f"[SARA][TOOLS][ERROR] Failed to load capability_matrix: {exc}")
    for mod_name in discovered:
        try:
            importlib.import_module(f".{mod_name}", package="desktop_agent")
            imported.append(mod_name)
        except Exception as exc:  # pragma: no cover - keep agent alive even if one module fails
            failed.append(mod_name)
            print(f"[SARA][TOOLS][ERROR] Failed to load {mod_name}: {exc}")

    TOOL_REGISTRY.bootstrap_from_module_registry()
    registered = len(TOOL_REGISTRY.tools)
    print(f"[SARA][TOOLS] Discovered: {len(discovered)}")
    print(f"[SARA][TOOLS] Registered: {registered}")
    print(f"[SARA][TOOLS] Failed: {len(failed)}")
    if failed:
        print(f"[SARA][TOOLS][ERROR] Failed modules: {', '.join(failed)}")


__all__ = ["TOOLS", "STATE", "DESKTOP_TOOL_NAMES", "ToolError", "ToolDefinition", "ToolRegistry", "TOOL_REGISTRY", "register", "load_all"]

