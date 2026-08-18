"""
tools_os_open.py - Real OS Browser / URL Launcher

Opens URLs in the user's default OS browser (not the embedded Playwright
Chromium).  Use this for simple navigation commands like "Open YouTube",
"Search Google for X", "Go to gmail.com", etc.

Registered tools:
  openUrlInBrowser  - open a URL in the default browser
  searchWeb         - run a web search in the default browser

The embedded Playwright browser (tools_browser.py) should only be invoked
when explicit automation/interaction is needed (form filling, clicking, etc.).
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any, Dict
from urllib.parse import quote_plus

from .registry import register, ToolError


def _open_url_native(url: str) -> None:
    """Open *url* in the OS default browser, cross-platform."""
    try:
        if sys.platform == "win32":
            # 'start' is a cmd built-in; subprocess needs shell=True on Windows
            subprocess.Popen(
                ["cmd", "/c", "start", "", url],
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif sys.platform == "darwin":
            subprocess.Popen(
                ["open", url],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.Popen(
                ["xdg-open", url],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception as exc:
        raise ToolError(f"Failed to open URL in OS browser: {exc}") from exc


def _normalize_url(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        raise ToolError("Empty URL.")
    if "://" not in raw:
        raw = "https://" + raw
    return raw


@register("openUrlInBrowser")
async def open_url_in_browser(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Open a URL in the OS default browser.
    Does NOT use the embedded Playwright Chromium - opens whatever the user
    has set as their default browser (Chrome, Firefox, Edge, etc.).

    Args:
        url (str): URL to open.  If the scheme is omitted, https:// is added.
    """
    url = _normalize_url(args.get("url") or "")
    _open_url_native(url)
    return {
        "result": f"Opened {url} in the default OS browser.",
        "url": url,
        "browser": "default_os_browser",
    }


@register("searchWeb")
async def search_web(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Perform a web search in the OS default browser.
    Constructs a Google search URL from the query and opens it natively.

    Args:
        query (str): The search query.
        engine (str, optional): 'google' (default), 'bing', or 'duckduckgo'.
    """
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("Search query is empty.")

    engine = str(args.get("engine") or "google").strip().lower()
    engine_urls = {
        "google": f"https://www.google.com/search?q={quote_plus(query)}",
        "bing": f"https://www.bing.com/search?q={quote_plus(query)}",
        "duckduckgo": f"https://duckduckgo.com/?q={quote_plus(query)}",
        "youtube": f"https://www.youtube.com/results?search_query={quote_plus(query)}",
    }
    if engine not in engine_urls:
        engine = "google"

    url = engine_urls[engine]
    _open_url_native(url)
    return {
        "result": f"Searching for '{query}' on {engine.capitalize()} in the default OS browser.",
        "url": url,
        "query": query,
        "engine": engine,
        "browser": "default_os_browser",
    }
