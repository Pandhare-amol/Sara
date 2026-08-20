"""Browser automation suite tools for SARA."""

from __future__ import annotations

from typing import Any, Dict

from .browser_automation_suite import BROWSER_AUTOMATION_SUITE
from .registry import register


@register("saraBrowserPlan")
def sara_browser_plan(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": BROWSER_AUTOMATION_SUITE.plan(str(args.get("goal") or args.get("request") or ""))}


@register("saraBrowserExecute")
def sara_browser_execute(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": BROWSER_AUTOMATION_SUITE.execute(
            str(args.get("action") or "open"),
            args.get("args") or {},
            bool(args.get("confirmed", False)),
        )
    }


@register("saraBrowserExecuteGoal")
def sara_browser_execute_goal(args: Dict[str, Any]) -> Dict[str, Any]:
    request = str(args.get("goal") or args.get("request") or "")
    plan = BROWSER_AUTOMATION_SUITE.plan(request)
    confirmed = bool(args.get("confirmed", False))
    if plan.get("requires_confirmation") and not confirmed:
        return {"result": {"requires_confirmation": True, "plan": plan, "result": "Confirmation required before browser execution."}}
    if plan.get("action") == "workflow":
        result = BROWSER_AUTOMATION_SUITE.execute_workflow(plan.get("steps") or [], confirmed=confirmed)
    else:
        result = BROWSER_AUTOMATION_SUITE.execute(str(plan.get("action") or "open"), plan.get("args") or {}, confirmed=confirmed)
    return {"result": {"plan": plan, "execution": result, "result": result.get("result", result)}}
