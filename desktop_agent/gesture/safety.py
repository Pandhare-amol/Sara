from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Mapping, Optional


DEFAULT_DANGEROUS_TOOLS = {
    "deleteFile",
    "deleteFolder",
    "shutdown",
    "restart",
    "power_shutdown",
    "power_restart",
    "executePowerAction",
    "requestPowerAction",
    "sendExternalMessage",
    "send_email",
    "email_send",
    "whatsapp_send",
    "whatsapp_group_send",
    "purchase",
}


@dataclass
class GestureSafetyManager:
    dangerous_tools: set[str] = field(default_factory=lambda: set(DEFAULT_DANGEROUS_TOOLS))

    def requires_confirmation(self, tool_name: str, args: Optional[Mapping[str, Any]] = None) -> bool:
        payload = dict(args or {})
        if payload.get("confirmed") or payload.get("confirmation") or payload.get("execute_token"):
            return False
        return tool_name in self.dangerous_tools

    def is_allowed(self, gesture: str, tool_name: str, args: Optional[Mapping[str, Any]] = None) -> bool:
        if self.requires_confirmation(tool_name, args):
            return False
        return True

    def validate_mapping(self, gesture: str, mapping: Mapping[str, Any]) -> bool:
        tool = str(mapping.get("tool") or "").strip()
        if not tool:
            return False
        if tool in self.dangerous_tools:
            return False
        return True
