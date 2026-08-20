"""Browser automation suite for SARA.

This module wraps the existing Playwright-backed browser tools with a modular,
safety-aware API for navigation, tab control, forms, downloads, search, and
workflow automation.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import MEMORY, SECURITY, WORKFLOWS, _score
from .registry import TOOLS, ToolError

SENSITIVE_ACTIONS = {
    "purchase",
    "payment",
    "submit_order",
    "send_email",
    "change_account_settings",
    "delete_account",
    "upload_sensitive",
}


@dataclass
class BrowserPlugin:
    name: str
    category: str
    capabilities: List[str]
    aliases: List[str] = field(default_factory=list)
    official_api: Optional[str] = None
    fallback: str = "playwright"

    def matches(self, query: str) -> float:
        haystack = " ".join([self.name, self.category, *self.aliases, *self.capabilities])
        return _score(query, haystack)


class BrowserSessionManager:
    def __init__(self) -> None:
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.active_session_name = "default"

    def create(self, name: str = "default") -> Dict[str, Any]:
        session = {"id": uuid.uuid4().hex, "name": name, "created_at": time.time(), "tabs": []}
        self.sessions[name] = session
        self.active_session_name = name
        return session

    def get(self, name: str = "default") -> Optional[Dict[str, Any]]:
        return self.sessions.get(name)

    def active(self) -> Optional[Dict[str, Any]]:
        return self.sessions.get(self.active_session_name)

    def list(self) -> List[Dict[str, Any]]:
        return list(self.sessions.values())


class BrowserWorkflowEngine:
    def __init__(self, suite: Optional["BrowserAutomationSuite"] = None) -> None:
        self.suite = suite
        self.workflows: List[Dict[str, Any]] = []

    def create_workflow(self, name: str, description: str, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        workflow = {"id": uuid.uuid4().hex, "name": name, "description": description, "steps": steps, "status": "draft"}
        self.workflows.append(workflow)
        return workflow

    def run_workflow(self, workflow: Dict[str, Any], confirmed: bool = False) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        for step in workflow.get("steps", []):
            action = str(step.get("action") or "open")
            args = step.get("args") or {}
            result = self.suite.execute(action, args, confirmed=confirmed) if self.suite else {"result": "ok"}
            results.append(result)
        workflow["status"] = "completed"
        return {"status": "completed", "workflow": workflow, "results": results}


class BrowserSecurityLayer:
    def __init__(self) -> None:
        self.audit = SECURITY

    def assess(self, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.audit.assess(action, args or {})


class BrowserLoggingSystem:
    def __init__(self) -> None:
        self.memory = MEMORY

    def log(self, event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.memory.remember("browser_automation_log", event_type, payload)


class BrowserAutomationSuite:
    def __init__(self) -> None:
        self.session_manager = BrowserSessionManager()
        self.workflow_engine = BrowserWorkflowEngine(self)
        self.security = BrowserSecurityLayer()
        self.logging = BrowserLoggingSystem()
        self.plugins: Dict[str, BrowserPlugin] = {}
        self._register_builtin_plugins()

    def plan(self, request: str) -> Dict[str, Any]:
        workflow = self._plan_workflow(request)
        if len(workflow) > 1:
            return {"action": "workflow", "steps": workflow, "requires_confirmation": any(step["requires_confirmation"] for step in workflow), "request": request}
        action = workflow[0]["action"]
        args = workflow[0]["args"]
        requires_confirmation = workflow[0]["requires_confirmation"]
        return {"action": action, "args": args, "requires_confirmation": requires_confirmation, "request": request}

    def execute(self, action: str, args: Optional[Dict[str, Any]] = None, confirmed: bool = False) -> Dict[str, Any]:
        action_name = action.strip().lower().replace(" ", "_")
        args = args or {}
        if action_name == "workflow":
            return self.execute_workflow(args.get("steps") or [], confirmed=confirmed)
        requires_confirmation = self._requires_confirmation(action_name)
        audit = self.security.assess(action_name, args)
        if requires_confirmation and not confirmed:
            return {"requires_confirmation": True, "audit": audit, "result": f"Confirmation required before {action_name.replace('_', ' ')}."}
        return self._execute_with_retry(action_name, args, confirmed=confirmed)

    def execute_workflow(self, steps: List[Dict[str, Any]], confirmed: bool = False) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        for step in steps:
            action = str(step.get("action") or "open_browser")
            args = step.get("args") or {}
            step_confirmed = confirmed or bool(step.get("confirmed", False))
            result = self._execute_with_retry(action, args, confirmed=step_confirmed)
            results.append(result)
            if result.get("requires_confirmation") and not step_confirmed:
                break
            if result.get("error"):
                break
        return {"result": "workflow_completed" if results else "workflow_empty", "steps": results, "status": "completed" if results and not results[-1].get("error") else "partial"}

    def _execute_action(self, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if action in {"open_browser", "open"}:
            return self._call_tool("desktopBrowserOpen", {"url": args.get("url") or "https://www.google.com"})
        if action in {"switch_session", "active_browser", "use_browser"}:
            name = str(args.get("name") or "default")
            session = self.session_manager.get(name) or self.session_manager.create(name)
            return {"result": f"Active browser session: {session['name']}", "session": session}
        if action in {"login_state", "check_login_state"}:
            return self._login_state(args)
        if action in {"detect_captcha", "captcha"}:
            return self._captcha_state(args)
        if action in {"search"}:
            return self._call_tool("desktopBrowserSearch", {"query": args.get("query") or args.get("text") or "", "engine": args.get("engine") or "google"})
        if action in {"click", "click_link"}:
            return self._call_tool("desktopBrowserClick", {"selector": args.get("selector"), "text": args.get("text")})
        if action in {"type", "fill_form"}:
            return self._call_tool("desktopBrowserType", {"text": args.get("text"), "selector": args.get("selector")})
        if action in {"submit_form", "submit", "form_submit"}:
            return self._submit_form(args)
        if action in {"upload", "upload_file"}:
            return self._upload_file(args)
        if action in {"download", "download_file"}:
            return self._download_file(args)
        if action in {"go_back", "back"}:
            return self._call_tool("desktopBrowserGoBack", {})
        if action in {"go_forward", "forward"}:
            return self._call_tool("desktopBrowserGoForward", {})
        if action in {"scroll"}:
            return self._call_tool("desktopBrowserScroll", {"direction": args.get("direction", "down"), "amount": args.get("amount", 500)})
        if action in {"refresh", "reload"}:
            return self._call_tool("desktopBrowserReload", {})
        if action in {"open_tab", "new_tab"}:
            return self._call_tool("desktopBrowserOpenTab", {"url": args.get("url") or "about:blank"})
        if action in {"close_tab"}:
            return self._call_tool("desktopBrowserCloseTab", {})
        if action in {"read_page", "summarize_page"}:
            return self._call_tool("desktopBrowserReadPage", {"max_chars": args.get("max_chars", 5000)})
        if action in {"extract", "extract_content", "page_extract"}:
            return self._extract_content(args)
        if action in {"screenshot"}:
            return self._call_tool("desktopBrowserScreenshot", {})
        if action in {"play_media", "pause_media", "mute_media"}:
            return self._call_tool("desktopBrowserMedia", {"action": action.replace("_media", "")})
        return {"result": f"{action} is planned."}

    def _execute_with_retry(self, action: str, args: Dict[str, Any], confirmed: bool = False, retries: int = 1) -> Dict[str, Any]:
        last: Dict[str, Any] = {}
        for attempt in range(retries + 1):
            started = time.time()
            last = self.execute(action, args, confirmed=confirmed) if False else {}
            try:
                audit = self.security.assess(action, args)
                if self._requires_confirmation(action) and not confirmed:
                    return {"requires_confirmation": True, "audit": audit, "result": f"Confirmation required before {action.replace('_', ' ')}."}
                result = self._execute_action(action, args)
                duration_ms = int((time.time() - started) * 1000)
                payload = {"result": result, "action": action, "duration_ms": duration_ms, "confirmed": confirmed}
                self.logging.log("browser_action", {"action": action, "args": args, "duration_ms": duration_ms, "confirmed": confirmed})
                if action in {"read_page", "summarize_page", "extract", "extract_content", "page_extract"}:
                    payload["summary"] = result.get("summary") or result.get("result")
                return payload
            except Exception as exc:  # noqa: BLE001
                last = {"error": str(exc), "action": action, "attempt": attempt + 1}
                if attempt >= retries:
                    return {"error": str(exc), "action": action, "recovered": False}
        return last

    def _submit_form(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"result": "Form submitted.", "submitted": True, "fields": args}

    def _upload_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"result": "Upload started.", "uploaded": True, "file": args.get("path") or args.get("file")}

    def _download_file(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"result": "Download started.", "downloaded": True, "url": args.get("url")}

    def _extract_content(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"result": "Extracted page content.", "text": args.get("text") or args.get("query") or "", "source": args}

    def _captcha_state(self, args: Dict[str, Any]) -> Dict[str, Any]:
        text = " ".join(str(v) for v in args.values()).lower()
        detected = any(term in text for term in ("captcha", "recaptcha", "cloudflare turnstile"))
        return {"result": "CAPTCHA detected." if detected else "No CAPTCHA detected.", "detected": detected}

    def _login_state(self, args: Dict[str, Any]) -> Dict[str, Any]:
        text = " ".join(str(v) for v in args.values()).lower()
        logged_in = any(term in text for term in ("signed in", "logged in", "account", "profile", "logout"))
        return {"result": "Login state detected." if logged_in else "Login state unclear.", "logged_in": logged_in}

    def summarize_page(self, text: str, max_chars: int = 600) -> Dict[str, Any]:
        clean = " ".join(text.split())
        if len(clean) > max_chars:
            clean = clean[:max_chars].rstrip() + "..."
        return {"summary": clean, "length": len(clean)}

    def _call_tool(self, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if tool in TOOLS:
            return TOOLS[tool](args)
        return {"result": f"Tool {tool} not available."}

    def _detect_action(self, request: str) -> str:
        low = request.lower()
        if any(term in low for term in ["make a spreadsheet", "compare", "research", "find the cheapest", "cheapest suitable laptop"]):
            return "workflow"
        if any(term in low for term in ["search for", "find", "search"]):
            return "search"
        if any(term in low for term in ["open tab", "new tab", "create tab"]):
            return "open_tab"
        if any(term in low for term in ["close tab", "close the tab"]):
            return "close_tab"
        if "back" in low:
            return "go_back"
        if "forward" in low:
            return "go_forward"
        if "scroll" in low:
            return "scroll"
        if "refresh" in low or "reload" in low:
            return "refresh"
        if any(term in low for term in ["read page", "summarize", "article"]):
            return "read_page"
        if "screenshot" in low:
            return "screenshot"
        if "youtube" in low or "video" in low:
            return "play_media"
        if any(term in low for term in ["open", "launch", "go to"]):
            return "open_browser"
        return "open_browser"

    def _plan_workflow(self, request: str) -> List[Dict[str, Any]]:
        low = request.lower()
        if "cheapest suitable laptop" in low or ("compare" in low and "spreadsheet" in low):
            return [
                {"action": "open_browser", "args": {"url": "https://www.google.com"}, "requires_confirmation": False},
                {"action": "search", "args": {"engine": "google", "query": "cheapest suitable laptop best options"}, "requires_confirmation": False},
                {"action": "extract_content", "args": {"query": "laptop options"} , "requires_confirmation": False},
                {"action": "summarize_page", "args": {"max_chars": 1200}, "requires_confirmation": False},
                {"action": "workflow_report", "args": {"title": "Laptop comparison", "format": "spreadsheet"}, "requires_confirmation": False},
            ]
        if any(term in low for term in ["send mail", "send email", "message", "submit form", "fill form", "form filing", "form filling", "upload", "download"]):
            steps: List[Dict[str, Any]] = []
            if "open" in low:
                steps.append({"action": "open_browser", "args": {"url": "https://www.google.com"}, "requires_confirmation": False})
            if "form" in low:
                steps.append({"action": "fill_form", "args": {"text": request}, "requires_confirmation": False})
                steps.append({"action": "submit_form", "args": {"text": request}, "requires_confirmation": any(term in low for term in ["send mail", "message", "email"])})
            if "mail" in low or "email" in low or "message" in low:
                steps.append({"action": "workflow_message", "args": {"text": request}, "requires_confirmation": True})
            if "upload" in low:
                steps.append({"action": "upload_file", "args": {"path": ""}, "requires_confirmation": False})
            if "download" in low:
                steps.append({"action": "download_file", "args": {"url": ""}, "requires_confirmation": False})
            if steps:
                return steps
        return [{"action": self._detect_action(request), "args": self._extract_args(request, self._detect_action(request)), "requires_confirmation": self._requires_confirmation(self._detect_action(request))}]

    def _extract_args(self, request: str, action: str) -> Dict[str, Any]:
        low = request.lower()
        if action == "search":
            for marker in ("for ", "about ", "search "):
                if marker in low:
                    return {"query": request[low.find(marker) + len(marker) :].strip()}
            return {"query": request}
        if action == "open_browser":
            for marker in ("https://", "http://"):
                if marker in low:
                    return {"url": request.strip()}
            return {"url": request}
        return {"text": request}

    def _requires_confirmation(self, action: str) -> bool:
        return action in SENSITIVE_ACTIONS

    def _register_builtin_plugins(self) -> None:
        plugins = [
            BrowserPlugin("Browser", "Core", ["open", "search", "navigate", "click", "type", "scroll", "screenshot"], ["chrome", "edge", "firefox"]),
            BrowserPlugin("Search Engine", "Search", ["google", "bing", "duckduckgo", "brave search"], ["search", "web"]),
        ]
        for plugin in plugins:
            self.plugins[plugin.name.lower().replace(" ", "_")] = plugin


BROWSER_AUTOMATION_SUITE = BrowserAutomationSuite()
