"""
Universal Command Center — saraUniversalCommand.

Enables SARA's Goal → Plan → Execute paradigm. The user gives a high-level
goal in natural language; this tool decomposes it into a sequence of concrete
tool calls, executes each step using the live TOOLS registry, and returns a
full execution report.

Architecture:
  1. LocalPlanner  — maps intent keywords to ordered step templates
  2. StepExecutor  — calls TOOLS[name](args) for each step, with retry
  3. ExperienceLogger — persists the execution trace via EXPERIENCES.record
  4. ReportBuilder — builds a human-readable summary
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .registry import TOOLS, ToolError, register
from .platform_core import EXPERIENCES, MEMORY


# ---------------------------------------------------------------------------
# Intent → Step template library
# ---------------------------------------------------------------------------
_INTENT_LIBRARY: List[Dict[str, Any]] = [
    # "prepare meeting" / "meeting prep"
    {
        "keywords": ["meeting", "prep", "prepare", "tomorrow's meeting"],
        "steps": [
            {"tool": "saraGoalCreate", "args_template": {"title": "{goal}"}},
            {"tool": "saraMemorySearch", "args_template": {"query": "meeting agenda notes", "limit": 5}},
            {"tool": "saraRagRetrieve", "args_template": {"query": "meeting agenda project notes", "limit": 5}},
            {"tool": "takeScreenshot", "args_template": {"include_image": False}},
        ],
        "description": "Meeting preparation: creates a goal, searches memory and docs for context.",
    },
    # "open project" / "start my project"
    {
        "keywords": ["open project", "start project", "start my project", "launch project"],
        "steps": [
            {"tool": "openApplication", "args_template": {"name": "vscode"}},
            {"tool": "saraMemorySearch", "args_template": {"query": "current project path", "limit": 3}},
        ],
        "description": "Opens VS Code and retrieves project context from memory.",
    },
    # "check system"
    {
        "keywords": ["system check", "health check", "check system", "pc status", "system status"],
        "steps": [
            {"tool": "systemInfo", "args_template": {}},
            {"tool": "gpuInfo", "args_template": {}},
            {"tool": "temperatureInfo", "args_template": {}},
            {"tool": "saraHealthRun", "args_template": {}},
        ],
        "description": "Full system health check: CPU, GPU, temperature, and SARA health diagnostics.",
    },
    # "backup my files"
    {
        "keywords": ["backup", "back up", "save my files"],
        "steps": [
            {"tool": "saraRagIndex", "args_template": {"path": "~/Documents", "limit_files": 100}},
            {"tool": "saraMemoryRemember", "args_template": {"kind": "action", "content": "User requested file backup at {timestamp}"}},
        ],
        "description": "Indexes Documents folder into knowledge base and logs the backup action.",
    },
    # "summarize my work" / "what did I do today"
    {
        "keywords": ["summarize", "what did i do", "today's work", "daily summary", "work summary"],
        "steps": [
            {"tool": "saraMemorySearch", "args_template": {"query": "today tasks completed work", "limit": 10}},
            {"tool": "saraExperienceList", "args_template": {}},
            {"tool": "saraGoalList", "args_template": {}},
        ],
        "description": "Retrieves memory entries, experiences, and active goals to build a work summary.",
    },
    # "focus mode" / "do not disturb"
    {
        "keywords": ["focus mode", "do not disturb", "concentration", "deep work"],
        "steps": [
            {"tool": "muteToggle", "args_template": {}},
            {"tool": "closeApplication", "args_template": {"name": "discord"}},
            {"tool": "closeApplication", "args_template": {"name": "slack"}},
            {"tool": "saraMemoryRemember", "args_template": {"kind": "preference", "content": "User entered focus mode at {timestamp}"}},
        ],
        "description": "Enables focus mode: mutes, closes communication apps, logs the session.",
    },
    # "morning routine" / "good morning setup"
    {
        "keywords": ["morning", "good morning", "start day", "morning routine"],
        "steps": [
            {"tool": "systemInfo", "args_template": {}},
            {"tool": "saraMemorySearch", "args_template": {"query": "today schedule tasks", "limit": 5}},
            {"tool": "saraGoalList", "args_template": {}},
            {"tool": "openWebsite", "args_template": {"name": "gmail"}},
        ],
        "description": "Morning routine: system check, reviews goals, opens email.",
    },
]


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------

def _plan_steps(goal: str, user_steps: Optional[List[Dict[str, Any]]] = None) -> tuple[List[Dict[str, Any]], str]:
    """Return (steps, description) for the given goal string."""
    if user_steps:
        return user_steps, f"User-provided plan with {len(user_steps)} steps."

    goal_lower = goal.lower()
    best_match = None
    best_score = 0

    for intent in _INTENT_LIBRARY:
        score = sum(1 for kw in intent["keywords"] if kw in goal_lower)
        if score > best_score:
            best_score = score
            best_match = intent

    if best_match and best_score > 0:
        return best_match["steps"], best_match["description"]

    # Generic fallback: search memory + knowledge base
    return [
        {"tool": "saraMemorySearch", "args_template": {"query": goal, "limit": 5}},
        {"tool": "saraRagRetrieve", "args_template": {"query": goal, "limit": 5}},
        {"tool": "saraGoalCreate", "args_template": {"title": goal}},
    ], f"Generic plan: searching memory and knowledge base for context on '{goal}'."


# ---------------------------------------------------------------------------
# Template renderer
# ---------------------------------------------------------------------------

def _render_args(template: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    """Replace {placeholder} values in args_template with context values."""
    rendered: Dict[str, Any] = {}
    for key, value in template.items():
        if isinstance(value, str):
            try:
                rendered[key] = value.format(**context)
            except KeyError:
                rendered[key] = value
        else:
            rendered[key] = value
    return rendered


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

def _execute_steps(
    steps: List[Dict[str, Any]],
    context: Dict[str, Any],
    stop_on_failure: bool = False,
    max_retries: int = 1,
) -> List[Dict[str, Any]]:
    """Execute each step and return a trace list."""
    trace: List[Dict[str, Any]] = []
    timestamp = str(time.strftime("%Y-%m-%d %H:%M"))
    context["timestamp"] = timestamp

    for i, step in enumerate(steps):
        tool_name = step.get("tool") or step.get("name") or ""
        args_template = step.get("args_template") or step.get("args") or {}
        args = _render_args(args_template, context)
        step_record: Dict[str, Any] = {
            "step": i + 1,
            "tool": tool_name,
            "args": args,
            "started_at": time.time(),
        }

        handler = TOOLS.get(tool_name)
        if not handler:
            step_record["status"] = "skipped"
            step_record["reason"] = f"Tool '{tool_name}' not available in current registry."
            step_record["finished_at"] = time.time()
            trace.append(step_record)
            continue

        last_error: Optional[str] = None
        for attempt in range(max_retries + 1):
            try:
                result = handler(args)
                step_record["status"] = "completed"
                step_record["result"] = result
                step_record["attempt"] = attempt + 1
                break
            except ToolError as e:
                last_error = e.message
                if attempt >= max_retries:
                    step_record["status"] = "failed"
                    step_record["error"] = last_error
            except Exception as e:  # noqa: BLE001
                last_error = str(e)
                if attempt >= max_retries:
                    step_record["status"] = "failed"
                    step_record["error"] = last_error
            time.sleep(0.5)

        step_record["finished_at"] = time.time()
        trace.append(step_record)

        if step_record.get("status") == "failed" and stop_on_failure:
            break

    return trace


# ---------------------------------------------------------------------------
# Registered Tool
# ---------------------------------------------------------------------------

@register(
    "saraUniversalCommand",
    description=(
        "Universal Command Center — give SARA a high-level goal in plain language "
        "and she will automatically decompose it into steps, execute them, and report back. "
        "Examples: 'Prepare tomorrow's meeting', 'Start my project', 'Check system health', "
        "'Morning routine', 'Focus mode', 'Summarize my work today'. "
        "Optionally pass explicit steps as a list of {tool, args} objects."
    ),
    tags=["orchestration", "goal", "planning", "automation"],
    permission_level="LOW",
    risk_level="LOW",
)
def sara_universal_command(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Universal Command Center: goal → plan → execute → report.
    
    Args:
        goal (str): High-level natural-language objective.
        steps (list, optional): Explicit step list [{tool, args}]. Overrides planner.
        context (dict, optional): Extra context variables for step templates.
        stop_on_failure (bool, optional): Stop if any step fails (default False).
    """
    goal = str(args.get("goal") or args.get("command") or "").strip()
    if not goal:
        raise ToolError("Parameter 'goal' is required. Describe what you want to accomplish.")

    user_steps = args.get("steps")
    context = dict(args.get("context") or {})
    context["goal"] = goal
    stop_on_failure = bool(args.get("stop_on_failure", False))
    max_retries = int(args.get("max_retries", 1))

    # Plan
    steps, plan_description = _plan_steps(goal, user_steps)

    # Execute
    start = time.time()
    trace = _execute_steps(steps, context, stop_on_failure=stop_on_failure, max_retries=max_retries)
    elapsed_ms = int((time.time() - start) * 1000)

    # Build report
    completed = [s for s in trace if s.get("status") == "completed"]
    failed = [s for s in trace if s.get("status") == "failed"]
    skipped = [s for s in trace if s.get("status") == "skipped"]

    overall_status = "completed" if not failed else ("partial" if completed else "failed")

    # Persist experience
    try:
        EXPERIENCES.record(
            task=goal,
            action="saraUniversalCommand",
            result=overall_status,
            success=overall_status != "failed",
            user_feedback="",
            execution_time_ms=elapsed_ms,
            error="; ".join(s.get("error", "") for s in failed) if failed else "",
            recovery="",
            metadata={"plan": plan_description, "steps_count": len(steps)},
        )
    except Exception:
        pass

    # Memory note
    try:
        MEMORY.remember(
            "action",
            f"Executed universal command: '{goal}' — {overall_status} in {elapsed_ms}ms.",
            {"goal": goal, "status": overall_status},
        )
    except Exception:
        pass

    summary_lines = [f"Goal: {goal}", f"Plan: {plan_description}", ""]
    for step in trace:
        icon = {"completed": "✓", "failed": "✗", "skipped": "⊘"}.get(step.get("status", ""), "?")
        summary_lines.append(f"  {icon} Step {step['step']}: {step['tool']} — {step.get('status')}")
        if step.get("error"):
            summary_lines.append(f"      Error: {step['error']}")

    summary_lines += [
        "",
        f"Result: {len(completed)}/{len(trace)} steps succeeded | {elapsed_ms}ms total",
    ]

    return {
        "result": "\n".join(summary_lines),
        "goal": goal,
        "status": overall_status,
        "plan": plan_description,
        "steps_total": len(trace),
        "steps_completed": len(completed),
        "steps_failed": len(failed),
        "steps_skipped": len(skipped),
        "execution_time_ms": elapsed_ms,
        "trace": trace,
    }


__all__ = ["sara_universal_command"]
