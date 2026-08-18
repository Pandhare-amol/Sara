"""
SARA master-orchestrator desktop tools.

These tools expose the internal multi-agent runtime to the existing Node/SARA
bridge. SARA remains the only component that should present results to users.
"""

from __future__ import annotations

from typing import Any, Dict

from .agents import MANAGER
from .registry import register


@register("saraAgentExecute")
def sara_agent_execute(args: Dict[str, Any]) -> Dict[str, Any]:
    goal = str(args.get("goal") or args.get("request") or "").strip()
    if not goal:
        return {"result": "No goal was provided.", "ok": False}
    priority = int(args.get("priority") or 5)
    external_plan = args.get("plan")
    return {"result": MANAGER.execute_for_sara(goal, priority=priority, external_plan=external_plan)}


@register("saraAgentStatus")
def sara_agent_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MANAGER.status()}


@register("saraAgentUnloadIdle")
def sara_agent_unload_idle(args: Dict[str, Any]) -> Dict[str, Any]:
    force = bool(args.get("force", False))
    return {"result": MANAGER.unload_idle_agents(force=force)}


@register("saraAgentEmergencyStop")
def sara_agent_emergency_stop(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MANAGER.emergency_stop()}
