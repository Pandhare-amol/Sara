"""Tool adapters for SARA's local social-intelligence policy."""

from __future__ import annotations

from typing import Any, Dict

from .registry import register
from .social_intelligence import SOCIAL_INTELLIGENCE


@register("saraSocialPlanResponse")
def sara_social_plan_response(args: Dict[str, Any]) -> Dict[str, Any]:
    text = str(args.get("text") or args.get("message") or "")
    context = args.get("context") if isinstance(args.get("context"), dict) else {}
    return {"result": SOCIAL_INTELLIGENCE.plan_response(text, context)}


@register("saraSocialRecordTurn")
def sara_social_record_turn(args: Dict[str, Any]) -> Dict[str, Any]:
    text = str(args.get("text") or args.get("message") or "")
    context = args.get("context") if isinstance(args.get("context"), dict) else {}
    return {"result": SOCIAL_INTELLIGENCE.record_turn(text, context)}


@register("saraSocialShouldRespond")
def sara_social_should_respond(args: Dict[str, Any]) -> Dict[str, Any]:
    context = args.get("context") if isinstance(args.get("context"), dict) else args
    return {"result": SOCIAL_INTELLIGENCE.should_respond(context)}


@register("saraSocialSettings")
def sara_social_settings(args: Dict[str, Any]) -> Dict[str, Any]:
    patch = args.get("settings") if isinstance(args.get("settings"), dict) else args
    return {"result": SOCIAL_INTELLIGENCE.update_settings(patch)}


@register("saraSocialStatus")
def sara_social_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SOCIAL_INTELLIGENCE.snapshot()}
