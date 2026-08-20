"""SARA Application Automation Suite tools."""

from __future__ import annotations

from typing import Any, Dict

from .app_automation_suite import APP_SUITE
from .registry import register


@register("saraAppListPlugins")
def sara_app_list_plugins(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": APP_SUITE.list_plugins()}


@register("saraAppPlan")
def sara_app_plan(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": APP_SUITE.plan(str(args.get("goal") or args.get("request") or ""))}


@register("saraAppExecute")
def sara_app_execute(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": APP_SUITE.execute(
            str(args.get("app") or ""),
            str(args.get("action") or "open"),
            args.get("args") or {},
            bool(args.get("confirmed", False)),
        )
    }


@register("saraAppExecuteGoal")
def sara_app_execute_goal(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": APP_SUITE.execute_goal(str(args.get("goal") or args.get("request") or ""), bool(args.get("confirmed", False)))}
