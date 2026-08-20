"""
SARA Desktop Control Agent â€” Central tool registry.

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
from typing import Any, Awaitable, Callable, Dict, TypeVar, Union


class ToolError(Exception):
    """Raised by a tool handler to signal a clean, user-facing failure."""

    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


class State:
    """Process-wide shared state for tool handlers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Confirmation tokens for dangerous (power) actions.
        # token -> {"action": <tool_name>, "expires": <epoch>}
        self.confirmations: Dict[str, Dict[str, Any]] = {}
        # Playwright singletons â€” lazily initialized on first browser tool use.
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

# tool_name -> handler(args: dict) -> dict (sync or async)
ToolHandler = Callable[[Dict[str, Any]], Union[Dict[str, Any], Awaitable[Dict[str, Any]]]]
TOOLS: Dict[str, ToolHandler] = {}
HandlerT = TypeVar("HandlerT", bound=ToolHandler)


def register(name: str) -> Callable[[HandlerT], HandlerT]:
    """Decorator to register a handler under a tool name."""

    def deco(fn: HandlerT) -> HandlerT:
        TOOLS[name] = fn
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
]


# --- Eagerly import all tool modules so their @register decorators run. ---
# Each module is imported defensively: a hard import failure here would make
# the whole agent unstartable, which we want to avoid. The modules themselves
# keep optional-dependency imports lazy/try-except.
_MODULE_NAMES = [
    "tools_confirmation",
    "tools_applications",
    "tools_websites",
    "tools_search",
    "tools_youtube",
    "tools_files",
    "tools_file_extra",
    "tools_pc",
    "tools_windows",
    "tools_window_extra",
    "tools_clipboard",
    "tools_screenshot",
    "tools_camera",
    "tools_browser",
    "tools_coding",
    "tools_system",
    "tools_startup",
    "tools_multi_agent",
    "tools_platform",
    "tools_learning",
    "tools_service_integrations",
    "tools_screen_monitor",
    "tools_hardware",
    "tools_voice_os",
    "tools_camera_suite",
    "tools_app_suite",
    "tools_browser_suite",
    "android_tools",
]


def load_all() -> None:
    for mod_name in _MODULE_NAMES:
        importlib.import_module(f".{mod_name}", package="desktop_agent")


__all__ = ["TOOLS", "STATE", "DESKTOP_TOOL_NAMES", "ToolError", "register", "load_all"]



