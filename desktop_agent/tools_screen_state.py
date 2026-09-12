"""Registered, demand-driven screen state tools."""

from __future__ import annotations

from typing import Any, Dict

from .registry import register
from .screen_state_manager import SCREEN_STATE


@register("observeScreen")
def observe_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Screen state observed.", **SCREEN_STATE.current(bool(args.get("refresh")), str(args.get("reason") or "observe"))}


@register("getCurrentScreenState")
def get_current_screen_state(args: Dict[str, Any]) -> Dict[str, Any]:
    return observe_screen(args)


@register("refreshScreenState")
def refresh_screen_state(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    payload["refresh"] = True
    return observe_screen(payload)


@register("waitForScreenChange")
def wait_for_screen_change(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Screen change wait completed.", **SCREEN_STATE.wait_for_change(args.get("timeout", 5), args.get("poll_interval", 0.25))}
