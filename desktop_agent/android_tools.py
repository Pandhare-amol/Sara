"""Tool handlers for the Android companion integration."""

from __future__ import annotations

from typing import Any, Dict

from .android_companion import ANDROID_COMPANION_MANAGER
from .registry import register


@register("saraAndroidPair")
def sara_android_pair(args: Dict[str, Any]) -> Dict[str, Any]:
    name = str(args.get("name") or "Android Device")
    token = str(args.get("token") or "sara-token")
    device = ANDROID_COMPANION_MANAGER.register_device(name, token)
    return {"result": device}


@register("saraAndroidPlan")
def sara_android_plan(args: Dict[str, Any]) -> Dict[str, Any]:
    request = str(args.get("request") or args.get("goal") or "")
    return {"result": ANDROID_COMPANION_MANAGER.plan_action(request)}


@register("saraAndroidExecute")
def sara_android_execute(args: Dict[str, Any]) -> Dict[str, Any]:
    device_id = str(args.get("device_id") or args.get("device") or "")
    payload = args.get("payload") or {}
    command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, payload)
    return {"result": command}
