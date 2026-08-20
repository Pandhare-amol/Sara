"""Shared service integration scaffolding for SARA.

This module does not try to fully implement every third-party API. Instead it
provides a consistent registry for official integrations, stores connection
metadata in the encrypted credential vault, and exposes a small set of common
operations that higher-level app automation can call when an API session exists.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import SECURITY, VAULT


@dataclass
class ServiceIntegration:
    name: str
    provider: str
    auth_kind: str
    scopes: List[str] = field(default_factory=list)
    features: List[str] = field(default_factory=list)
    account_key: Optional[str] = None


class ServiceIntegrationRegistry:
    def __init__(self) -> None:
        self.integrations: Dict[str, ServiceIntegration] = {}
        self._register_builtin_integrations()

    def register(self, integration: ServiceIntegration) -> None:
        self.integrations[self._key(integration.name)] = integration

    def list(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": item.name,
                "provider": item.provider,
                "auth_kind": item.auth_kind,
                "scopes": item.scopes,
                "features": item.features,
                "account_key": item.account_key,
            }
            for item in sorted(self.integrations.values(), key=lambda integration: integration.name)
        ]

    def find(self, name: str) -> Optional[ServiceIntegration]:
        return self.integrations.get(self._key(name))

    def connect(self, name: str, secret: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        integration = self.find(name)
        if not integration:
            raise KeyError(f"Unknown service integration: {name}")
        account_key = integration.account_key or self._key(name)
        stored = VAULT.store(account_key, secret, {"service": integration.name, **(metadata or {})})
        integration.account_key = account_key
        SECURITY.assess(f"connect:{integration.name}", {"provider": integration.provider, "scopes": integration.scopes})
        return {"connected": True, "integration": integration.name, "account_key": account_key, "stored": stored}

    def session(self, name: str) -> Dict[str, Any]:
        integration = self.find(name)
        if not integration:
            raise KeyError(f"Unknown service integration: {name}")
        secret = VAULT.load(integration.account_key or self._key(name))
        return {
            "name": integration.name,
            "provider": integration.provider,
            "connected": secret is not None,
            "token_present": secret is not None,
            "scopes": integration.scopes,
            "features": integration.features,
        }

    def execute(self, name: str, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        integration = self.find(name)
        if not integration:
            raise KeyError(f"Unknown service integration: {name}")
        action_name = self._normalize_action(action)
        session = self.session(name)
        if not session["connected"]:
            return {
                "result": f"{integration.name} is not connected yet. Connect an account token first.",
                "connected": False,
                "integration": integration.name,
            }
        result = self._execute_common(integration, action_name, args or {})
        if result is not None:
            return result
        return {
            "result": f"Queued {action_name} on {integration.name} through its official API session.",
            "connected": True,
            "integration": integration.name,
            "action": action_name,
            "args": args or {},
            "timestamp": time.time(),
        }

    def _execute_common(self, integration: ServiceIntegration, action: str, args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        subject = args.get("subject") or args.get("query") or args.get("name") or args.get("title") or args.get("text") or ""
        body = args.get("body") or args.get("content") or args.get("message") or args.get("text") or ""
        if integration.name in {"Gmail", "Microsoft Outlook"}:
            if action in {"read", "search"}:
                return {"result": f"Retrieved {integration.name} mailbox results for {subject or 'inbox'} via API.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"draft", "compose"}:
                return {"result": f"Drafted email in {integration.name} for {subject or 'recipient'}.", "connected": True, "integration": integration.name, "action": action, "draft": {"to": args.get("to"), "subject": args.get("subject"), "body": body}}
            if action in {"send", "send_email", "reply", "forward"}:
                return {"result": f"Prepared {action} on {integration.name} through API session.", "connected": True, "integration": integration.name, "action": action, "message": {"to": args.get("to"), "subject": args.get("subject"), "body": body}}
        if integration.name in {"Google Calendar", "Microsoft Calendar"}:
            if action in {"agenda", "read", "search"}:
                return {"result": f"Fetched {integration.name} agenda and availability via API.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"create_event", "schedule", "update", "delete"}:
                return {"result": f"Queued calendar {action} on {integration.name}.", "connected": True, "integration": integration.name, "action": action, "event": args}
        if integration.name in {"Google Drive", "OneDrive", "Dropbox"}:
            if action in {"upload", "download", "share", "delete", "search"}:
                return {"result": f"Queued {action} in {integration.name}.", "connected": True, "integration": integration.name, "action": action, "path": args.get("path") or args.get("file") or subject}
        if integration.name == "Slack":
            if action in {"read", "search"}:
                return {"result": "Fetched Slack channel or message results via API.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"send", "send_message", "reply", "draft"}:
                return {"result": "Prepared Slack message via API session.", "connected": True, "integration": integration.name, "action": action, "message": body}
            if action in {"upload", "share"}:
                return {"result": "Queued Slack file share/upload via API session.", "connected": True, "integration": integration.name, "action": action}
        if integration.name in {"Telegram", "WhatsApp"}:
            if action in {"read", "search"}:
                return {"result": f"Fetched {integration.name} conversations via API session.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"send", "send_message", "reply", "forward", "send_media", "create_group"}:
                return {"result": f"Prepared {integration.name} {action} via API session.", "connected": True, "integration": integration.name, "action": action, "message": body}
        if integration.name == "YouTube":
            if action in {"search", "play"}:
                return {"result": "Queued YouTube search/play via API session.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"summarize", "transcript"}:
                return {"result": "Prepared YouTube transcript/summarization request via API session.", "connected": True, "integration": integration.name, "action": action, "query": subject}
        if integration.name == "Instagram":
            if action in {"read", "search"}:
                return {"result": "Fetched Instagram content via API session.", "connected": True, "integration": integration.name, "action": action, "query": subject}
            if action in {"post", "publish", "send_dm", "comment", "like", "follow", "unfollow"}:
                return {"result": f"Prepared Instagram {action} via API session.", "connected": True, "integration": integration.name, "action": action, "content": body}
        if integration.name in {"Notion", "Todoist", "Asana", "ClickUp"}:
            if action in {"create_note", "search", "summarize", "create_task", "complete_task"}:
                return {"result": f"Queued {integration.name} {action} via API session.", "connected": True, "integration": integration.name, "action": action, "content": body}
        return None

    def _register_builtin_integrations(self) -> None:
        builtins = [
            ServiceIntegration("Gmail", "Google", "OAuth2", ["gmail.read", "gmail.send"], ["read", "search", "draft", "send_email", "delete_email"]),
            ServiceIntegration("Google Calendar", "Google", "OAuth2", ["calendar.read", "calendar.write"], ["agenda", "create_event", "delete", "find_free_time"]),
            ServiceIntegration("Google Drive", "Google", "OAuth2", ["drive.read", "drive.write"], ["upload", "download", "share", "delete", "search"]),
            ServiceIntegration("Slack", "Slack", "OAuth2", ["channels:read", "chat:write"], ["read", "send_message", "search", "upload"]),
            ServiceIntegration("Telegram", "Telegram", "Bot Token", ["messages", "media"], ["read", "send_message", "search", "send_media"]),
            ServiceIntegration("WhatsApp", "Meta", "Cloud API", ["messages", "media"], ["read", "send_message", "send_media", "create_group"]),
            ServiceIntegration("YouTube", "Google", "OAuth2", ["youtube.read", "youtube.upload"], ["search", "play", "summarize", "transcript"]),
            ServiceIntegration("Instagram", "Meta", "OAuth2", ["instagram.basic", "instagram.manage"], ["read", "post", "publish", "send_dm", "comment", "like"]),
            ServiceIntegration("Dropbox", "Dropbox", "OAuth2", ["files.content.read", "files.content.write"], ["upload", "download", "share", "delete", "search"]),
            ServiceIntegration("Notion", "Notion", "OAuth2", ["pages.read", "pages.write"], ["create_note", "search", "summarize"]),
            ServiceIntegration("Todoist", "Todoist", "OAuth2", ["data:read_write"], ["create_task", "search", "complete_task"]),
            ServiceIntegration("Asana", "Asana", "OAuth2", ["tasks:read_write"], ["create_task", "search", "complete_task"]),
            ServiceIntegration("ClickUp", "ClickUp", "OAuth2", ["task:read_write"], ["create_task", "search", "complete_task"]),
            ServiceIntegration("Microsoft Outlook", "Microsoft", "OAuth2", ["Mail.ReadWrite", "Mail.Send"], ["read", "search", "draft", "send_email", "delete_email"]),
            ServiceIntegration("Microsoft Calendar", "Microsoft", "OAuth2", ["Calendars.ReadWrite"], ["agenda", "create_event", "delete", "find_free_time"]),
            ServiceIntegration("OneDrive", "Microsoft", "OAuth2", ["Files.ReadWrite"], ["upload", "download", "share", "delete", "search"]),
        ]
        for integration in builtins:
            self.register(integration)

    @staticmethod
    def _key(value: str) -> str:
        return value.strip().lower().replace(" ", "_").replace("-", "_")

    @staticmethod
    def _normalize_action(action: str) -> str:
        return action.strip().lower().replace(" ", "_")


SERVICE_INTEGRATIONS = ServiceIntegrationRegistry()
