"""Isolated, domain-restricted Playwright operations for reviewed SARA workflows.

Separate from the user's persistent automation profile. A routed request for any
other host (including redirects and subresources) is blocked; no browser JS,
coordinates, shell, or generic selector is exposed to workflow plans.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from .registry import ToolError, register
from .tools_browser import HEADLESS, _run

SESSION_TTL = 15 * 60
MAX_SESSIONS = 2
SESSIONS: dict[str, "WorkflowSession"] = {}


@dataclass
class WorkflowSession:
    playwright: Any
    browser: Any
    context: Any
    page: Any
    host: str
    touched: float


def safe_host_url(url: str, expected_host: str | None = None) -> str:
    """Check syntax and DNS. This alone cannot prevent DNS rebinding."""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError("Only public HTTPS on port 443 is allowed.")
        if not host or "." not in host or len(host) > 253 or any(c.isspace() for c in host):
            raise ValueError("A public hostname is required.")
        if expected_host is not None and host != expected_host:
            raise ValueError("This workflow is limited to its approved hostname.")
        if host == "localhost" or host.endswith((".local", ".localhost", ".internal", ".test", ".invalid")):
            raise ValueError("Local and reserved domains are forbidden.")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError("IP-literal browser targets are forbidden.")
        return host
    except (ValueError, OverflowError) as error:
        raise ToolError(str(error)) from error


def public_dns(host: str) -> bool:
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(entry[4][0]).is_global for entry in addresses)
    except (OSError, ValueError):
        return False


async def _close(task_id: str) -> None:
    session = SESSIONS.pop(task_id, None)
    if session:
        try:
            await session.browser.close()
        finally:
            await session.playwright.stop()


async def _workflow_async(args: dict[str, Any]) -> dict[str, Any]:
    task_id = args.get("taskId")
    operation = args.get("operation")
    if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", task_id):
        raise ToolError("A valid workflow task ID is required.")
    if operation == "close":
        await _close(task_id)
        return {"ok": True, "result": "Browser workflow closed."}
    if operation not in {"navigate", "read", "click", "fill", "inspect"}:
        raise ToolError("Unsupported browser workflow operation.")

    now = time.monotonic()
    for old_id, session in list(SESSIONS.items()):
        if now - session.touched > SESSION_TTL:
            await _close(old_id)
    session = SESSIONS.get(task_id)
    if not session:
        if operation != "navigate":
            raise ToolError("Browser session is unavailable. Do not replay a previous action.")
        url = args.get("url")
        if not isinstance(url, str):
            raise ToolError("A HTTPS starting URL is required.")
        host = safe_host_url(url)
        if not await asyncio.to_thread(public_dns, host):
            raise ToolError("Browser hostname does not resolve exclusively to public IP addresses.")
        if len(SESSIONS) >= MAX_SESSIONS:
            raise ToolError("Too many active browser workflows. Close an earlier task first.")
        from playwright.async_api import async_playwright
        playwright = await async_playwright().start()
        browser = None
        try:
            # Fail closed if Chromium's process sandbox is unavailable. Never
            # reuse the legacy browser's --no-sandbox launch for untrusted sites.
            browser = await playwright.chromium.launch(headless=HEADLESS, chromium_sandbox=True)
            context = await browser.new_context(accept_downloads=False, service_workers="block")
            async def reject_websocket(route):
                await route.close()
            await context.route_web_socket("**/*", reject_websocket)
            async def guard(route):
                try:
                    request_url = route.request.url
                    safe_host_url(request_url, host)
                    # Recheck DNS for every request, including redirects. This
                    # reduces but does not completely eliminate DNS-rebinding risk.
                    if not await asyncio.to_thread(public_dns, host):
                        raise ToolError("Non-public browser destination.")
                    await route.continue_()
                except Exception:
                    await route.abort()
            await context.route("**/*", guard)
            page = await context.new_page()
            session = WorkflowSession(playwright, browser, context, page, host, now)
            SESSIONS[task_id] = session
        except Exception:
            if browser:
                await browser.close()
            await playwright.stop()
            raise
    session.touched = now
    page = session.page

    try:
        if operation == "navigate":
            url = args.get("url")
            if not isinstance(url, str):
                raise ToolError("A HTTPS URL is required.")
            safe_host_url(url, session.host)
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            safe_host_url(page.url, session.host)
            return {"ok": True, "verified": False, "url": page.url, "result": "Navigation dispatched; inspect final URL."}
        safe_host_url(page.url, session.host)
        if operation == "read":
            return {"ok": True, "verified": True, "url": page.url, "title": (await page.title())[:200],
                    "text": (await page.locator("body").inner_text(timeout=4000))[:2500]}
        if operation == "click":
            role, name = args.get("role"), args.get("name")
            if role not in ("button", "link") or not isinstance(name, str) or not 1 <= len(name) <= 100:
                raise ToolError("Click requires a button/link role and exact accessible name.")
            if re.search(r"\b(send|reply|publish|post|upload|download|buy|purchase|checkout|pay|delete|remove|submit|transfer|withdraw|subscribe|install|login|sign.?in|sign.?out|order|save)\b", name, re.I):
                raise ToolError("High-impact browser controls need a purpose-built verified integration.")
            locator = page.get_by_role(role, name=name, exact=True)
            if await locator.count() != 1 or not await locator.is_visible() or not await locator.is_enabled():
                raise ToolError("The accessible target is absent, ambiguous, or disabled.")
            await locator.click(timeout=4000)
            return {"ok": True, "verified": False, "result": "Click dispatched; inspect the postcondition."}
        if operation == "fill":
            label, value = args.get("label"), args.get("value")
            if not isinstance(label, str) or not 1 <= len(label) <= 100 or not isinstance(value, str) or len(value) > 200:
                raise ToolError("Fill requires a label and short text value.")
            if re.search(r"password|secret|token|otp|card|cvv|pin", label, re.I):
                raise ToolError("Credential and payment fields are not supported.")
            locator = page.get_by_label(label, exact=True)
            if await locator.count() != 1 or not await locator.is_visible() or not await locator.is_enabled():
                raise ToolError("The labeled field is absent, ambiguous, or disabled.")
            if (await locator.get_attribute("type") or "").lower() in {"password", "hidden", "file"}:
                raise ToolError("Sensitive input types are not supported.")
            await locator.fill(value, timeout=4000)
            return {"ok": True, "verified": False, "result": "Text entered; inspect the field value."}
        expectation = args.get("expect")
        if not isinstance(expectation, dict):
            raise ToolError("An explicit postcondition is required.")
        kind, expected = expectation.get("type"), expectation.get("value")
        if not isinstance(expected, str) or not expected or len(expected) > 250:
            raise ToolError("Invalid postcondition value.")
        if kind == "url":
            safe_host_url(expected, session.host)
            matched = page.url == expected
        elif kind == "text":
            locator = page.get_by_text(expected, exact=False)
            matched = await locator.count() > 0 and await locator.first.is_visible()
        elif kind == "field_value":
            label = expectation.get("label")
            if not isinstance(label, str) or not 1 <= len(label) <= 100:
                raise ToolError("A field label is required.")
            locator = page.get_by_label(label, exact=True)
            matched = await locator.count() == 1 and await locator.input_value(timeout=3000) == expected
        else:
            raise ToolError("Unsupported postcondition type.")
        return {"ok": True, "verified": bool(matched), "url": page.url,
                "result": "Postcondition observed." if matched else "Postcondition not observed."}
    except ToolError:
        raise
    except Exception as error:
        # A click or navigation might have reached the site. Never imply a safe retry.
        raise ToolError(f"Browser outcome uncertain: {type(error).__name__}. Inspect manually before retrying.") from error


def shutdown_browser_workflows() -> None:
    async def close_all():
        for task_id in list(SESSIONS):
            await _close(task_id)
    if SESSIONS:
        _run(close_all())


@register("desktopBrowserWorkflow")
def browser_workflow(args: dict[str, Any]) -> dict[str, Any]:
    return _run(_workflow_async(args))
