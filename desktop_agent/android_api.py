"""Simple API helpers for a future Android companion server endpoint."""

from __future__ import annotations

from typing import Any, Dict

from .android_companion import ANDROID_COMPANION_MANAGER


def pair_device(name: str, token: str) -> Dict[str, Any]:
    return ANDROID_COMPANION_MANAGER.register_device(name, token)


def queue_action(device_id: str, action: str, value: Any) -> Dict[str, Any]:
    return ANDROID_COMPANION_MANAGER.enqueue_command(device_id, {"action": action, "value": value})


def list_devices() -> list[Dict[str, Any]]:
    return ANDROID_COMPANION_MANAGER.list_devices()


def update_device_status(device_id: str, status: Dict[str, Any]) -> Dict[str, Any]:
    return ANDROID_COMPANION_MANAGER.update_device_status(device_id, status)


def get_device_status(device_id: str) -> Dict[str, Any]:
    return ANDROID_COMPANION_MANAGER.get_device_status(device_id)


def store_sensitive_data(key: str, value: str) -> None:
    ANDROID_COMPANION_MANAGER.store_sensitive_data(key, value)


def load_sensitive_data(key: str) -> str | None:
    return ANDROID_COMPANION_MANAGER.load_sensitive_data(key)


def plan_mobile_action(request: str) -> Dict[str, Any]:
    return ANDROID_COMPANION_MANAGER.plan_action(request)
