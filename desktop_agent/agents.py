"""
SARA/SARA multi-agent orchestration layer.

This module wraps the existing desktop automation tools as dynamically loaded
agents. SARA remains the only user-facing intelligence: callers submit a goal,
the planner selects internal agents, the agent manager starts only those agents,
collects results, persists the workflow, and shuts idle agents back down.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Literal, Optional

from .registry import TOOLS
from .platform_core import EXPERIENCES, EVOLUTION, MEMORY, REINFORCEMENT, RECOVERY, SCHEDULER, SKILLS, STRATEGIES, SECURITY, WORKFLOWS

AgentStatus = Literal["idle", "initializing", "running", "paused", "stopped", "error"]
TaskStatus = Literal[
    "QUEUED", "PLANNING", "RUNNING", "WAITING", "PAUSED", "FAILED",
    "RETRYING", "COMPLETED", "CANCELLED", "created", "scheduled",
    "running", "completed", "failed", "cancelled"
]


@dataclass
class AgentResult:
    status: str
    progress: int = 100
    result: Any = None
    errors: List[str] = field(default_factory=list)
    logs: List[str] = field(default_factory=list)
    resource_usage: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 1.0


@dataclass
class AgentTask:
    id: str
    parent_id: Optional[str]
    goal: str
    agent: str
    action: str
    args: Dict[str, Any]
    priority: int = 5
    status: TaskStatus = "created"
    progress: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    duration_ms: Optional[int] = None
    retry_count: int = 0
    max_retries: int = 1
    result: Any = None
    error: Optional[str] = None
    confidence: float = 0.0


class BaseAgent:
    """Standard lifecycle interface shared by every internal SARA agent."""

    def __init__(self, name: str, capabilities: Iterable[str]) -> None:
        self.name = name
        self.capabilities = sorted(set(capabilities))
        self.status: AgentStatus = "stopped"
        self.last_used = 0.0
        self.error: Optional[str] = None

    def initialize(self) -> AgentResult:
        self.status = "initializing"
        self.status = "idle"
        return AgentResult(status="idle", logs=[f"{self.name} initialized"])

    def start(self) -> AgentResult:
        if self.status == "stopped":
            self.initialize()
        self.status = "running"
        self.last_used = time.time()
        return AgentResult(status="running", logs=[f"{self.name} started"])

    def execute(self, task: AgentTask) -> AgentResult:
        raise NotImplementedError

    def pause(self) -> AgentResult:
        self.status = "paused"
        return AgentResult(status="paused")

    def resume(self) -> AgentResult:
        self.status = "running"
        self.last_used = time.time()
        return AgentResult(status="running")

    def stop(self) -> AgentResult:
        self.status = "stopped"
        return AgentResult(status="stopped")

    def shutdown(self) -> AgentResult:
        return self.stop()

    def health_check(self) -> AgentResult:
        confidence = 0.0 if self.status == "error" else 1.0
        return AgentResult(
            status=self.status,
            result={"agent": self.name, "capabilities": self.capabilities},
            errors=[self.error] if self.error else [],
            confidence=confidence,
        )

    def report_status(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "capabilities": self.capabilities,
            "last_used": self.last_used,
            "error": self.error,
        }

    def save_state(self) -> Dict[str, Any]:
        return self.report_status()

    def restore_state(self, state: Dict[str, Any]) -> None:
        self.last_used = float(state.get("last_used") or 0.0)
        if state.get("status") == "error":
            self.error = state.get("error")


class ToolAgent(BaseAgent):
    """Agent wrapper that delegates to existing registered desktop tools."""

    def __init__(self, name: str, capabilities: Iterable[str], routes: Dict[str, str]) -> None:
        super().__init__(name, capabilities)
        self.routes = routes

    def execute(self, task: AgentTask) -> AgentResult:
        self.start()
        tool_name = self.routes.get(task.action)
        if not tool_name:
            return AgentResult(
                status="failed",
                errors=[f"{self.name} cannot perform action '{task.action}'"],
                confidence=0.0,
            )
        handler = TOOLS.get(tool_name)
        if handler is None:
            return AgentResult(
                status="failed",
                errors=[f"Tool '{tool_name}' is not registered"],
                confidence=0.0,
            )
        out = handler(task.args)
        self.last_used = time.time()
        return AgentResult(
            status="completed",
            result=out,
            logs=[f"{self.name} executed {tool_name}"],
            confidence=0.9,
        )


class MobileControlAgent(BaseAgent):
    """Dedicated agent for Android companion actions such as calls, SMS, notifications, and settings."""

    def __init__(self) -> None:
        super().__init__("mobile_control_agent", ["android", "phone", "sms", "calls", "notifications", "settings", "camera"])
        self.routes = {
            "mobile_pair": "saraAndroidPair",
            "mobile_plan": "saraAndroidPlan",
            "mobile_execute": "saraAndroidExecute",
            "mobile_status": "saraAndroidPlan",
            "mobile_settings": "saraAndroidExecute",
        }

    def execute(self, task: AgentTask) -> AgentResult:
        self.start()
        action = task.action
        tool_name = self.routes.get(action)
        if not tool_name:
            return AgentResult(status="failed", errors=[f"{self.name} cannot perform action '{action}'"], confidence=0.0)
        handler = TOOLS.get(tool_name)
        if handler is None:
            return AgentResult(status="failed", errors=[f"Tool '{tool_name}' is not registered"], confidence=0.0)
        out = handler(task.args)
        self.last_used = time.time()
        return AgentResult(status="completed", result=out, logs=[f"{self.name} executed {tool_name}"], confidence=0.9)


class SystemControlAgent(BaseAgent):
    """Dedicated agent for application, window, desktop, and power control."""

    def __init__(self) -> None:
        super().__init__(
            "system_control_agent",
            ["applications", "windows", "desktop", "processes", "power", "sessions", "monitoring"],
        )
        self.routes = {
            "open_application": "openApplication",
            "close_application": "closeApplication",
            "show_application": "switchApplication",
            "show_desktop": "showDesktop",
            "hide_desktop": "showDesktop",
            "minimize_window": "minimizeWindow",
            "maximize_window": "maximizeWindow",
            "restore_window": "restoreWindow",
            "close_window": "closeWindow",
            "switch_application": "switchApplication",
            "show_running_applications": "listRunningApplications",
            "list_running_processes": "listRunningApplications",
            "power_shutdown": "requestPowerAction",
            "power_restart": "requestPowerAction",
            "power_sleep": "requestPowerAction",
            "power_hibernate": "requestPowerAction",
            "power_lock": "requestPowerAction",
            "session_lock": "requestPowerAction",
        }

    def execute(self, task: AgentTask) -> AgentResult:
        self.start()
        action = task.action
        tool_name = self.routes.get(action)
        if not tool_name:
            return AgentResult(
                status="failed",
                errors=[f"{self.name} cannot perform action '{action}'"],
                confidence=0.0,
            )

        args = dict(task.args or {})
        if action.startswith("power_") or action == "session_lock":
            power_action = action.replace("power_", "").replace("session_lock", "lock")
            args.setdefault("action", power_action)
            tool_name = "requestPowerAction"

        handler = TOOLS.get(tool_name)
        if handler is None:
            return AgentResult(
                status="failed",
                errors=[f"Tool '{tool_name}' is not registered"],
                confidence=0.0,
            )

        out = handler(args)
        self.last_used = time.time()
        return AgentResult(
            status="completed",
            result=out,
            logs=[f"{self.name} executed {tool_name}"],
            confidence=0.9,
        )


class TaskPlannerAgent(BaseAgent):
    """Small deterministic planner for local automation tasks."""

    def __init__(self) -> None:
        super().__init__("task_planner", ["planning", "intent_detection", "delegation"])

    def execute(self, task: AgentTask) -> AgentResult:
        return AgentResult(status="completed", result=plan_goal(task.goal), confidence=0.75)


class AgentManager:
    """Central manager reporting to SARA and controlling agent lifecycle."""

    def __init__(self, idle_timeout_seconds: int = 90) -> None:
        self.idle_timeout_seconds = idle_timeout_seconds
        self._lock = threading.RLock()
        self._agents: Dict[str, BaseAgent] = {}
        self._tasks: Dict[str, AgentTask] = {}
        self._events: List[Dict[str, Any]] = []
        self._store_path = self._default_store_path()
        self._load_state()
        self.discover_agents()

    def discover_agents(self) -> Dict[str, Any]:
        with self._lock:
            self.register_agent(TaskPlannerAgent())
            self.register_agent(SystemControlAgent())
            self.register_agent(MobileControlAgent())
            self.register_agent(
                ToolAgent(
                    "browser_agent",
                    ["browser", "web", "search", "tabs", "forms", "screenshots"],
                    {
                        "open": "desktopBrowserOpen",
                        "navigate": "desktopBrowserNavigate",
                        "search": "desktopBrowserSearch",
                        "click": "desktopBrowserClick",
                        "type": "desktopBrowserType",
                        "fill_form": "desktopBrowserFillForm",
                        "open_tab": "desktopBrowserOpenTab",
                        "close_tab": "desktopBrowserCloseTab",
                        "back": "desktopBrowserGoBack",
                        "forward": "desktopBrowserGoForward",
                        "scroll": "desktopBrowserScroll",
                        "reload": "desktopBrowserReload",
                        "key": "desktopBrowserKey",
                        "zoom": "desktopBrowserZoom",
                        "media": "desktopBrowserMedia",
                        "read_page": "desktopBrowserReadPage",
                        "screenshot": "desktopBrowserScreenshot",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "os_agent",
                    ["files", "folders", "windows", "system", "clipboard", "power"],
                    {
                        "create_file": "createFile",
                        "read_file": "readFile",
                        "rename_file": "renameFile",
                        "delete_file": "deleteFile",
                        "move_file": "moveFile",
                        "copy_file": "copyFile",
                        "duplicate_file": "duplicateFile",
                        "create_folder": "createFolder",
                        "compress": "compressPath",
                        "extract_zip": "extractZip",
                        "open_path": "openPath",
                        "open_folder": "openFolder",
                        "list_files": "listFiles",
                        "search_files": "searchFiles",
                        "minimize_window": "minimizeWindow",
                        "maximize_window": "maximizeWindow",
                        "close_window": "closeWindow",
                        "switch_application": "switchApplication",
                        "restore_window": "restoreWindow",
                        "show_desktop": "showDesktop",
                        "restart_explorer": "restartExplorer",
                        "turn_off_display": "turnOffDisplay",
                        "list_running_applications": "listRunningApplications",
                        "system_info": "systemInfo",
                        "gpu_info": "gpuInfo",
                        "temperature_info": "temperatureInfo",
                        "copy": "copySelected",
                        "paste": "pasteClipboard",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "application_agent",
                    ["applications", "websites", "launch", "close"],
                    {
                        "open_application": "openApplication",
                        "close_application": "closeApplication",
                        "open_website": "openWebsite",
                        "search_web": "searchWeb",
                        "search_youtube": "searchYouTube",
                        "search_google": "searchGoogle",
                        "search_github": "searchGitHub",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "vision_agent",
                    ["screenshots", "ocr", "screen_understanding"],
                    {
                        "take_screenshot": "takeScreenshot",
                        "save_screenshot": "saveScreenshot",
                        "analyze_screenshot": "analyzeScreenshot",
                        "read_screen": "readScreen",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "coding_agent",
                    ["coding", "debugging", "projects", "scripts"],
                    {
                        "create_python_file": "createPythonFile",
                        "write_code_file": "writeCodeFile",
                        "create_project_folder": "createProjectFolder",
                        "run_python_script": "runPythonScript",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "memory_agent",
                    ["memory", "workflow_storage", "preferences", "episodic_memory"],
                    {"remember": "saraMemoryRemember", "search": "saraMemorySearch"},
                )
            )
            self.register_agent(
                ToolAgent(
                    "rag_agent",
                    ["retrieval", "knowledge_search", "document_indexing", "code_indexing"],
                    {"index": "saraRagIndex", "retrieve": "saraRagRetrieve", "remove_deleted": "saraRagRemoveDeleted"},
                )
            )
            self.register_agent(
                ToolAgent(
                    "reinforcement_agent",
                    ["learning", "confidence", "task_outcomes"],
                    {"record": "saraRlRecord", "summary": "saraRlSummary", "configure_rewards": "saraRlConfigureRewards", "best_strategy": "saraStrategyBest"},
                )
            )
            self.register_agent(
                ToolAgent(
                    "security_agent",
                    ["permissions", "audit", "credentials", "safe_mode"],
                    {"assess": "saraSecurityAssess"},
                )
            )
            self.register_agent(
                ToolAgent(
                    "scheduler_agent",
                    ["scheduled_jobs", "timers", "workflow_templates"],
                    {
                        "save_workflow": "saraWorkflowSave",
                        "list_workflows": "saraWorkflowList",
                        "save_skill": "saraSkillSave",
                        "match_skill": "saraSkillMatch",
                        "list_skills": "saraSkillList",
                    },
                )
            )
            self.register_agent(BaseAgent("monitoring_agent", ["health", "resources", "crash_recovery"]))
            self.register_agent(BaseAgent("android_agent", ["android", "phone"]))
            self.register_agent(BaseAgent("notification_agent", ["notifications"]))
            self.register_agent(
                ToolAgent(
                    "hardware_agent",
                    ["mouse", "keyboard", "macros", "real_input"],
                    {
                        "move_mouse": "hardwareMouseMove",
                        "click": "hardwareMouseClick",
                        "drag": "hardwareMouseDrag",
                        "scroll": "hardwareMouseScroll",
                        "position": "hardwareMousePosition",
                        "type": "hardwareKeyboardType",
                        "press": "hardwareKeyboardPress",
                        "hold": "hardwareKeyboardHold",
                        "release": "hardwareKeyboardRelease",
                        "macro": "hardwareMacroReplay",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "voice_os_agent",
                    ["voice_commands", "intent_recognition", "command_router", "training"],
                    {
                        "parse": "saraVoiceParseCommand",
                        "execute": "saraVoiceExecuteCommand",
                        "train": "saraVoiceTrainCommand",
                    },
                )
            )
            self.register_agent(
                ToolAgent(
                    "application_suite_agent",
                    ["application_plugins", "cross_application_workflows", "safe_app_automation"],
                    {
                        "list_plugins": "saraAppListPlugins",
                        "plan": "saraAppPlan",
                        "execute": "saraAppExecute",
                        "execute_goal": "saraAppExecuteGoal",
                    },
                )
            )
            self.register_agent(BaseAgent("supervisor_agent", ["supervision", "orchestration", "quality_control"]))
            self.register_agent(ToolAgent("file_agent", ["files", "file_management"], {"create_file": "createFile", "read_file": "readFile", "move_file": "moveFile", "delete_file": "deleteFile"}))
            self.register_agent(ToolAgent("process_agent", ["processes", "process_monitoring"], {"list_processes": "listRunningApplications"}))
            self.register_agent(ToolAgent("window_agent", ["windows", "window_management"], {"minimize": "minimizeWindow", "maximize": "maximizeWindow", "restore": "restoreWindow", "close": "closeWindow"}))
            self.register_agent(ToolAgent("phone_agent", ["phone", "calls"], {"call": "saraAndroidExecute"}))
            self.register_agent(ToolAgent("sms_agent", ["sms", "text_messages"], {"send_sms": "saraAndroidExecute"}))
            self.register_agent(ToolAgent("whatsapp_agent", ["whatsapp", "messaging"], {"message": "saraAndroidExecute"}))
            self.register_agent(ToolAgent("instagram_agent", ["instagram", "social_media"], {"post": "saraAndroidExecute"}))
            self.register_agent(ToolAgent("youtube_agent", ["youtube", "media_playback"], {"search": "searchYouTube"}))
            self.register_agent(ToolAgent("email_agent", ["email", "mail"], {"send_email": "saraAppExecuteGoal"}))
            self.register_agent(ToolAgent("calendar_agent", ["calendar", "events"], {"add_event": "saraAppExecuteGoal"}))
            self.register_agent(ToolAgent("camera_agent", ["camera", "capture"], {"take_screenshot": "takeScreenshot", "save_screenshot": "saveScreenshot"}))
            self.register_agent(ToolAgent("ocr_agent", ["ocr", "text_extraction"], {"read_screen": "readScreen", "analyze_screenshot": "analyzeScreenshot"}))
            self.register_agent(ToolAgent("research_agent", ["web_research", "information_gathering"], {"search_web": "searchWeb", "read_page": "desktopBrowserReadPage"}))
            self.register_agent(ToolAgent("debugging_agent", ["debugging", "error_analysis"], {"run_script": "runPythonScript"}))
            self.register_agent(BaseAgent("business_agent", ["business_workflows", "reports"]))
            self.register_agent(BaseAgent("personal_assistant_agent", ["personal_assistance", "reminders"]))
            self.register_agent(BaseAgent("knowledge_agent", ["knowledge_graph", "entity_linking"]))
            self.register_agent(BaseAgent("learning_agent", ["workflow_learning", "adaptation"]))
            self.register_agent(BaseAgent("device_sync_agent", ["cross_device_sync", "clipboard_sync"]))
            self.register_agent(BaseAgent("health_diagnostics_agent", ["health_diagnostics", "system_diagnostics"]))
            self._persist_state()
            return self.status()

    def register_agent(self, agent: BaseAgent) -> None:
        existing = self._agents.get(agent.name)
        if existing:
            agent.restore_state(existing.save_state())
        self._agents[agent.name] = agent
        self._event("agent_registered", {"agent": agent.name, "capabilities": agent.capabilities})

    def execute_for_sara(self, goal: str, priority: int = 5) -> Dict[str, Any]:
        root_id = self._new_id()
        plan = plan_goal(goal)
        checkpoint = RECOVERY.latest_incomplete_for_goal(goal)
        resume_from = str((checkpoint or {}).get("payload", {}).get("resume_from") or "")
        if checkpoint:
            self._event("workflow_resume", {"workflow": root_id, "goal": goal, "checkpoint": checkpoint})
        skill_matches = SKILLS.match(goal, limit=1)
        strategy_matches = STRATEGIES.best_strategies(goal, limit=1)
        self._event("workflow_planned", {"workflow": root_id, "goal": goal, "steps": plan})
        results: List[Dict[str, Any]] = []
        status: TaskStatus = "completed"
        layers = _build_execution_layers(plan)
        start_layer = 0
        if resume_from:
            for idx, layer in enumerate(layers):
                if any(step.get("checkpoint") == resume_from for step in layer):
                    start_layer = idx
                    break
        for layer_index, layer in enumerate(layers[start_layer:], start=start_layer):
            layer_results = self._execute_step_group(goal, root_id, layer, priority)
            results.extend(layer_results)
            if any(item["agent_result"]["status"] != "completed" for item in layer_results):
                status = "failed"
                RECOVERY.save(root_id, f"layer-{layer_index}", {"goal": goal, "resume_from": next((step.get("checkpoint") for step in layer if step.get("checkpoint")), ""), "status": "failed", "progress": layer_index})
                break
            RECOVERY.save(root_id, f"layer-{layer_index}", {"goal": goal, "resume_from": next((step.get("checkpoint") for step in layer if step.get("checkpoint")), ""), "status": "completed", "progress": layer_index})
        if status == "completed":
            RECOVERY.save(root_id, "complete", {"goal": goal, "status": status, "plan_length": len(plan), "results": len(results)})
        self.unload_idle_agents(force=False)
        MEMORY.remember(
            "workflow",
            summarize_for_sara(goal, results, status),
            {"workflow_id": root_id, "goal": goal, "status": status, "plan": plan},
        )
        WORKFLOWS.learn(goal, plan, {"status": status, "workflow_id": root_id})
        if status == "completed":
            SKILLS.learn_from_workflow(goal, f"Learned workflow for {goal}", plan, {"workflow_id": root_id})
        REINFORCEMENT.record(goal, status, [item["task"] for item in results])
        total_duration = sum(int(item["task"].duration_ms or 0) for item in results)
        EXPERIENCES.record(
            task=goal,
            action="saraAgentExecute",
            result=status,
            success=status == "completed",
            execution_time_ms=total_duration,
            error="" if status == "completed" else summarize_for_sara(goal, results, status),
            recovery="resume from checkpoint" if status != "completed" else "",
            metadata={
                "workflow_id": root_id,
                "plan": plan,
                "matched_skill": skill_matches[0] if skill_matches else None,
                "matched_strategy": strategy_matches[0] if strategy_matches else None,
            },
        )
        if status != "completed" or any((task["task"].get("retry_count") or 0) > 0 for task in results):
            EVOLUTION.propose(
                f"Improve workflow execution for: {goal}",
                {
                    "goal": goal,
                    "workflow_id": root_id,
                    "status": status,
                    "failed_steps": [item for item in results if item["agent_result"]["status"] != "completed"],
                    "retries": [item for item in results if (item["task"].get("retry_count") or 0) > 0],
                },
                scope="workflow",
            )
        self._persist_state()
        return {
            "status": status,
            "workflow_id": root_id,
            "goal": goal,
            "plan": plan,
            "matched_skill": skill_matches[0] if skill_matches else None,
            "matched_strategy": strategy_matches[0] if strategy_matches else None,
            "results": results,
            "sara_summary": summarize_for_sara(goal, results, status),
        }

    def _execute_step_group(self, goal: str, root_id: str, group: List[Dict[str, Any]], priority: int) -> List[Dict[str, Any]]:
        if len(group) <= 1 or not all(step.get("parallel", False) for step in group):
            step = group[0]
            task = AgentTask(
                id=self._new_id(),
                parent_id=root_id,
                goal=goal,
                agent=step["agent"],
                action=step["action"],
                args=step.get("args", {}),
                priority=priority,
                status="scheduled",
            )
            result = self._execute_with_retry(task, max_retries=int(step.get("max_retries", 1)))
            return [{"task": asdict(task), "agent_result": asdict(result)}]

        collected: List[Dict[str, Any]] = []
        lock = threading.Lock()

        def runner(step: Dict[str, Any]) -> None:
            task = AgentTask(
                id=self._new_id(),
                parent_id=root_id,
                goal=goal,
                agent=step["agent"],
                action=step["action"],
                args=step.get("args", {}),
                priority=priority,
                status="scheduled",
            )
            result = self._execute_with_retry(task, max_retries=int(step.get("max_retries", 1)))
            with lock:
                collected.append({"task": asdict(task), "agent_result": asdict(result)})

        threads = [threading.Thread(target=runner, args=(step,), daemon=True) for step in group]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return collected

    def execute_batch(self, goals: List[str]) -> Dict[str, Any]:
        results = [self.execute_for_sara(goal) for goal in goals]
        return {"results": results, "count": len(results)}

    def _execute_task(self, task: AgentTask) -> AgentResult:
        with self._lock:
            self._tasks[task.id] = task
        agent = self._agents.get(task.agent)
        if agent is None:
            task.status = "failed"
            task.error = f"Agent '{task.agent}' is not registered"
            return AgentResult(status="failed", errors=[task.error], confidence=0.0)
        task.status = "running"
        task.started_at = time.time()
        self._event("task_started", {"task": task.id, "agent": task.agent, "action": task.action})
        try:
            result = agent.execute(task)
        except Exception as exc:  # noqa: BLE001
            result = AgentResult(
                status="failed",
                errors=[str(exc), traceback.format_exc()],
                confidence=0.0,
            )
        task.finished_at = time.time()
        task.duration_ms = int((task.finished_at - (task.started_at or task.finished_at)) * 1000)
        task.progress = result.progress
        task.result = result.result
        task.confidence = result.confidence
        if result.status == "completed":
            task.status = "completed"
        else:
            task.status = "failed"
            task.error = "; ".join(result.errors)
        self._event(
            "task_finished",
            {
                "task": task.id,
                "agent": task.agent,
                "status": task.status,
                "duration_ms": task.duration_ms,
            },
        )
        self._persist_state()
        return result

    def _execute_with_retry(self, task: AgentTask, max_retries: int = 1) -> AgentResult:
        attempts = 0
        last_result = AgentResult(status="failed", errors=["No execution attempt was made."], confidence=0.0)
        while attempts <= max_retries:
            attempts += 1
            task.retry_count = attempts - 1
            result = self._execute_task(task)
            last_result = result
            if result.status == "completed" and self._verify_result(task, result):
                return result
            if result.status == "completed":
                result = AgentResult(status="failed", errors=["Verification failed after execution."], confidence=result.confidence * 0.5)
                last_result = result
            if attempts <= max_retries:
                self._event("task_retry", {"task": task.id, "attempt": attempts, "agent": task.agent})
        return last_result

    def _verify_result(self, task: AgentTask, result: AgentResult) -> bool:
        payload = str(result.result or "")
        if "requires_confirmation" in payload.lower():
            return False
        if result.status != "completed":
            return False
        # File creation empirical verification
        if task.action in ("create_file", "write_code_file", "create_python_file", "create_folder"):
            target_path = str(task.args.get("path") or task.args.get("file_path") or task.args.get("folder_path") or task.args.get("name") or "")
            if target_path and not os.path.isabs(target_path):
                target_path = str(Path.cwd() / target_path)
            if target_path and os.path.exists(target_path):
                return True
        checks = {
            "open_application": lambda text: any(word in text.lower() for word in ("opened", "focused", "launched")),
            "close_application": lambda text: any(word in text.lower() for word in ("closed", "force-closed")),
            "open_website": lambda text: "opened" in text.lower(),
            "search_web": lambda text: "search" in text.lower() or "opened" in text.lower(),
            "take_screenshot": lambda text: "screenshot" in text.lower() or "saved" in text.lower(),
            "open_camera": lambda text: "camera" in text.lower() or "open" in text.lower(),
            "take_photo": lambda text: "photo" in text.lower() or "captured" in text.lower(),
            "record_video": lambda text: "record" in text.lower(),
        }
        checker = checks.get(task.action)
        if checker is None:
            return True
        return checker(payload)

    def unload_idle_agents(self, force: bool = False) -> Dict[str, Any]:
        stopped: List[str] = []
        now = time.time()
        with self._lock:
            for agent in self._agents.values():
                if agent.name == "task_planner":
                    continue
                idle_for = now - agent.last_used if agent.last_used else None
                if force or (agent.status in ("idle", "running") and idle_for and idle_for > self.idle_timeout_seconds):
                    agent.shutdown()
                    stopped.append(agent.name)
        if stopped:
            self._event("agents_unloaded", {"agents": stopped, "force": force})
            self._persist_state()
        return {"stopped": stopped, "count": len(stopped)}

    def emergency_stop(self) -> Dict[str, Any]:
        with self._lock:
            active_tasks = [task_id for task_id, task in self._tasks.items() if task.status in {"created", "scheduled", "running"}]
            for task_id in active_tasks:
                task = self._tasks[task_id]
                task.status = "cancelled"
                task.error = "Cancelled by emergency stop"
                task.finished_at = time.time()
            for agent in self._agents.values():
                if agent.name == "task_planner":
                    continue
                agent.shutdown()
            self._event("emergency_stop", {"cancelled_tasks": active_tasks, "agents": list(self._agents)})
            self._persist_state()
        return {"cancelled_tasks": active_tasks, "agents_stopped": [name for name in self._agents if name != "task_planner"], "idle_state": True}

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "agents": {name: agent.report_status() for name, agent in sorted(self._agents.items())},
                "tasks": {task_id: asdict(task) for task_id, task in sorted(self._tasks.items())},
                "events": self._events[-50:],
            }

    def _event(self, event_type: str, payload: Dict[str, Any]) -> None:
        self._events.append({"type": event_type, "time": time.time(), "payload": payload})
        if len(self._events) > 500:
            del self._events[:250]

    def _load_state(self) -> None:
        try:
            if not self._store_path.exists():
                return
            raw = json.loads(self._store_path.read_text(encoding="utf-8"))
            for item in raw.get("tasks", []):
                task = AgentTask(**item)
                if task.status == "running":
                    task.status = "failed"
                    task.error = "Recovered after process restart before completion"
                self._tasks[task.id] = task
            self._events = list(raw.get("events", []))[-500:]
        except Exception as exc:  # noqa: BLE001
            self._events = [{"type": "state_recovery_failed", "time": time.time(), "payload": {"error": str(exc)}}]

    def _persist_state(self) -> None:
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "tasks": [asdict(task) for task in self._tasks.values()],
            "events": self._events[-500:],
            "agents": {name: agent.save_state() for name, agent in self._agents.items()},
        }
        tmp = self._store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self._store_path)

    @staticmethod
    def _new_id() -> str:
        return uuid.uuid4().hex

    @staticmethod
    def _default_store_path() -> Path:
        data_dir = os.environ.get("SARA_DATA_DIR")
        if data_dir:
            return Path(data_dir) / "sara_agent_state.json"
        return Path.cwd() / "logs" / "sara_agent_state.json"


def plan_goal(goal: str) -> List[Dict[str, Any]]:
    text = goal.strip()
    low = text.lower()
    if all(word in low for word in ("research", "spreadsheet", "presentation", "save")):
        return [
            {"agent": "browser_agent", "action": "search", "args": {"engine": "google", "query": text}, "parallel": True, "checkpoint": "research", "produces": "research_notes"},
            {"agent": "coding_agent", "action": "create_project_folder", "args": {"name": "CompetitorAnalysis"}, "parallel": True, "checkpoint": "workspace"},
            {"agent": "system_control_agent", "action": "open_application", "args": {"name": "excel"}, "parallel": True, "checkpoint": "spreadsheet_app", "depends_on": ["workspace"]},
            {"agent": "system_control_agent", "action": "open_application", "args": {"name": "powerpoint"}, "parallel": True, "checkpoint": "presentation_app", "depends_on": ["workspace"]},
            {"agent": "os_agent", "action": "list_files", "args": {"path": "downloads"}, "parallel": False, "checkpoint": "save", "depends_on": ["research_notes", "spreadsheet_app", "presentation_app"]},
        ]
    if any(word in low for word in ("open my work setup", "work setup", "my setup")):
        return [
            {"agent": "system_control_agent", "action": "open_application", "args": {"name": "vscode"}},
            {"agent": "browser_agent", "action": "open", "args": {"url": "https://www.google.com"}},
        ]
    if "create a report" in low and "email" in low:
        return [
            {"agent": "os_agent", "action": "list_files", "args": {"path": "documents"}},
            {"agent": "coding_agent", "action": "create_project_folder", "args": {"name": "ReportDraft"}},
            {"agent": "application_agent", "action": "open_application", "args": {"name": "word"}},
            {"agent": "application_agent", "action": "open_application", "args": {"name": "outlook"}},
        ]
    if any(word in low for word in ("show desktop", "desktop", "restore my windows", "minimize all windows", "show all open windows", "switch virtual desktop", "create virtual desktop", "close virtual desktop", "show desktop")):
        return [{"agent": "system_control_agent", "action": "show_desktop", "args": {}}]
    if any(word in low for word in ("open ", "launch ", "start ", "close ", "quit ", "exit ", "switch to ", "focus ", "bring ", "show ", "maximize", "minimize", "restore")) and any(app in low for app in ["chrome", "vscode", "code", "spotify", "explorer", "terminal", "notepad", "calculator", "task manager", "settings", "file explorer", "command prompt", "powershell"]):
        app_name = _extract_system_app_name(text)
        if any(word in low for word in ("open ", "launch ", "start ")):
            return [{"agent": "system_control_agent", "action": "open_application", "args": {"name": app_name}}]
        if any(word in low for word in ("close ", "quit ", "exit ")):
            return [{"agent": "system_control_agent", "action": "close_application", "args": {"name": app_name}}]
        if low.startswith("show "):
            return [{"agent": "system_control_agent", "action": "show_application", "args": {"application": app_name}}]
        if "maximize" in low:
            return [{"agent": "system_control_agent", "action": "maximize_window", "args": {"application": app_name}}]
        if "minimize" in low:
            return [{"agent": "system_control_agent", "action": "minimize_window", "args": {"application": app_name}}]
        if "restore" in low:
            return [{"agent": "system_control_agent", "action": "restore_window", "args": {"application": app_name}}]
        return [{"agent": "system_control_agent", "action": "show_application", "args": {"application": app_name}}]
    if any(word in low for word in ("shutdown", "shut down", "restart", "sleep", "hibernate", "lock", "sign out", "log out")):
        action = "power_shutdown" if "shutdown" in low or "shut down" in low else "power_restart" if "restart" in low else "power_sleep" if "sleep" in low else "power_hibernate" if "hibernate" in low else "power_lock" if "lock" in low else "session_lock"
        return [{"agent": "system_control_agent", "action": action, "args": {}}]
    if any(word in low for word in ("browser", "youtube", "google", "github", "gmail", "website", "search", "tab", "scroll")):
        if "youtube" in low and any(word in low for word in ("search", "watch", "video")):
            query = _after(low, ["for ", "about "]) or text
            return [{"agent": "browser_agent", "action": "search", "args": {"engine": "youtube", "query": query}}]
        if "github" in low and "search" in low:
            query = _after(low, ["for ", "about "]) or text
            return [{"agent": "browser_agent", "action": "search", "args": {"engine": "github", "query": query}}]
        if "search" in low:
            query = _after(low, ["for ", "about "]) or text
            return [{"agent": "browser_agent", "action": "search", "args": {"engine": "google", "query": query}}]
        if "scroll" in low:
            direction = "up" if "up" in low else "down"
            return [{"agent": "browser_agent", "action": "scroll", "args": {"direction": direction, "amount": 700}}]
        return [{"agent": "browser_agent", "action": "open", "args": {"url": _website_url(low)}}]
    if any(word in low for word in ("screenshot", "screen", "ocr", "see this")):
        return [{"agent": "vision_agent", "action": "read_screen", "args": {}}]
    if any(word in low for word in ("mobile", "android", "phone", "sms", "message", "notification", "flashlight", "battery", "camera", "contact", "whatsapp", "telegram", "instagram")):
        return [{"agent": "mobile_control_agent", "action": "mobile_plan", "args": {"request": text}}]
    if any(word in low for word in ("open app", "launch", "start application", "calculator", "notepad")):
        app_name = text.replace("open", "").replace("launch", "").strip()
        return [{"agent": "application_agent", "action": "open_application", "args": {"name": app_name}}]
    if any(word in low for word in ("file", "folder", "documents", "downloads", "desktop")):
        return [{"agent": "os_agent", "action": "list_files", "args": {"path": "desktop"}}]
    if any(word in low for word in ("code", "python", "script", "debug", "refactor")):
        return [{"agent": "coding_agent", "action": "create_project_folder", "args": {"name": "SaraGeneratedProject"}}]
    return [{"agent": "task_planner", "action": "plan", "args": {"goal": text}}]


def _group_parallel_steps(steps: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    groups: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    for step in steps:
        if step.get("parallel"):
            current.append(step)
            continue
        if current:
            groups.append(current)
            current = []
        groups.append([step])
    if current:
        groups.append(current)
    return groups


def _build_execution_layers(steps: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    remaining = list(steps)
    completed: set[str] = set()
    layers: List[List[Dict[str, Any]]] = []
    safety = 0
    while remaining and safety < 100:
        safety += 1
        ready: List[Dict[str, Any]] = []
        blocked: List[Dict[str, Any]] = []
        for step in remaining:
            deps = set(step.get("depends_on") or [])
            if deps.issubset(completed):
                ready.append(step)
            else:
                blocked.append(step)
        if not ready:
            layers.append(blocked[:1])
            remaining = blocked[1:]
            continue
        layer: List[Dict[str, Any]] = []
        for step in ready:
            if step.get("parallel", False):
                layer.append(step)
            else:
                if layer:
                    layers.append(layer)
                    layer = []
                layers.append([step])
            if step.get("checkpoint"):
                completed.add(str(step["checkpoint"]))
        if layer:
            layers.append(layer)
        remaining = blocked
    if remaining:
        layers.extend([[step] for step in remaining])
    return [layer for layer in layers if layer]


def summarize_for_sara(goal: str, results: List[Dict[str, Any]], status: TaskStatus) -> str:
    if not results:
        return f"I analyzed the request but did not need to run an external agent: {goal}"
    if status == "completed":
        names = ", ".join(item["task"]["agent"] for item in results)
        return f"Completed through SARA's agent manager using: {names}."
    failed = next((item for item in results if item["task"]["status"] == "failed"), results[-1])
    return f"The workflow did not fully complete. {failed['task'].get('error') or 'An agent reported a failure.'}"


def _after(text: str, markers: List[str]) -> str:
    for marker in markers:
        if marker in text:
            return text.split(marker, 1)[1].strip()
    return ""


def _extract_system_app_name(text: str) -> str:
    aliases = {
        "chrome": "chrome",
        "google chrome": "chrome",
        "vscode": "vscode",
        "vs code": "vscode",
        "visual studio code": "vscode",
        "notepad": "notepad",
        "calculator": "calculator",
        "spotify": "spotify",
        "file explorer": "file explorer",
        "explorer": "file explorer",
        "terminal": "command prompt",
        "cmd": "command prompt",
        "command prompt": "command prompt",
        "powershell": "powershell",
        "task manager": "task manager",
        "settings": "settings",
    }
    low = text.lower()
    for phrase, app in sorted(aliases.items(), key=lambda item: len(item[0]), reverse=True):
        if phrase in low:
            return app
    return text.strip()


def _website_url(text: str) -> str:
    sites = {
        "youtube": "https://www.youtube.com",
        "google": "https://www.google.com",
        "github": "https://github.com",
        "gmail": "https://mail.google.com",
        "chatgpt": "https://chatgpt.com",
        "stack overflow": "https://stackoverflow.com",
    }
    for key, url in sites.items():
        if key in text:
            return url
    return text.strip()


MANAGER = AgentManager()
