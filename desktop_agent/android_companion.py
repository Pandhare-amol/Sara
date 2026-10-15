"""Android companion integration for SARA.

This module adds a lightweight, modular companion layer that can track paired
Android devices, queue automation commands, and expose a simple API that the
existing SARA desktop agent can call.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from cryptography.fernet import Fernet


class AndroidCompanionManager:
    """Manages paired Android devices and queued automation commands."""

    def __init__(self, storage_dir: Optional[Path] = None) -> None:
        configured_dir = os.environ.get("SARA_DATA_DIR")
        default_dir = Path(configured_dir) if configured_dir else Path(__file__).resolve().parent.parent / "data"
        self.storage_dir = Path(storage_dir) if storage_dir is not None else default_dir
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        # Node and Python share this one canonical, per-user registry. The file
        # contains an array so the Node backend can verify its hashed entries.
        self.devices_path = self.storage_dir / "companions.json"
        self.commands_path = self.storage_dir / "android_commands.json"
        self.secrets_path = self.storage_dir / "android_secrets.json"
        self.key_path = self.storage_dir / ".android_companion.key"
        self.devices: Dict[str, Dict[str, Any]] = self._load_devices()
        self.commands: Dict[str, List[Dict[str, Any]]] = self._load_json(self.commands_path, default={})
        self._fernet = self._load_or_create_fernet()

    def register_device(self, name: str, token: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        clean_name = str(name or "Android Device").strip()[:120] or "Android Device"
        clean_token = str(token or "")
        if len(clean_token) < 32:
            raise ValueError("A strong, explicitly supplied companion token is required.")

        resolved_id = str(device_id or secrets.token_hex(8)).strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", resolved_id):
            raise ValueError("Invalid companion device ID.")

        existing = self.devices.get(resolved_id)
        if existing:
            if not self._verify_token(existing, clean_token):
                raise ValueError("Companion device ID is already registered.")
            if isinstance(existing.get("token"), str) or existing.get("token_hash"):
                token_salt = secrets.token_hex(16)
                existing["hash"] = self._hash_token(clean_token, token_salt)
                existing["salt"] = token_salt
                existing.pop("token", None)
                existing.pop("token_hash", None)
                existing.pop("token_salt", None)
            existing["name"] = clean_name
            existing.setdefault("status", "paired")
            existing.setdefault("connected", False)
            existing.setdefault("last_seen", int(time.time()))
            self._save_devices()
            return self._public_device(existing)

        token_salt = secrets.token_hex(16)
        token_hash = self._hash_token(clean_token, token_salt)
        device = {
            "id": resolved_id,
            "name": clean_name,
            "hash": token_hash,
            "salt": token_salt,
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
        self.devices[resolved_id] = device
        self.commands.setdefault(resolved_id, [])
        self._save_devices()
        return self._public_device(device)

    def list_devices(self) -> List[Dict[str, Any]]:
        return [self._public_device(device) for device in self.devices.values()]

    def get_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        device = self.devices.get(device_id)
        return self._public_device(device) if device else None

    def authenticate_device(self, device_id: str, token: str) -> Dict[str, Any]:
        # Authentication must use the opaque stable ID, never a display name.
        if device_id not in self.devices:
            raise PermissionError("Invalid companion credentials")
        device = self.devices[device_id]
        if not self._verify_token(device, str(token or "")):
            raise PermissionError("Invalid companion credentials")

        # Upgrade a legacy plaintext record only after a successful credential check.
        if isinstance(device.get("token"), str):
            token_salt = secrets.token_hex(16)
            device["hash"] = self._hash_token(str(token), token_salt)
            device["salt"] = token_salt
            device.pop("token", None)
            device.pop("token_hash", None)
            device.pop("token_salt", None)

        device["connected"] = True
        device["last_seen"] = int(time.time())
        self._save_devices()
        return self._public_device(device)

    def enqueue_command(self, device_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        resolved_id = self._resolve_device_id(device_id)
        safe_payload = {
            key: value
            for key, value in payload.items()
            if str(key).lower() not in {"token", "device_id", "device"}
        }
        command = {
            "id": uuid.uuid4().hex[:8],
            "created_at": int(time.time()),
            "payload": safe_payload,
            "status": "queued",
            "action": safe_payload.get("action"),
            "value": safe_payload.get("value"),
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
        self._save_devices()
        return self._public_device(device)

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

    @staticmethod
    def _hash_token(token: str, salt: str) -> str:
        return hashlib.scrypt(
            token.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=64,
        ).hex()

    @classmethod
    def _verify_token(cls, device: Dict[str, Any], token: str) -> bool:
        if not token:
            return False
        stored_hash = device.get("token_hash") or device.get("hash")
        salt = device.get("token_salt") or device.get("salt")
        if isinstance(stored_hash, str) and isinstance(salt, str):
            try:
                expected = bytes.fromhex(stored_hash)
                actual = bytes.fromhex(cls._hash_token(token, salt))
            except (ValueError, TypeError):
                return False
            return len(expected) == len(actual) and hmac.compare_digest(expected, actual)
        legacy_token = device.get("token")
        return isinstance(legacy_token, str) and hmac.compare_digest(legacy_token, token)

    @staticmethod
    def _public_device(device: Dict[str, Any]) -> Dict[str, Any]:
        public = copy.deepcopy(device)
        for key in ("token", "token_hash", "token_salt", "hash", "salt"):
            public.pop(key, None)
        return public

    def _resolve_device_id(self, device_id: str) -> str:
        if device_id in self.devices:
            return device_id
        for candidate_id, device in self.devices.items():
            if device.get("name") == device_id:
                return candidate_id
        raise ValueError(f"Unknown device {device_id}")

    def _load_devices(self) -> Dict[str, Dict[str, Any]]:
        """Load the shared Node/Python registry; never import the old tracked logs registry."""
        raw = self._load_json(self.devices_path, default=[])
        if isinstance(raw, dict):
            candidates = list(raw.values())
        elif isinstance(raw, list):
            candidates = raw
        else:
            candidates = []

        devices: Dict[str, Dict[str, Any]] = {}
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            device_id = str(candidate.get("id") or candidate.get("device_id") or "").strip()
            if device_id:
                devices[device_id] = candidate
        return devices

    def _save_devices(self) -> None:
        self._save_json(self.devices_path, list(self.devices.values()))

    def _load_or_create_fernet(self) -> Fernet:
        try:
            key = self.key_path.read_bytes().strip()
        except FileNotFoundError:
            key = Fernet.generate_key()
            try:
                descriptor = os.open(str(self.key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as key_file:
                    key_file.write(key)
            except FileExistsError:
                key = self.key_path.read_bytes().strip()
            except OSError:
                # Keep the key in memory if the data directory is read-only; a
                # later restart will not decrypt prior values, so report it.
                key = Fernet.generate_key()
        try:
            os.chmod(self.key_path, 0o600)
        except OSError:
            pass
        return Fernet(key)

    def _load_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _save_json(self, path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temporary_path = Path(temporary_name)
        try:
            try:
                os.fchmod(descriptor, 0o600)
            except (AttributeError, OSError):
                pass
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(data, output, indent=2)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        finally:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


ANDROID_COMPANION_MANAGER = AndroidCompanionManager()
