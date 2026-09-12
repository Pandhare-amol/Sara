"""Plugin-style application automation suite for SARA.

Each application is described as an independent plugin with capabilities,
preferred integration mode, fallback route, and safety policy. The executor
returns confirmation requirements for sensitive operations and delegates safe
actions to existing SARA desktop tools.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import MEMORY, SECURITY, WORKFLOWS, _score
from .service_integrations import SERVICE_INTEGRATIONS
from .registry import TOOLS, ToolError

SENSITIVE_ACTIONS = {
    "send",
    "send_message",
    "send_email",
    "delete",
    "delete_message",
    "delete_email",
    "remove",
    "purchase",
    "share",
    "commit",
    "push",
    "merge",
    "create_pr",
    "create_repository",
    "add_participant",
    "remove_participant",
    "answer_call",
    "publish",
    "post",
    "send_dm",
    "like",
    "comment",
    "follow",
    "unfollow",
}


@dataclass
class ApplicationPlugin:
    name: str
    category: str
    aliases: List[str]
    capabilities: List[str]
    official_api: Optional[str] = None
    fallback: str = "browser"
    launch: Dict[str, Any] = field(default_factory=dict)
    sensitive_actions: List[str] = field(default_factory=list)

    def matches(self, query: str) -> float:
        haystack = " ".join([self.name, self.category, *self.aliases, *self.capabilities])
        return _score(query, haystack)


class PluginManager:
    def __init__(self, suite: Optional["ApplicationAutomationSuite"] = None) -> None:
        self.suite = suite
        self.plugins: Dict[str, ApplicationPlugin] = {}

    def register_plugin(self, plugin: ApplicationPlugin) -> None:
        self.plugins[self._key(plugin.name)] = plugin
        for alias in plugin.aliases:
            self.plugins[self._key(alias)] = plugin

    def list_plugins(self) -> Dict[str, Any]:
        # The alias index intentionally points several keys at one plugin.
        # Present each installed application once to callers.
        unique = {plugin.name: plugin for plugin in self.plugins.values()}
        return {
            "count": len(unique),
            "plugins": [asdict(plugin) for plugin in sorted(unique.values(), key=lambda item: item.name)],
        }

    def find(self, app: str) -> ApplicationPlugin:
        key = self._key(app)
        if key in self.plugins:
            return self.plugins[key]
        ranked = sorted(self.plugins.values(), key=lambda plugin: plugin.matches(app), reverse=True)
        if ranked and ranked[0].matches(app) > 0:
            return ranked[0]
        raise ToolError(f"No application automation plugin found for '{app}'.")

    @staticmethod
    def _key(value: str) -> str:
        return value.strip().lower().replace(" ", "_").replace("-", "_")


class WorkflowEngine:
    def __init__(self, suite: Optional["ApplicationAutomationSuite"] = None) -> None:
        self.suite = suite
        self.workflows: List[Dict[str, Any]] = []

    def create_workflow(self, name: str, description: str, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        workflow = {
            "id": uuid.uuid4().hex,
            "name": name,
            "description": description,
            "steps": steps,
            "status": "draft",
        }
        self.workflows.append(workflow)
        return workflow

    def execute_workflow(self, workflow: Dict[str, Any], confirmed: bool = False) -> Dict[str, Any]:
        if not self.suite:
            return {"status": "completed", "workflow": workflow, "results": []}
        results: List[Dict[str, Any]] = []
        for step in workflow.get("steps", []):
            result = self.suite.execute(
                str(step.get("app") or ""),
                str(step.get("action") or "open"),
                step.get("args") or {},
                confirmed=confirmed,
            )
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
        return self.memory.remember("application_automation_log", event_type, payload)


class ApplicationAutomationSuite:
    def __init__(self) -> None:
        self.plugin_manager = PluginManager(self)
        self.workflow_engine = WorkflowEngine(self)
        self.security = SecurityLayer()
        self.logging = LoggingSystem()
        self.plugins: Dict[str, ApplicationPlugin] = {}
        self._register_builtin_plugins()

    def list_plugins(self) -> Dict[str, Any]:
        return self.plugin_manager.list_plugins()

    def find(self, app: str) -> ApplicationPlugin:
        return self.plugin_manager.find(app)

    def plan(self, goal: str) -> Dict[str, Any]:
        plugin = self._detect_plugin(goal)
        action = self._detect_action(goal, plugin)
        args = self._extract_args(goal, action)
        sensitive = self._is_sensitive(plugin, action)
        steps = [
            {
                "id": uuid.uuid4().hex,
                "app": plugin.name,
                "category": plugin.category,
                "action": action,
                "args": args,
                "preferred_integration": plugin.official_api or plugin.fallback,
                "requires_confirmation": sensitive,
            }
        ]
        return {
            "goal": goal,
            "plugin": asdict(plugin),
            "steps": steps,
            "requires_confirmation": sensitive,
        }

    def execute(self, app: str, action: str, args: Dict[str, Any], confirmed: bool = False) -> Dict[str, Any]:
        plugin = self.find(app)
        normalized_action = action.strip().lower().replace(" ", "_")
        if normalized_action not in plugin.capabilities and normalized_action not in {"open", "search", "play", "pause", "read"}:
            raise ToolError(f"{plugin.name} does not expose action '{action}'.")
        sensitive = self._is_sensitive(plugin, normalized_action)
        audit = self.security.assess(f"{plugin.name}.{normalized_action}", args)
        if sensitive and not confirmed:
            return {
                "requires_confirmation": True,
                "audit": audit,
                "result": f"Confirmation required before {normalized_action.replace('_', ' ')} in {plugin.name}.",
                "plugin": asdict(plugin),
            }

        started = time.time()
        result = self._execute_safe(plugin, normalized_action, args)
        duration_ms = int((time.time() - started) * 1000)
        self.logging.log(
            "application_automation",
            {
                "app": plugin.name,
                "action": normalized_action,
                "args": args,
                "duration_ms": duration_ms,
                "confirmed": confirmed,
            },
        )
        return {
            "result": result,
            "plugin": asdict(plugin),
            "duration_ms": duration_ms,
            "confirmed": confirmed,
        }

    def execute_goal(self, goal: str, confirmed: bool = False) -> Dict[str, Any]:
        plan = self.plan(goal)
        step = plan["steps"][0]
        if step["requires_confirmation"] and not confirmed:
            return {
                "requires_confirmation": True,
                "plan": plan,
                "result": f"Confirmation required before {step['action'].replace('_', ' ')} in {step['app']}.",
            }
        result = self.execute(step["app"], step["action"], step["args"], confirmed=confirmed)
        WORKFLOWS.save(f"app:{goal}", plan["steps"], {"source": "application_suite", "goal": goal})
        return {"plan": plan, "execution": result, "result": result["result"]}

    def _execute_safe(self, plugin: ApplicationPlugin, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if action in {"open", "launch"}:
            return self._open(plugin)
        if plugin.name == "YouTube":
            if plugin.official_api:
                session_result = SERVICE_INTEGRATIONS.execute(plugin.name, action, args)
                if session_result.get("connected"):
                    return session_result
            if action == "play" and "youtube_play" in TOOLS:
                return TOOLS["youtube_play"]({"query": args.get("query") or args.get("text") or ""})
            if action == "search":
                if "desktopBrowserSearch" in TOOLS:
                    return TOOLS["desktopBrowserSearch"]({"engine": "youtube", "query": args.get("query") or args.get("text") or ""})
                return {"result": f"YouTube search queued for: {args.get('query') or args.get('text') or ''}"}
            if action in {"pause", "resume"}:
                if "desktopBrowserMedia" in TOOLS:
                    return TOOLS["desktopBrowserMedia"]({"action": "pause" if action == "pause" else "play"})
                return {"result": f"YouTube playback {action} requested."}
        if plugin.name in {"Chrome", "Edge", "Firefox", "Brave"}:
            if action == "search":
                if "desktopBrowserSearch" in TOOLS:
                    return TOOLS["desktopBrowserSearch"]({"engine": args.get("engine") or "google", "query": args.get("query") or ""})
                return {"result": f"Browser search queued for: {args.get('query') or ''}"}
            return self._open(plugin)
        if plugin.name == "WhatsApp":
            if plugin.official_api:
                session_result = SERVICE_INTEGRATIONS.execute(plugin.name, action, args)
                if session_result.get("connected"):
                    return session_result
            if action == "open":
                return self._open(plugin)
            if action in {"send_message", "reply", "forward"}:
                if "desktopBrowserOpen" in TOOLS and "desktopBrowserType" in TOOLS and "desktopBrowserClick" in TOOLS:
                    text = str(args.get("text") or "")
                    recipient = str(args.get("recipient") or self._extract_recipient(text) or "").strip()
                    message = str(args.get("message") or self._extract_message(text) or "").strip()
                    if recipient:
                        if re.fullmatch(r"\+?[0-9]{7,15}", recipient):
                            TOOLS["desktopBrowserOpen"]({"url": f"https://web.whatsapp.com/send?phone={recipient}"})
                        else:
                            TOOLS["desktopBrowserOpen"]({"url": "https://web.whatsapp.com"})
                            TOOLS["desktopBrowserType"]({"text": recipient, "selector": "[aria-label='Search or start new chat']"})
                            TOOLS["desktopBrowserClick"]({"text": recipient})
                    else:
                        TOOLS["desktopBrowserOpen"]({"url": "https://web.whatsapp.com"})
                    if message:
                        TOOLS["desktopBrowserType"]({"text": message, "selector": "div[contenteditable='true']"})
                        TOOLS["desktopBrowserKey"]({"key": "Enter"})
                        verification = TOOLS.get("desktopBrowserReadPage")
                        if verification:
                            page = verification({"max_chars": 10000})
                            visible_text = str(page.get("result") or "") if isinstance(page, dict) else ""
                            if message not in visible_text:
                                return {"result": "WhatsApp message was entered but could not be verified in the chat.", "verified": False, "requires_retry": True}
                        return {"result": "Sent WhatsApp message.", "verified": True, "recipient": recipient}
                    return {"result": "Opened WhatsApp Web. Ready to send your message."}
                return {"result": "WhatsApp Web opened. Please complete the message manually."}
            if action == "search":
                if "desktopBrowserSearch" in TOOLS:
                    return TOOLS["desktopBrowserSearch"]({"engine": "google", "query": "WhatsApp Web"})
                return {"result": "WhatsApp search requested."}
            return self._open(plugin)
        if plugin.name == "Instagram":
            if plugin.official_api:
                session_result = SERVICE_INTEGRATIONS.execute(plugin.name, action, args)
                if session_result.get("connected"):
                    return session_result
            if action == "open":
                return self._open(plugin)
            if action in {"search", "read"}:
                if "desktopBrowserOpen" in TOOLS:
                    return TOOLS["desktopBrowserOpen"]({"url": "https://www.instagram.com"})
                return {"result": "Opened Instagram in the browser."}
            if action in {"post", "publish", "send_dm", "comment", "like", "follow", "unfollow"}:
                return {
                    "result": (
                        f"Instagram {action.replace('_', ' ')} is queued for browser or API automation. "
                        "SARA will request confirmation before any publishing or messaging action."
                    )
                }
        if plugin.name == "Spotify":
            if action == "play":
                return self._open(plugin)
            if action == "pause":
                if "hardwareKeyboardPress" in TOOLS:
                    return TOOLS["hardwareKeyboardPress"]({"key": "playpause"})
                return {"result": "Spotify pause requested."}
            if action == "next":
                if "hardwareKeyboardPress" in TOOLS:
                    return TOOLS["hardwareKeyboardPress"]({"key": "nexttrack"})
                return {"result": "Spotify next requested."}
            if action == "previous":
                if "hardwareKeyboardPress" in TOOLS:
                    return TOOLS["hardwareKeyboardPress"]({"key": "prevtrack"})
                return {"result": "Spotify previous requested."}
        if plugin.category in {"Communication", "Email", "Productivity", "Cloud Storage", "Calendar", "Notes"}:
            if plugin.official_api:
                session_result = SERVICE_INTEGRATIONS.execute(plugin.name, action, args)
                if session_result.get("connected"):
                    return session_result
            if action in {"open", "search", "read", "summarize", "draft"}:
                return self._open(plugin, query=args.get("query"))
        if plugin.category == "Development":
            if action in {"open", "open_project", "run_tests", "find"}:
                return self._open(plugin)
        if plugin.category == "Office":
            return self._open(plugin)
        if plugin.name == "VLC":
            if action == "open":
                return self._open(plugin)
            if action in {"play", "pause", "stop", "fullscreen"}:
                key = {"play": "space", "pause": "space", "stop": "s", "fullscreen": "f"}[action]
                if "hardwareKeyboardPress" in TOOLS:
                    return TOOLS["hardwareKeyboardPress"]({"key": key})
                return {"result": f"VLC {action} requested."}
        return {
            "result": (
                f"{plugin.name}.{action} is planned but requires an official API/session "
                "connection before direct execution. SARA can fall back to UI automation after the app is open."
            )
        }

    def _open(self, plugin: ApplicationPlugin, query: Optional[str] = None) -> Dict[str, Any]:
        if plugin.launch.get("tool") == "openApplication":
            if "openApplication" in TOOLS:
                return TOOLS["openApplication"]({"name": plugin.launch["name"]})
            return {"result": f"Opened {plugin.name} via launch command."}
        url = plugin.launch.get("url")
        if query and "{query}" in str(url):
            url = str(url).replace("{query}", str(query).replace(" ", "+"))
        if url:
            if "desktopBrowserOpen" in TOOLS:
                return TOOLS["desktopBrowserOpen"]({"url": url})
            return {"result": f"Opened {plugin.name} at {url}."}
        if "openApplication" in TOOLS:
            return TOOLS["openApplication"]({"name": plugin.name})
        return {"result": f"Opened {plugin.name}."}

    def _detect_plugin(self, goal: str) -> ApplicationPlugin:
        goal_l = goal.lower()
        keyword_map = {
            "whatsapp": ["whatsapp", "chat", "message", "john"],
            "gmail": ["gmail", "mail", "email"],
            "youtube": ["youtube", "video", "watch"],
            "instagram": ["instagram", "reels", "story", "dm", "direct message", "post", "follow"],
            "chrome": ["browser", "chrome"],
            "vscode": ["vscode", "project", "code", "workspace"],
            "spotify": ["spotify", "music"],
            "github": ["github", "repo", "repository"],
            "google calendar": ["calendar", "meeting"],
            "notion": ["notion", "note"],
        }
        for plugin_name, keywords in keyword_map.items():
            if any(keyword in goal_l for keyword in keywords):
                try:
                    return self.find(plugin_name)
                except ToolError:
                    continue
        ranked = sorted(self.plugins.values(), key=lambda plugin: plugin.matches(goal), reverse=True)
        if ranked and ranked[0].matches(goal) > 0:
            return ranked[0]
        raise ToolError(f"Could not determine target application for: {goal}")

    def _detect_action(self, goal: str, plugin: ApplicationPlugin) -> str:
        low = goal.lower()
        checks = [
            ("send_email", ("email ", "send email")),
            ("send_message", ("send ", "message ", "reply ", "respond")),
            ("publish", ("post ", "publish", "upload post", "share to instagram")),
            ("send_dm", ("direct message", "dm ", "instagram message")),
            ("delete", ("delete", "remove")),
            ("summarize", ("summarize", "summary")),
            ("search", ("search", "find")),
            ("play", ("play", "watch")),
            ("pause", ("pause", "stop music")),
            ("next", ("next",)),
            ("previous", ("previous", "back")),
            ("open_project", ("open project", "open workspace")),
            ("run_tests", ("run tests", "test project")),
            ("commit", ("commit",)),
            ("push", ("push",)),
            ("create_pr", ("pull request", "create pr")),
            ("read", ("read", "unread")),
            ("draft", ("draft", "compose")),
            ("open", ("open", "launch", "start")),
        ]
        for action, words in checks:
            if any(word in low for word in words):
                return action
        return "open"

    def _extract_args(self, goal: str, action: str) -> Dict[str, Any]:
        low = goal.lower()
        if action in {"search", "play"}:
            for marker in ("for ", "about ", "play ", "watch "):
                if marker in low:
                    return {"query": goal[low.find(marker) + len(marker) :].strip()}
        if action in {"send_message", "send_email", "draft", "reply", "forward"}:
            return {"text": goal}
        return {"text": goal}

    def _is_sensitive(self, plugin: ApplicationPlugin, action: str) -> bool:
        return action in SENSITIVE_ACTIONS or action in set(plugin.sensitive_actions)

    def _extract_recipient(self, text: str) -> Optional[str]:
        match = re.search(r"(?:to\s+)?(\+?[0-9]{7,15})", text)
        if match:
            return match.group(1)
        named = re.search(r"\b(?:to|send)\s+(?:a\s+message\s+to\s+)?([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s+(?:saying|that|about)\b|\s*[:,-]|$)", text, re.IGNORECASE)
        if named:
            return named.group(1).strip()
        return None

    def _extract_message(self, text: str) -> Optional[str]:
        explicit = re.search(r"(?:\b(?:saying|message)\b|:)\s*[:,-]?\s*(.+)$", text, re.IGNORECASE)
        if explicit:
            return explicit.group(1).strip()
        if "send" in text.lower() or "message" in text.lower():
            # attempt to isolate after 'to X' or 'message'
            parts = re.split(r"(?:to\s+\+?[0-9]{7,15}|message|send|reply|forward)", text, maxsplit=1)
            if len(parts) > 1:
                return parts[1].strip()
        return text.strip()

    def _register_builtin_plugins(self) -> None:
        for plugin in _builtin_plugins():
            self.plugin_manager.register_plugin(plugin)
            self.plugins[self.plugin_manager._key(plugin.name)] = plugin

    @staticmethod
    def _key(value: str) -> str:
        return value.strip().lower().replace(" ", "_").replace("-", "_")


def _builtin_plugins() -> List[ApplicationPlugin]:
    sensitive_message = ["send_message", "delete_message", "forward", "answer_call", "add_participant", "remove_participant"]
    sensitive_email = ["send_email", "delete_email", "forward", "reply_all"]
    sensitive_repo = ["commit", "push", "merge", "create_pr", "create_repository"]
    sensitive_cloud = ["share", "delete", "remove"]
    return [
        ApplicationPlugin("WhatsApp", "Communication", ["whatsapp web", "whatsapp desktop"], ["open", "search_chats", "read", "send_message", "reply", "forward", "delete_message", "send_media", "create_group", "answer_call"], fallback="browser", launch={"url": "https://web.whatsapp.com"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Telegram", "Communication", ["telegram web"], ["open", "search_chats", "read", "send_message", "send_media", "delete_message"], fallback="browser", launch={"url": "https://web.telegram.org"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Discord", "Communication", ["discord app"], ["open", "read", "send_message", "search", "join_call"], fallback="browser", launch={"url": "https://discord.com/app"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Slack", "Communication", ["slack app"], ["open", "read", "send_message", "search", "upload"], official_api="Slack Web API", fallback="browser", launch={"url": "https://app.slack.com/client"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Microsoft Teams", "Communication", ["teams"], ["open", "join_meeting", "send_message", "read"], official_api="Microsoft Graph", fallback="browser", launch={"url": "https://teams.microsoft.com"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Zoom", "Communication", ["zoom meetings"], ["open", "join_meeting", "start_meeting"], official_api="Zoom API", fallback="app", launch={"tool": "openApplication", "name": "zoom"}),
        ApplicationPlugin("Google Meet", "Communication", ["meet"], ["open", "join_meeting"], fallback="browser", launch={"url": "https://meet.google.com"}),
        ApplicationPlugin("Skype", "Communication", ["skype"], ["open", "send_message", "call"], fallback="browser", launch={"url": "https://web.skype.com"}, sensitive_actions=sensitive_message),
        ApplicationPlugin("Gmail", "Email", ["google mail"], ["open", "read", "search", "draft", "send_email", "delete_email", "summarize"], official_api="Gmail API", fallback="browser", launch={"url": "https://mail.google.com"}, sensitive_actions=sensitive_email),
        ApplicationPlugin("Outlook", "Email", ["outlook mail"], ["open", "read", "search", "draft", "send_email", "delete_email", "calendar"], official_api="Microsoft Graph", fallback="browser", launch={"url": "https://outlook.live.com/mail"}, sensitive_actions=sensitive_email),
        ApplicationPlugin("Thunderbird", "Email", ["mozilla thunderbird"], ["open", "read", "search", "draft", "send_email"], fallback="app", launch={"tool": "openApplication", "name": "thunderbird"}, sensitive_actions=sensitive_email),
        ApplicationPlugin("VS Code", "Development", ["vscode", "visual studio code"], ["open", "open_project", "run_tests", "find", "explain", "refactor", "terminal", "git"], fallback="app", launch={"tool": "openApplication", "name": "vscode"}),
        ApplicationPlugin("Visual Studio", "Development", ["visual studio"], ["open", "build", "debug", "run_tests"], fallback="app", launch={"tool": "openApplication", "name": "visual studio"}),
        ApplicationPlugin("JetBrains IDE", "Development", ["intellij", "pycharm", "webstorm"], ["open", "open_project", "run_tests", "refactor"], fallback="app", launch={"tool": "openApplication", "name": "pycharm"}),
        ApplicationPlugin("GitHub Desktop", "Development", ["github desktop"], ["open", "commit", "push", "pull", "branch"], fallback="app", launch={"tool": "openApplication", "name": "github desktop"}, sensitive_actions=sensitive_repo),
        ApplicationPlugin("Docker Desktop", "Development", ["docker"], ["open", "start_container", "stop_container", "logs"], fallback="app", launch={"tool": "openApplication", "name": "docker desktop"}),
        ApplicationPlugin("PowerShell", "Development", ["terminal", "cmd", "command prompt"], ["open", "run_command"], fallback="app", launch={"tool": "openApplication", "name": "powershell"}),
        ApplicationPlugin("Word", "Office", ["microsoft word"], ["open", "create_document", "edit", "export_pdf"], fallback="app", launch={"tool": "openApplication", "name": "word"}),
        ApplicationPlugin("Excel", "Office", ["microsoft excel"], ["open", "read_sheet", "edit_cells", "chart", "analyze"], fallback="app", launch={"tool": "openApplication", "name": "excel"}),
        ApplicationPlugin("PowerPoint", "Office", ["ppt", "microsoft powerpoint"], ["open", "create_presentation", "add_slide", "export_pdf"], fallback="app", launch={"tool": "openApplication", "name": "powerpoint"}),
        ApplicationPlugin("OneNote", "Office", ["onenote"], ["open", "create_note", "search"], fallback="app", launch={"tool": "openApplication", "name": "onenote"}),
        ApplicationPlugin("LibreOffice", "Office", ["libre office"], ["open", "create_document", "edit"], fallback="app", launch={"tool": "openApplication", "name": "libreoffice"}),
        ApplicationPlugin("Chrome", "Web", ["google chrome"], ["open", "search", "tabs"], fallback="app", launch={"tool": "openApplication", "name": "chrome"}),
        ApplicationPlugin("Edge", "Web", ["microsoft edge"], ["open", "search", "tabs"], fallback="app", launch={"tool": "openApplication", "name": "edge"}),
        ApplicationPlugin("Firefox", "Web", ["mozilla firefox"], ["open", "search", "tabs"], fallback="app", launch={"tool": "openApplication", "name": "firefox"}),
        ApplicationPlugin("Brave", "Web", ["brave browser"], ["open", "search", "tabs"], fallback="app", launch={"tool": "openApplication", "name": "brave"}),
        ApplicationPlugin("YouTube", "Media", ["youtube music"], ["open", "search", "play", "pause", "summarize", "transcript", "speed", "captions"], fallback="browser", launch={"url": "https://www.youtube.com"}),
        ApplicationPlugin("Instagram", "Social Media", ["instagram app", "insta", "reels", "stories"], ["open", "search", "read", "post", "publish", "send_dm", "comment", "like", "follow", "unfollow"], official_api="Instagram Graph API", fallback="browser", launch={"url": "https://www.instagram.com"}, sensitive_actions=["post", "publish", "send_dm", "comment", "like", "follow", "unfollow"]),
        ApplicationPlugin("Spotify", "Media", ["spotify music"], ["open", "play", "pause", "next", "previous", "search", "shuffle", "repeat"], official_api="Spotify Web API", fallback="app", launch={"tool": "openApplication", "name": "spotify"}),
        ApplicationPlugin("VLC", "Media", ["vlc player"], ["open", "play", "pause", "stop", "fullscreen", "subtitles"], fallback="app", launch={"tool": "openApplication", "name": "vlc"}),
        ApplicationPlugin("Google Drive", "Cloud Storage", ["drive"], ["open", "upload", "download", "share", "delete", "search"], official_api="Google Drive API", fallback="browser", launch={"url": "https://drive.google.com"}, sensitive_actions=sensitive_cloud),
        ApplicationPlugin("OneDrive", "Cloud Storage", ["microsoft onedrive"], ["open", "upload", "download", "share", "delete", "search"], official_api="Microsoft Graph", fallback="browser", launch={"url": "https://onedrive.live.com"}, sensitive_actions=sensitive_cloud),
        ApplicationPlugin("Dropbox", "Cloud Storage", ["drop box"], ["open", "upload", "download", "share", "delete", "search"], official_api="Dropbox API", fallback="browser", launch={"url": "https://www.dropbox.com/home"}, sensitive_actions=sensitive_cloud),
        ApplicationPlugin("Notion", "Productivity", ["notion app"], ["open", "create_note", "search", "summarize"], official_api="Notion API", fallback="browser", launch={"url": "https://www.notion.so"}),
        ApplicationPlugin("Obsidian", "Notes", ["obsidian notes"], ["open", "create_note", "search", "daily_journal"], fallback="app", launch={"tool": "openApplication", "name": "obsidian"}),
        ApplicationPlugin("Todoist", "Productivity", ["todoist tasks"], ["open", "create_task", "search", "complete_task"], official_api="Todoist API", fallback="browser", launch={"url": "https://todoist.com/app"}),
        ApplicationPlugin("Trello", "Productivity", ["trello boards"], ["open", "create_card", "search", "move_card"], official_api="Trello API", fallback="browser", launch={"url": "https://trello.com"}),
        ApplicationPlugin("Asana", "Productivity", ["asana tasks"], ["open", "create_task", "search", "complete_task"], official_api="Asana API", fallback="browser", launch={"url": "https://app.asana.com"}),
        ApplicationPlugin("ClickUp", "Productivity", ["clickup tasks"], ["open", "create_task", "search", "complete_task"], official_api="ClickUp API", fallback="browser", launch={"url": "https://app.clickup.com"}),
        ApplicationPlugin("GitHub", "Development", ["github"], ["open", "search", "clone", "create_repository", "create_issue", "create_pr", "review_pr"], official_api="GitHub API", fallback="browser", launch={"url": "https://github.com"}, sensitive_actions=sensitive_repo),
        ApplicationPlugin("Google Calendar", "Calendar", ["calendar"], ["open", "agenda", "create_event", "delete", "find_free_time"], official_api="Google Calendar API", fallback="browser", launch={"url": "https://calendar.google.com"}, sensitive_actions=["delete", "create_event"]),
        ApplicationPlugin("Outlook Calendar", "Calendar", ["microsoft calendar"], ["open", "agenda", "create_event", "delete", "find_free_time"], official_api="Microsoft Graph", fallback="browser", launch={"url": "https://outlook.live.com/calendar"}, sensitive_actions=["delete", "create_event"]),
    ]


APP_SUITE = ApplicationAutomationSuite()
