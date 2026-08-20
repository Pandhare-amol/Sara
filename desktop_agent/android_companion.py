"""Android companion integration for SARA.

This module adds a lightweight, modular companion layer that can track paired
Android devices, queue automation commands, and expose a simple API that the
existing SARA desktop agent can call.
"""

from __future__ import annotations

import base64
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from cryptography.fernet import Fernet


class AndroidCompanionManager:
    """Manages paired Android devices and queued automation commands."""

    def __init__(self, storage_dir: Optional[Path] = None) -> None:
        self.storage_dir = storage_dir or Path(__file__).resolve().parent.parent / "logs"
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.devices_path = self.storage_dir / "android_devices.json"
        self.commands_path = self.storage_dir / "android_commands.json"
        self.secrets_path = self.storage_dir / "android_secrets.json"
        self.key_path = self.storage_dir / ".android_companion.key"
        self.devices: Dict[str, Dict[str, Any]] = self._load_json(self.devices_path, default={})
        self.commands: Dict[str, List[Dict[str, Any]]] = self._load_json(self.commands_path, default={})
        self._fernet = self._load_or_create_fernet()

    def register_device(self, name: str, token: str) -> Dict[str, Any]:
        device_id = uuid.uuid4().hex[:8]
        device = {
            "id": device_id,
            "name": name,
            "token": token,
            "status": "paired",
            "connected": False,
            "last_seen": int(time.time()),
            "capabilities": [
                "notifications",
                "sms",
                "calls",
                "contacts",
                "files",
                "camera",
                "screen",
                "clipboard",
                "location",
                "battery",
                "settings",
            ],
            "meta": {
                "battery_level": None,
                "is_charging": False,
                "storage_total_mb": None,
                "storage_available_mb": None,
                "device_model": None,
                "android_version": None,
                "network_type": None,
            },
        }
        self.devices[device_id] = device
        self.commands.setdefault(device_id, [])
        self._save_json(self.devices_path, self.devices)
        return device

    def list_devices(self) -> List[Dict[str, Any]]:
        return list(self.devices.values())

    def get_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        return self.devices.get(device_id)

    def authenticate_device(self, device_id: str, token: str) -> Dict[str, Any]:
        resolved_id = self._resolve_device_id(device_id)
        device = self.devices[resolved_id]
        if token and device.get("token") != token:
            raise PermissionError("Invalid device token")
        device["connected"] = True
        device["last_seen"] = int(time.time())
        self._save_json(self.devices_path, self.devices)
        return device

    def enqueue_command(self, device_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        resolved_id = self._resolve_device_id(device_id)
        command = {
            "id": uuid.uuid4().hex[:8],
            "created_at": int(time.time()),
            "payload": payload,
            "status": "queued",
            "action": payload.get("action"),
            "value": payload.get("value"),
        }
        self.commands.setdefault(resolved_id, []).append(command)
        self._save_json(self.commands_path, self.commands)
        return command

    def get_pending_commands(self, device_id: str) -> List[Dict[str, Any]]:
        resolved_id = self._resolve_device_id(device_id)
        return [cmd for cmd in self.commands.get(resolved_id, []) if cmd.get("status") == "queued"]

    def mark_command_done(self, device_id: str, command_id: str) -> None:
        resolved_id = self._resolve_device_id(device_id)
        for cmd in self.commands.get(resolved_id, []):
            if cmd.get("id") == command_id:
                cmd["status"] = "done"
                break
        self._save_json(self.commands_path, self.commands)

    def update_device_status(self, device_id: str, status: Dict[str, Any]) -> Dict[str, Any]:
        resolved_id = self._resolve_device_id(device_id)
        device = self.devices[resolved_id]
        device.setdefault("meta", {})
        device["meta"].update(status)
        device["connected"] = True
        device["last_seen"] = int(time.time())
        self._save_json(self.devices_path, self.devices)
        return device

    def get_device_status(self, device_id: str) -> Dict[str, Any]:
        resolved_id = self._resolve_device_id(device_id)
        return self.devices[resolved_id].get("meta", {})

    def store_sensitive_data(self, key: str, value: str) -> None:
        payload = self._load_json(self.secrets_path, default={})
        payload[key] = self._fernet.encrypt(value.encode("utf-8")).decode("utf-8")
        self._save_json(self.secrets_path, payload)

    def load_sensitive_data(self, key: str) -> Optional[str]:
        payload = self._load_json(self.secrets_path, default={})
        encrypted = payload.get(key)
        if not encrypted:
            return None
        return self._fernet.decrypt(encrypted.encode("utf-8")).decode("utf-8")

    def plan_action(self, request: str) -> Dict[str, Any]:
        low = request.lower()
        requires_confirmation = any(word in low for word in ["delete", "remove", "send", "call", "share", "message"])
        if "flashlight" in low:
            return {"action": "flashlight", "value": True, "requires_confirmation": False}
        if "brightness" in low:
            return {"action": "brightness", "value": 50, "requires_confirmation": False}
        if "notification" in low:
            return {"action": "notifications", "value": "list", "requires_confirmation": False}
        if "sms" in low or "message" in low:
            return {"action": "sms", "value": "read", "requires_confirmation": requires_confirmation}
        if "camera" in low or "selfie" in low:
            return {"action": "camera", "value": "capture", "requires_confirmation": False}
        if "call" in low:
            return {"action": "calls", "value": "dial", "requires_confirmation": requires_confirmation}
        if "whatsapp" in low:
            return {"action": "whatsapp", "value": "open", "requires_confirmation": False}
        if "telegram" in low:
            return {"action": "telegram", "value": "open", "requires_confirmation": False}
        if "instagram" in low:
            return {"action": "instagram", "value": "open", "requires_confirmation": False}
        if "gallery" in low or "photo" in low or "video" in low:
            return {"action": "gallery", "value": "browse", "requires_confirmation": False}
        if "contact" in low:
            return {"action": "contacts", "value": "search", "requires_confirmation": False}
        if "clipboard" in low:
            return {"action": "clipboard", "value": "read", "requires_confirmation": False}
        if "wifi" in low:
            return {"action": "wifi", "value": True, "requires_confirmation": False}
        if "volume" in low:
            return {"action": "volume", "value": 10, "requires_confirmation": False}
        if "location" in low or "gps" in low:
            return {"action": "location", "value": "request", "requires_confirmation": False}
        if "battery" in low:
            return {"action": "battery", "value": "status", "requires_confirmation": False}
        if "file" in low or "folder" in low or "download" in low or "pdf" in low:
            return {"action": "files", "value": "browse", "requires_confirmation": requires_confirmation}
        return {"action": "noop", "value": None, "requires_confirmation": False}

    def _resolve_device_id(self, device_id: str) -> str:
        if device_id in self.devices:
            return device_id
        for candidate_id, device in self.devices.items():
            if device.get("name") == device_id:
                return candidate_id
        raise ValueError(f"Unknown device {device_id}")

    def _load_or_create_fernet(self) -> Fernet:
        if self.key_path.exists():
            key = self.key_path.read_text(encoding="utf-8").strip().encode("utf-8")
        else:
            key = Fernet.generate_key()
            self.key_path.write_text(key.decode("utf-8"), encoding="utf-8")
        return Fernet(key)

    def _load_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _save_json(self, path: Path, data: Any) -> None:
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")


ANDROID_COMPANION_MANAGER = AndroidCompanionManager()
