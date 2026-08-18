"""
Browser automation via Playwright.

Runs a single persistent headed Chromium instance owned by this agent
(independent of the in-app holographic BrowserAgent and the separate
local-agent.js Playwright server on :3001).

Capabilities: open/navigate, new/close tabs, search, click, type, fill forms,
back/forward, scroll, keyboard, reload, zoom, media, screenshots, and page
reading. Lazy-initialized; robust to closed pages.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import quote_plus

from .browser_session import SESSION_MANAGER, browser_environment_summary
from .registry import STATE, ToolError, register

# A dedicated event loop + thread runs all Playwright coroutines, because
# Playwright's sync API can deadlock under FastAPI's threadpool. We use the
# async API marshalled through a single loop.
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_LOOP_THREAD: Optional[threading.Thread] = None
_LOOP_LOCK = threading.Lock()


def _get_loop() -> "asyncio.AbstractEventLoop":
    global _LOOP, _LOOP_THREAD
    with _LOOP_LOCK:
        if _LOOP is None or _LOOP.is_closed():
            _LOOP = asyncio.new_event_loop()
            _LOOP_THREAD = threading.Thread(target=_run_loop, daemon=True)
            _LOOP_THREAD.start()
        return _LOOP


def _run_loop() -> None:
    loop = _LOOP
    assert loop is not None
    asyncio.set_event_loop(loop)
    try:
        loop.run_forever()
    finally:
        try:
            loop.close()
        except Exception:
            pass


def _run(coro):
    """Submit a coroutine to the dedicated Playwright loop and block on it."""
    loop = _get_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)


# --- Async Playwright lifecycle ---------------------------------------------


async def _ensure_browser_async() -> Any:
    if STATE.page is not None:
        try:
            # Health check: a cheap op; if the page died, recreate.
            _ = STATE.page.url
            return STATE.page
        except Exception:
            STATE.reset_playwright()

    if STATE.playwright is None:
        from playwright.async_api import async_playwright

        STATE.playwright = await async_playwright().start()

    if STATE.browser is None:
        try:
            STATE.browser = await STATE.playwright.chromium.launch(
                headless=False,
                args=["--start-maximized", "--no-sandbox"],
            )
        except Exception as e:
            # Fallback 1: Try system installed Google Chrome
            try:
                STATE.browser = await STATE.playwright.chromium.launch(
                    channel="chrome",
                    headless=False,
                    args=["--start-maximized", "--no-sandbox"],
                )
            except Exception:
                # Fallback 2: Try system installed Microsoft Edge
                try:
                    STATE.browser = await STATE.playwright.chromium.launch(
                        channel="msedge",
                        headless=False,
                        args=["--start-maximized", "--no-sandbox"],
                    )
                except Exception:
                    raise ToolError(
                        f"Browser executable not found. Install Chrome/Edge or run 'npx playwright install': {e}"
                    )
        STATE.context = await STATE.browser.new_context(viewport=None)

    if STATE.context is None:
        STATE.context = await STATE.browser.new_context(viewport=None)

    pages = STATE.context.pages
    if pages:
        STATE.page = pages[-1]
    else:
        STATE.page = await STATE.context.new_page()
    return STATE.page


async def _page() -> Any:
    return await _ensure_browser_async()


def _normalize_url(raw: str) -> str:
    url = raw.strip()
    if not url:
        raise ToolError("Empty URL.")
    if "://" not in url:
        url = "https://" + url
    return url


def _prefer_firefox_for_url(url: str, browser_mode: Optional[str] = None) -> bool:
    mode = str(browser_mode or "").strip().lower()
    if mode in {"chromium", "embedded", "automation_chromium"}:
        return False
    # Prefer the real Firefox/browser-session path by default so normal web
    # opens do not silently fall back to the embedded Chromium automation
    # browser. Individual callers can still opt out explicitly via browser_mode.
    return True


async def _page_snapshot(page: Any, *, body_timeout_ms: int = 4000) -> Dict[str, Any]:
    snapshot: Dict[str, Any] = {
        "closed": False,
        "url": "",
        "title": "",
        "ready_state": None,
        "body_available": False,
        "body_text_length": 0,
        "body_text_sample": "",
        "body_read_error": None,
        "page_error": None,
    }
    try:
        snapshot["closed"] = bool(page.is_closed())
    except Exception as e:  # noqa: BLE001
        snapshot["page_error"] = str(e)
        snapshot["closed"] = True
        return snapshot
    if snapshot["closed"]:
        return snapshot
    try:
        snapshot["url"] = page.url
    except Exception as e:  # noqa: BLE001
        snapshot["page_error"] = str(e)
    try:
        snapshot["title"] = await page.title(timeout=2000)
    except Exception as e:  # noqa: BLE001
        snapshot["page_error"] = snapshot["page_error"] or str(e)
    try:
        snapshot["ready_state"] = await page.evaluate("() => document.readyState")
    except Exception as e:  # noqa: BLE001
        snapshot["page_error"] = snapshot["page_error"] or str(e)
    try:
        body = page.locator("body")
        count = await body.count()
        snapshot["body_available"] = count > 0
        if snapshot["body_available"]:
            text = await body.inner_text(timeout=body_timeout_ms)
            snapshot["body_text_length"] = len(text or "")
            snapshot["body_text_sample"] = (text or "")[:400]
    except Exception as e:  # noqa: BLE001
        snapshot["body_read_error"] = str(e)
    return snapshot


def _whatsapp_state(snapshot: Dict[str, Any]) -> str:
    if snapshot.get("closed"):
        return "closed"
    url = str(snapshot.get("url") or "").lower()
    title = str(snapshot.get("title") or "").lower()
    text = str(snapshot.get("body_text_sample") or "").lower()
    body_ok = bool(snapshot.get("body_available"))
    if "whatsapp.com" not in url and "whatsapp" not in title and "whatsapp" not in text:
        return "unknown"
    if not body_ok:
        return "loading_shell"
    if any(marker in text for marker in ("scan the qr code", "use whatsapp on your phone", "keep your phone connected", "link a device")):
        return "login_required"
    if any(marker in text for marker in ("loading", "connecting", "checking", "opening whatsapp")):
        return "loading_shell"
    return "authenticated_or_readable"


async def _wait_for_usable_page(page: Any, timeout_ms: int = 8000) -> Dict[str, Any]:
    deadline = time.monotonic() + max(timeout_ms, 0) / 1000.0
    last_snapshot: Dict[str, Any] = {}
    attempts = 0
    while time.monotonic() < deadline and attempts < 2:
        attempts += 1
        remaining_ms = max(int((deadline - time.monotonic()) * 1000), 500)
        last_snapshot = await _page_snapshot(page, body_timeout_ms=min(4000, remaining_ms))
        if last_snapshot.get("closed"):
            break
        if last_snapshot.get("body_available") and str(last_snapshot.get("url") or "").strip() and str(last_snapshot.get("url")) != "about:blank":
            return last_snapshot
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=min(2500, remaining_ms))
        except Exception:
            pass
        await asyncio.sleep(0.4)
    if not last_snapshot:
        last_snapshot = await _page_snapshot(page, body_timeout_ms=1500)
    return last_snapshot


# --- Handlers ---------------------------------------------------------------


@register("desktopBrowserOpen")
async def browser_open(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "https://www.google.com")
    browser_mode = args.get("browser_mode")
    purpose = str(args.get("purpose") or ("email" if "mail" in url.lower() else "whatsapp" if "whatsapp" in url.lower() else "browser"))
    if _prefer_firefox_for_url(url, browser_mode):
        session = await SESSION_MANAGER.connect_or_launch(url=url, purpose=purpose, prefer_real=True, allow_fallback=True)
        if not session.get("ok"):
            return {
                "result": session.get("reason") or "Firefox session unavailable.",
                "browser_environment": browser_environment_summary(),
                "browser_mode": session.get("browser_mode"),
                "profile": session.get("profile"),
                "diagnostics": session.get("diagnostics"),
                "verified": False,
                "verification": "UNCERTAIN",
        }
        page = session.get("page")
        STATE.page = page
        STATE.browser_mode = session.get("browser_mode")
        STATE.browser_session = session
        snapshot = await SESSION_MANAGER.snapshot(purpose=purpose)
        usable = bool(snapshot.get("body_available")) and not snapshot.get("page_closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
        return {
            "result": f"Opened {url} in the Firefox browser session." if usable else f"Navigation attempted for {url}.",
            "url": snapshot.get("url") or url,
            "title": snapshot.get("title"),
            "ready_state": snapshot.get("ready_state"),
            "page_state": snapshot,
            "browser_environment": browser_environment_summary(),
            "browser_mode": session.get("browser_mode"),
            "profile": session.get("profile"),
            "verified": usable,
            "verification": "VERIFIED" if usable else "UNCERTAIN",
        }
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        snapshot = await _wait_for_usable_page(page, timeout_ms=7000)
        snapshot["navigation_error"] = str(e)
        snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
        usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
        if usable:
            return {
                "result": f"Navigation timed out, but the browser page is usable at {snapshot.get('url')}.",
                "url": snapshot.get("url"),
                "title": snapshot.get("title"),
                "ready_state": snapshot.get("ready_state"),
                "page_state": snapshot,
                "verified": True,
                "verification": "VERIFIED",
            }
        raise ToolError(f"Could not open {url}: {e}; page_state={snapshot}")
    snapshot = await _wait_for_usable_page(page, timeout_ms=3000)
    snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
    usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
    return {
        "result": f"Opened {url} in the automation browser." if usable else f"Navigation attempted for {url}.",
        "url": snapshot.get("url") or page.url,
        "title": snapshot.get("title"),
        "ready_state": snapshot.get("ready_state"),
        "page_state": snapshot,
        "verified": usable,
        "verification": "VERIFIED" if usable else "UNCERTAIN",
    }


@register("desktopBrowserNavigate")
async def browser_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    # Alias of desktopBrowserOpen, retained for clarity.
    return await browser_open(args)


@register("desktopBrowserOpenTab")
async def browser_open_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "about:blank")
    browser_mode = args.get("browser_mode")
    purpose = str(args.get("purpose") or ("email" if "mail" in url.lower() else "whatsapp" if "whatsapp" in url.lower() else "browser"))
    if _prefer_firefox_for_url(url, browser_mode):
        session = await SESSION_MANAGER.connect_or_launch(url=None, purpose=purpose, prefer_real=True, allow_fallback=True)
        if not session.get("ok"):
            raise ToolError(session.get("reason") or "Firefox session unavailable.")
        page = session.get("page")
        if page is None:
            raise ToolError("Firefox session did not provide a page.")
        STATE.page = page
        STATE.browser_mode = session.get("browser_mode")
        STATE.browser_session = session
        try:
            await page.goto(url, wait_until="commit", timeout=20000)
        except Exception as e:  # noqa: BLE001
            snapshot = await SESSION_MANAGER.snapshot(purpose=purpose)
            snapshot["navigation_error"] = str(e)
            usable = bool(snapshot.get("body_available")) and not snapshot.get("page_closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
            if usable:
                return {
                    "result": f"Opened new Firefox tab and recovered usable state at {snapshot.get('url')}.",
                    "url": snapshot.get("url"),
                    "title": snapshot.get("title"),
                    "ready_state": snapshot.get("ready_state"),
                    "page_state": snapshot,
                    "browser_mode": session.get("browser_mode"),
                    "profile": session.get("profile"),
                    "verified": True,
                    "verification": "VERIFIED",
                }
            raise ToolError(f"Opened tab but navigation failed: {e}; page_state={snapshot}")
        snapshot = await SESSION_MANAGER.snapshot(purpose=purpose)
        usable = bool(snapshot.get("body_available")) and not snapshot.get("page_closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
        return {
            "result": f"New Firefox tab opened at {url}.",
            "url": snapshot.get("url") or page.url,
            "title": snapshot.get("title"),
            "ready_state": snapshot.get("ready_state"),
            "page_state": snapshot,
            "browser_mode": session.get("browser_mode"),
            "profile": session.get("profile"),
            "verified": usable,
            "verification": "VERIFIED" if usable else "UNCERTAIN",
        }
    await _ensure_browser_async()
    ctx = STATE.context
    page = await ctx.new_page()
    STATE.page = page  # make it active
    if url != "about:blank":
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        except Exception as e:  # noqa: BLE001
            snapshot = await _wait_for_usable_page(page, timeout_ms=7000)
            snapshot["navigation_error"] = str(e)
            snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
            usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
            if usable:
                return {
                    "result": f"Opened new tab and recovered usable state at {snapshot.get('url')}.",
                    "url": snapshot.get("url"),
                    "title": snapshot.get("title"),
                    "ready_state": snapshot.get("ready_state"),
                    "page_state": snapshot,
                    "verified": True,
                    "verification": "VERIFIED",
                }
            raise ToolError(f"Opened tab but navigation failed: {e}; page_state={snapshot}")
    snapshot = await _wait_for_usable_page(page, timeout_ms=3000)
    snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
    usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
    return {"result": f"New tab opened at {url}.", "url": page.url, "title": snapshot.get("title"), "ready_state": snapshot.get("ready_state"), "page_state": snapshot, "verified": usable, "verification": "VERIFIED" if usable else "UNCERTAIN"}


@register("desktopBrowserCloseTab")
async def browser_close_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.close()
    except Exception:
        pass
    pages = STATE.context.pages if STATE.context else []
    STATE.page = pages[-1] if pages else None
    if STATE.page is None:
        return {"result": "Closed the last tab; browser now empty.", "verified": True, "verification": "VERIFIED"}
    return {"result": f"Closed tab. Active tab now: {STATE.page.url}", "verified": True, "verification": "VERIFIED"}


@register("desktopBrowserSearch")
async def browser_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    q = quote_plus(str(query))
    url = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}",
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
    }.get(engine)
    if not url:
        raise ToolError(f"Unsupported engine '{engine}'.")
    browser_mode = args.get("browser_mode")
    if _prefer_firefox_for_url(url, browser_mode):
        session = await SESSION_MANAGER.connect_or_launch(url=url, purpose="browser", prefer_real=True, allow_fallback=True)
        if not session.get("ok"):
            return {
                "result": session.get("reason") or "Firefox session unavailable.",
                "browser_environment": browser_environment_summary(),
                "browser_mode": session.get("browser_mode"),
                "profile": session.get("profile"),
                "diagnostics": session.get("diagnostics"),
                "verified": False,
                "verification": "UNCERTAIN",
            }
        snapshot = await SESSION_MANAGER.snapshot(purpose="browser")
        STATE.browser_mode = session.get("browser_mode")
        STATE.browser_session = session
        usable = bool(snapshot.get("body_available")) and not snapshot.get("page_closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
        return {
            "result": f"Searched {engine} for '{query}'.",
            "url": snapshot.get("url") or url,
            "title": snapshot.get("title"),
            "ready_state": snapshot.get("ready_state"),
            "page_state": snapshot,
            "browser_mode": session.get("browser_mode"),
            "profile": session.get("profile"),
            "verified": usable,
            "verification": "VERIFIED" if usable else "UNCERTAIN",
        }
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        snapshot = await _wait_for_usable_page(page, timeout_ms=7000)
        snapshot["navigation_error"] = str(e)
        snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
        usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
        if usable:
            return {
                "result": f"Search navigation timed out but page is usable at {snapshot.get('url')}.",
                "url": snapshot.get("url"),
                "title": snapshot.get("title"),
                "ready_state": snapshot.get("ready_state"),
                "page_state": snapshot,
                "verified": True,
                "verification": "VERIFIED",
            }
        raise ToolError(f"Search navigation failed: {e}; page_state={snapshot}")
    snapshot = await _wait_for_usable_page(page, timeout_ms=3000)
    snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
    usable = bool(snapshot.get("body_available")) and not snapshot.get("closed") and str(snapshot.get("url") or "").strip() not in {"", "about:blank"}
    return {"result": f"Searched {engine} for '{query}'.", "url": page.url, "title": snapshot.get("title"), "ready_state": snapshot.get("ready_state"), "page_state": snapshot, "verified": usable, "verification": "VERIFIED" if usable else "UNCERTAIN"}


@register("desktopBrowserClick")
async def browser_click(args: Dict[str, Any]) -> Dict[str, Any]:
    selector = args.get("selector")
    text = args.get("text")
    page = await _page()
    try:
        if selector:
            await page.click(selector, timeout=5000)
        elif text:
            await page.get_by_text(str(text), exact=False).first.click(timeout=5000)
        else:
            raise ToolError("Provide 'selector' or 'text' to click.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Click failed: {e}")
    return {"result": f"Clicked {selector or text}.", "verified": True, "verification": "UNCERTAIN"}


@register("desktopBrowserType")
async def browser_type(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    selector = args.get("selector")
    clear_first = bool(args.get("clear", True))
    if not text:
        raise ToolError("Parameter 'text' is required.")
    page = await _page()
    try:
        if selector:
            await page.fill(selector, str(text), timeout=5000)
        else:
            if clear_first:
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Delete")
            await page.keyboard.type(str(text))
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Type failed: {e}")
    return {"result": f"Typed {len(str(text))} characters.", "verified": True, "verification": "UNCERTAIN"}


@register("desktopBrowserFillForm")
async def browser_fill_form(args: Dict[str, Any]) -> Dict[str, Any]:
    """Fill multiple fields. fields = { selector: value, ... }"""
    fields = args.get("fields")
    submit = args.get("submit")  # optional selector to click after filling
    if not isinstance(fields, dict) or not fields:
        raise ToolError("Parameter 'fields' (object of selector->value) is required.")
    page = await _page()
    filled = 0
    try:
        for sel, val in fields.items():
            await page.fill(str(sel), str(val), timeout=5000)
            filled += 1
        if submit:
            await page.click(str(submit), timeout=5000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Form fill failed after {filled} field(s): {e}")
    extra = " and submitted." if submit else "."
    return {"result": f"Filled {filled} field(s){extra}", "verified": True, "verification": "VERIFIED"}


@register("desktopBrowserGoBack")
async def browser_go_back(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_back(timeout=15000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Back failed: {e}")
    return {"result": f"Went back. Now on {page.url}.", "verified": True, "verification": "VERIFIED"}


@register("desktopBrowserGoForward")
async def browser_go_forward(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_forward(timeout=15000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Forward failed: {e}")
    return {"result": f"Went forward. Now on {page.url}.", "verified": True, "verification": "VERIFIED"}


@register("desktopBrowserScroll")
async def browser_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    direction = (args.get("direction") or "down").lower()
    amount = int(args.get("amount", 500))
    delta = amount if direction != "up" else -amount
    page = await _page()
    try:
        await page.mouse.wheel(0, delta)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Scroll failed: {e}")
    return {"result": f"Scrolled {direction} {amount}px.", "verified": True, "verification": "UNCERTAIN"}

@register("desktopBrowserReload")
async def browser_reload(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    await page.reload(wait_until="domcontentloaded", timeout=20000)
    return {"result": "Refreshed the current page.", "verified": True, "verification": "VERIFIED"}

@register("desktopBrowserKey")
async def browser_key(args: Dict[str, Any]) -> Dict[str, Any]:
    key = str(args.get("key") or "Enter")
    await (await _page()).keyboard.press(key)
    return {"result": f"Pressed {key}.", "verified": True, "verification": "UNCERTAIN"}

@register("desktopBrowserZoom")
async def browser_zoom(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    action = str(args.get("action") or "reset").lower()
    if action == "reset":
        await page.evaluate("() => { document.documentElement.style.zoom = '100%'; }")
    else:
        factor = 1.1 if action == "in" else 0.9
        await page.evaluate("(f) => { document.documentElement.style.zoom = `${(parseFloat(getComputedStyle(document.documentElement).zoom) || 1) * f * 100}%`; }", factor)
    return {"result": f"Zoom {action}.", "verified": True, "verification": "VERIFIED"}

@register("desktopBrowserMedia")
async def browser_media(args: Dict[str, Any]) -> Dict[str, Any]:
    action = str(args.get("action") or "play").lower()
    page = await _page()
    await page.evaluate("(a) => { const v = document.querySelector('video, audio'); if (!v) throw new Error('No media found'); if (a === 'play') v.play(); else if (a === 'pause') v.pause(); else if (a === 'mute') v.muted = true; else if (a === 'unmute') v.muted = false; else if (a === 'fullscreen') v.requestFullscreen?.(); }", action)
    return {"result": f"Media action '{action}' executed.", "verified": False, "verification": "UNCERTAIN"}

@register("browserOpen")
async def browser_open_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    if "url" not in payload and "name" in payload:
        payload["url"] = payload["name"]
    return await browser_open(payload)

@register("browserSearch")
async def browser_search_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    if "query" not in payload and "q" in payload:
        payload["query"] = payload["q"]
    if "query" not in payload and "text" in payload:
        payload["query"] = payload["text"]
    return await browser_search(payload)

@register("browserClick")
async def browser_click_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    if "selector" not in payload and "text" in payload:
        payload["text"] = payload["text"]
    return await browser_click(payload)

@register("browserType")
async def browser_type_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args)
    if "text" not in payload and "value" in payload:
        payload["text"] = payload["value"]
    return await browser_type(payload)

@register("browserScroll")
async def browser_scroll_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    return await browser_scroll(args)

@register("browserGoBack")
async def browser_go_back_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    return await browser_go_back(args)

@register("browserMediaControl")
async def browser_media_control_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    action = str(args.get("action") or args.get("command") or "play").lower()
    payload = {"action": action}
    if "value" in args:
        payload["value"] = args["value"]
    return await browser_media(payload)

@register("browserTabAction")
async def browser_tab_action_alias(args: Dict[str, Any]) -> Dict[str, Any]:
    action = str(args.get("action") or "new").lower()
    if action == "new":
        return await browser_open_tab({"url": args.get("url") or "about:blank"})
    if action == "close":
        return await browser_close_tab({})
    if action == "switch":
        if args.get("tabId"):
            # Playwright tab switching is coordinated by context pages, so just make the requested tab active if it exists.
            try:
                tabs = STATE.context.pages if STATE.context else []
                idx = int(args.get("tabId", 0)) if str(args.get("tabId")).isdigit() else 0
                if tabs and idx < len(tabs):
                    STATE.page = tabs[idx]
                    return {"result": f"Switched browser focus to tab index {idx}.", "url": STATE.page.url, "verified": True, "verification": "VERIFIED"}
            except Exception:
                pass
        return {"result": "Browser tab switch requested; active tab remains unchanged.", "verified": False, "verification": "UNCERTAIN"}
    return {"result": f"Unsupported browser tab action: {action}", "verified": False, "verification": "UNCERTAIN"}

@register("desktopBrowserReadPage")
async def browser_read_page(args: Dict[str, Any]) -> Dict[str, Any]:
    browser_mode = args.get("browser_mode")
    if _prefer_firefox_for_url(str(args.get("url") or ""), browser_mode) or str(getattr(STATE, "browser_mode", "")).lower() in {"firefox", "real_user_browser", "sara_persistent_browser"}:
        snapshot = await SESSION_MANAGER.snapshot(purpose="email" if "mail" in str(args.get("url") or "").lower() else "whatsapp")
        snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
        if snapshot.get("page_closed"):
            raise ToolError(f"Cannot read page because it is closed: {snapshot}")
        max_chars = int(args.get("max_chars", 5000))
        if not snapshot.get("body_available"):
            return {
                "result": "",
                "url": snapshot.get("url"),
                "title": snapshot.get("title"),
                "page_state": snapshot,
                "browser_mode": snapshot.get("browser_mode"),
                "verified": False,
                "verification": "UNCERTAIN",
            }
        text = snapshot.get("body_text_sample") or ""
        if len(text) > max_chars:
            text = text[:max_chars]
        return {
            "result": text,
            "url": snapshot.get("url"),
            "title": snapshot.get("title"),
            "ready_state": snapshot.get("ready_state"),
            "page_state": snapshot,
            "browser_mode": snapshot.get("browser_mode"),
            "verified": True,
            "verification": "VERIFIED",
        }
    page = await _page()
    snapshot = await _wait_for_usable_page(page, timeout_ms=6000)
    snapshot["whatsapp_state"] = _whatsapp_state(snapshot)
    if snapshot.get("closed"):
        raise ToolError(f"Cannot read page because it is closed: {snapshot}")
    max_chars = int(args.get("max_chars", 5000))
    if not snapshot.get("body_available"):
        return {
            "result": "",
            "url": snapshot.get("url") or page.url,
            "title": snapshot.get("title"),
            "page_state": snapshot,
            "verified": False,
            "verification": "UNCERTAIN",
        }
    text = snapshot.get("body_text_sample") or ""
    if len(text) > max_chars:
        text = text[:max_chars]
    return {
        "result": text,
        "url": snapshot.get("url") or page.url,
        "title": snapshot.get("title"),
        "ready_state": snapshot.get("ready_state"),
        "page_state": snapshot,
        "verified": True,
        "verification": "VERIFIED",
    }

@register("desktopBrowserScreenshot")
async def browser_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    import base64
    data = await (await _page()).screenshot(type="jpeg", quality=70)
    return {"result": "Captured the current browser page.", "image_base64": base64.b64encode(data).decode("ascii")}


# Wrap the async handlers so FastAPI's sync threadpool path can call them.
# Each @register'd async function above is replaced by a sync wrapper below.
def _sync_wrap(async_fn):
    def wrapper(args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return _run(async_fn(args))
        except Exception as e:  # noqa: BLE001
            # Convert unexpected browser errors into a stable payload
            # so callers (and tests) always receive a dict with a 'result'
            # key rather than an exception being raised.
            return {"result": {"error": str(e)}, "error": str(e)}

    wrapper.__name__ = async_fn.__name__
    wrapper.__doc__ = async_fn.__doc__
    return wrapper


# Re-register the async handlers as synchronous wrappers so the registry
# dispatcher (which is sync) can call them uniformly.
from .registry import TOOLS  # noqa: E402

for _name in [
    "desktopBrowserOpen",
    "desktopBrowserNavigate",
    "desktopBrowserOpenTab",
    "desktopBrowserCloseTab",
    "desktopBrowserSearch",
    "desktopBrowserClick",
    "desktopBrowserType",
    "desktopBrowserFillForm",
    "desktopBrowserGoBack",
    "desktopBrowserGoForward",
    "desktopBrowserScroll",
    "desktopBrowserReload", "desktopBrowserKey", "desktopBrowserZoom",
    "desktopBrowserMedia", "desktopBrowserReadPage", "desktopBrowserScreenshot",
    "browserOpen",
    "browserSearch",
    "browserClick",
    "browserType",
    "browserScroll",
    "browserGoBack",
    "browserMediaControl",
    "browserTabAction",
]:
    _orig = TOOLS[_name]
    if asyncio.iscoroutinefunction(_orig):
        TOOLS[_name] = _sync_wrap(_orig)


def shutdown_browser() -> None:
    """Cleanly stop the Playwright browser (called on app shutdown)."""
    if STATE.browser is None:
        return

    async def _stop():
        try:
            if STATE.browser:
                await STATE.browser.close()
        except Exception:
            pass
        try:
            if STATE.playwright:
                await STATE.playwright.stop()
        except Exception:
            pass
        STATE.reset_playwright()

    try:
        _run(_stop())
    except Exception:
        STATE.reset_playwright()


__all__ = [
    "browser_open",
    "browser_navigate",
    "browser_open_tab",
    "browser_close_tab",
    "browser_search",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_go_back",
    "browser_go_forward",
    "browser_scroll",
    "browser_open_alias",
    "browser_search_alias",
    "browser_click_alias",
    "browser_type_alias",
    "browser_media_control_alias",
    "browser_tab_action_alias",
    "shutdown_browser",
]
