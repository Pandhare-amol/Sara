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
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote_plus

from .registry import STATE, ToolError, register
from .browser_state import BrowserStateManager

# A dedicated event loop + thread runs all Playwright coroutines, because
# Playwright's sync API can deadlock under FastAPI's threadpool. We use the
# async API marshalled through a single loop.
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_LOOP_THREAD: Optional[threading.Thread] = None
_LOOP_LOCK = threading.Lock()
_OPERATION_LOCK: Optional[asyncio.Lock] = None

NAVIGATION_TIMEOUT_MS = int(os.environ.get("SARA_BROWSER_NAVIGATION_TIMEOUT_MS", "20000"))
ELEMENT_TIMEOUT_MS = int(os.environ.get("SARA_BROWSER_ELEMENT_TIMEOUT_MS", "8000"))
QUICK_ACTION_TIMEOUT_MS = int(os.environ.get("SARA_BROWSER_QUICK_ACTION_TIMEOUT_MS", "5000"))
MEDIA_START_TIMEOUT_MS = int(os.environ.get("SARA_BROWSER_MEDIA_START_TIMEOUT_MS", "15000"))
HEADLESS = os.environ.get("SARA_BROWSER_HEADLESS", "true").strip().lower() not in {"0", "false", "no"}
USER_DATA_DIR = os.environ.get(
    "SARA_BROWSER_USER_DATA_DIR",
    str(Path(__file__).resolve().parent.parent / "data" / "browser-profile"),
)


def _get_loop() -> "asyncio.AbstractEventLoop":
    global _LOOP, _LOOP_THREAD, _OPERATION_LOCK
    with _LOOP_LOCK:
        if _LOOP is None or _LOOP.is_closed():
            _LOOP = asyncio.new_event_loop()
            _OPERATION_LOCK = None
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
    """Submit one serialized browser operation to the dedicated Playwright loop."""
    loop = _get_loop()

    async def serialized():
        global _OPERATION_LOCK
        if _OPERATION_LOCK is None:
            _OPERATION_LOCK = asyncio.Lock()
        async with _OPERATION_LOCK:
            return await coro

    future = asyncio.run_coroutine_threadsafe(serialized(), loop)
    timeout_seconds = max(NAVIGATION_TIMEOUT_MS, ELEMENT_TIMEOUT_MS, MEDIA_START_TIMEOUT_MS) / 1000 + 15
    try:
        return future.result(timeout=timeout_seconds)
    except TimeoutError:
        # Do not leave an abandoned navigation holding the serialization lock.
        future.cancel()
        raise


# --- Async Playwright lifecycle ---------------------------------------------


async def _start_playwright_async() -> Any:
    from playwright.async_api import async_playwright

    return await async_playwright().start()


async def _close_browser_session_async() -> None:
    """Close this agent's Playwright resources without touching its profile data."""
    context = STATE.context
    browser = STATE.browser
    playwright = STATE.playwright

    context_closed = False
    if context is not None:
        try:
            await context.close()
            context_closed = True
        except Exception:
            # A crashed browser/context may reject close; still stop Playwright.
            pass

    if browser is not None and not context_closed:
        try:
            await browser.close()
        except Exception:
            pass

    if playwright is not None:
        try:
            await playwright.stop()
        except Exception:
            pass

    STATE.reset_playwright()


def _page_is_open(page: Any) -> bool:
    if page is None:
        return False
    try:
        return not page.is_closed()
    except Exception:
        return False


def _browser_is_connected(browser: Any) -> bool:
    if browser is None:
        return True
    try:
        return bool(browser.is_connected())
    except Exception:
        return False


async def _ensure_browser_async() -> Any:
    if STATE.browser_state is None:
        STATE.browser_state = BrowserStateManager()

    # A closed tab is normal: keep the persistent context and profile, and use
    # another live tab (or create a fresh one). A crashed/disconnected browser
    # is different; close its Playwright resources before relaunching to avoid
    # leaving a Chromium process holding the profile lock.
    session_is_unhealthy = STATE.context is None and STATE.browser is not None
    if STATE.browser is not None and not _browser_is_connected(STATE.browser):
        session_is_unhealthy = True
    if STATE.context is not None:
        try:
            _ = STATE.context.pages
        except Exception:
            session_is_unhealthy = True
    if session_is_unhealthy:
        await _close_browser_session_async()
    if STATE.browser_state is None:
        STATE.browser_state = BrowserStateManager()

    if STATE.playwright is None:
        try:
            STATE.playwright = await _start_playwright_async()
        except Exception as exc:
            raise ToolError(f"Could not start Playwright: {exc}") from exc

    # The persistent context is the primary browser handle. Do not use
    # STATE.browser being None as a reason to launch a second context: that
    # would collide with the existing profile lock.
    if STATE.context is None:
        Path(USER_DATA_DIR).mkdir(parents=True, exist_ok=True)
        try:
            STATE.context = await STATE.playwright.chromium.launch_persistent_context(
                USER_DATA_DIR,
                headless=HEADLESS,
                args=["--no-sandbox"],
            )
        except Exception as exc:
            message = str(exc)
            if any(
                marker in message.lower()
                for marker in ("in use", "user data directory", "processsingleton", "singletonlock")
            ):
                raise ToolError(
                    "SARA's browser profile appears to be in use by another browser session. "
                    "The profile was left untouched; close the other SARA automation session "
                    "or configure a separate SARA_BROWSER_USER_DATA_DIR."
                ) from exc
            raise ToolError(f"Could not launch the automation browser: {exc}") from exc
        STATE.browser = STATE.context.browser
        STATE.context.on("page", lambda page: STATE.browser_state.attach_page(page))

    try:
        pages = [page for page in STATE.context.pages if _page_is_open(page)]
    except Exception as exc:
        await _close_browser_session_async()
        raise ToolError(f"The automation browser closed unexpectedly: {exc}") from exc

    if STATE.page not in pages:
        STATE.page = pages[-1] if pages else None
    if STATE.page is None:
        try:
            STATE.page = await STATE.context.new_page()
        except Exception as exc:
            await _close_browser_session_async()
            raise ToolError(f"Could not create a browser tab: {exc}") from exc

    STATE.browser_state.attach_page(STATE.page)
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


# --- Handlers ---------------------------------------------------------------


@register("desktopBrowserOpen")
async def browser_open(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "https://www.google.com")
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not open {url}: {e}")
    return {"ok": True, "status": "completed", "operation": "browser_open", "verified": True, "result": f"Opened {url} in the automation browser.", "url": page.url, "state": STATE.browser_state.snapshot(page)}


@register("desktopBrowserNavigate")
async def browser_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    # Alias of desktopBrowserOpen, retained for clarity.
    return await browser_open(args)


@register("desktopBrowserOpenTab")
async def browser_open_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "about:blank")
    await _ensure_browser_async()
    ctx = STATE.context
    page = await ctx.new_page()
    STATE.page = page  # make it active
    if url != "about:blank":
        try:
                await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Opened tab but navigation failed: {e}")
    return {"result": f"New tab opened at {url}.", "url": url}


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
        return {"result": "Closed the last tab; browser now empty."}
    return {"result": f"Closed tab. Active tab now: {STATE.page.url}"}


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
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Search navigation failed: {e}")
    return {"ok": True, "status": "completed", "operation": "browser_search", "verified": True, "result": f"Searched {engine} for '{query}'.", "url": page.url, "state": STATE.browser_state.snapshot(page)}


@register("desktopBrowserClick")
async def browser_click(args: Dict[str, Any]) -> Dict[str, Any]:
    selector = args.get("selector")
    text = args.get("text")
    page = await _page()
    try:
        if selector:
            await page.click(selector, timeout=ELEMENT_TIMEOUT_MS)
        elif text:
            await page.get_by_text(str(text), exact=False).first.click(timeout=ELEMENT_TIMEOUT_MS)
        else:
            raise ToolError("Provide 'selector' or 'text' to click.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Click failed: {e}")
    return {"result": f"Clicked {selector or text}."}


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
            await page.fill(selector, str(text), timeout=ELEMENT_TIMEOUT_MS)
        else:
            if clear_first:
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Delete")
            await page.keyboard.type(str(text))
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Type failed: {e}")
    return {"result": f"Typed {len(str(text))} characters."}


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
            await page.fill(str(sel), str(val), timeout=ELEMENT_TIMEOUT_MS)
            filled += 1
        if submit:
            await page.click(str(submit), timeout=ELEMENT_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Form fill failed after {filled} field(s): {e}")
    extra = " and submitted." if submit else "."
    return {"result": f"Filled {filled} field(s){extra}"}


@register("desktopBrowserGoBack")
async def browser_go_back(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_back(timeout=NAVIGATION_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Back failed: {e}")
    return {"result": f"Went back. Now on {page.url}."}


@register("desktopBrowserGoForward")
async def browser_go_forward(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_forward(timeout=NAVIGATION_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Forward failed: {e}")
    return {"result": f"Went forward. Now on {page.url}."}


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
    return {"result": f"Scrolled {direction} {amount}px."}

@register("desktopBrowserReload")
async def browser_reload(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    await page.reload(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
    return {"result": "Refreshed the current page."}

@register("desktopBrowserKey")
async def browser_key(args: Dict[str, Any]) -> Dict[str, Any]:
    key = str(args.get("key") or "Enter")
    await (await _page()).keyboard.press(key)
    return {"result": f"Pressed {key}."}

@register("desktopBrowserZoom")
async def browser_zoom(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    action = str(args.get("action") or "reset").lower()
    if action == "reset":
        await page.evaluate("() => { document.documentElement.style.zoom = '100%'; }")
    else:
        factor = 1.1 if action == "in" else 0.9
        await page.evaluate("(f) => { document.documentElement.style.zoom = `${(parseFloat(getComputedStyle(document.documentElement).zoom) || 1) * f * 100}%`; }", factor)
    return {"result": f"Zoom {action}."}

@register("desktopBrowserMedia")
async def browser_media(args: Dict[str, Any]) -> Dict[str, Any]:
    action = str(args.get("action") or "play").lower()
    if action not in {"play", "pause", "mute", "unmute", "fullscreen"}:
        raise ToolError(f"Unsupported media action '{action}'.")

    page = await _page()
    try:
        await page.wait_for_selector("video, audio", timeout=ELEMENT_TIMEOUT_MS)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"No media element became available on the current page: {exc}") from exc

    def media_state_script() -> str:
        return """() => {
          const v = document.querySelector('video, audio');
          if (!v) return { found: false };
          return {
            found: true,
            paused: v.paused,
            currentTime: Number(v.currentTime || 0),
            muted: v.muted,
            volume: v.volume,
            duration: Number.isFinite(v.duration) ? v.duration : null,
            readyState: v.readyState,
            ended: v.ended,
            fullscreen: document.fullscreenElement === v || !!document.fullscreenElement
          };
        }"""

    state = await page.evaluate(media_state_script())
    initial_time = float(state.get("currentTime") or 0.0)
    verified = False

    if action == "play":
        # Prefer a real browser input so YouTube and other sites that enforce
        # autoplay policies receive a user gesture. Fall back to the media API
        # only after the visible controls have been tried.
        if state.get("paused", True):
            clicked = False
            if "youtube.com" in str(page.url).lower():
                try:
                    play_button = page.locator("button.ytp-play-button").first
                    if await play_button.count() and await play_button.is_visible():
                        label = str(await play_button.get_attribute("aria-label") or "").lower()
                        if "pause" not in label:
                            await play_button.click(timeout=QUICK_ACTION_TIMEOUT_MS)
                            clicked = True
                except Exception:
                    pass
            if not clicked:
                try:
                    await page.locator("video, audio").first.click(timeout=QUICK_ACTION_TIMEOUT_MS)
                    clicked = True
                except Exception:
                    pass

            # A programmatic play request is a last resort. Its promise is
            # observed without awaiting it here; the state check below decides
            # whether playback actually began.
            try:
                await page.evaluate("""() => {
                  const v = document.querySelector('video, audio');
                  if (!v) return false;
                  try {
                    const result = v.play();
                    if (result && typeof result.catch === 'function') result.catch(() => {});
                    return true;
                  } catch (_) {
                    return false;
                  }
                }""")
            except Exception:
                pass

        try:
            await page.wait_for_function(
                """(startTime) => {
                  const v = document.querySelector('video, audio');
                  return !!v && !v.paused && v.readyState >= 2 && v.currentTime > startTime + 0.1;
                }""",
                arg=initial_time,
                timeout=MEDIA_START_TIMEOUT_MS,
            )
            state = await page.evaluate(media_state_script())
            verified = bool(
                state.get("found")
                and state.get("paused") is False
                and float(state.get("currentTime") or 0.0) > initial_time + 0.1
            )
        except Exception:
            state = await page.evaluate(media_state_script())
            verified = False
        result_text = "Media playback started and was verified." if verified else "Playback was requested, but actual playback could not be verified."
    elif action == "pause":
        await page.evaluate("() => { const v = document.querySelector('video, audio'); if (v) v.pause(); }")
        await page.wait_for_function(
            "() => { const v = document.querySelector('video, audio'); return !!v && v.paused; }",
            timeout=QUICK_ACTION_TIMEOUT_MS,
        )
        state = await page.evaluate(media_state_script())
        verified = bool(state.get("found") and state.get("paused") is True)
        result_text = "Media is paused." if verified else "Pause was requested but could not be verified."
    elif action in {"mute", "unmute"}:
        desired_muted = action == "mute"
        await page.evaluate("(muted) => { const v = document.querySelector('video, audio'); if (v) v.muted = muted; }", desired_muted)
        state = await page.evaluate(media_state_script())
        verified = bool(state.get("found") and state.get("muted") is desired_muted)
        result_text = "Media mute state was verified." if verified else "The requested mute state could not be verified."
    else:  # fullscreen
        await page.evaluate("() => { const v = document.querySelector('video, audio'); v?.requestFullscreen?.(); }")
        state = await page.evaluate(media_state_script())
        verified = bool(state.get("found") and state.get("fullscreen"))
        result_text = "Media entered fullscreen." if verified else "Fullscreen was requested but could not be verified."

    STATE.browser_state.update_media(page, state)
    return {
        "ok": verified,
        "status": "completed" if verified else "failed",
        "operation": f"browser_media_{action}",
        "result": result_text,
        "error": None if verified else result_text,
        "verification": "VERIFIED" if verified else "FAILED",
        "verified": verified,
        "media_state": state,
        "state": STATE.browser_state.snapshot(page),
    }

@register("desktopBrowserState")
async def browser_state(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    return {"ok": True, "status": "completed", "operation": "browser_state", "verified": True, "state": STATE.browser_state.snapshot(page)}


@register("desktopBrowserMediaState")
async def browser_media_state(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    snapshot = STATE.browser_state.snapshot(page)
    state = dict(snapshot.get("media_state") or {})

    if not state:
        try:
            state = await page.evaluate(
                "() => { const v = document.querySelector('video, audio'); if (!v) return { found: false }; return { found: true, paused: v.paused, currentTime: v.currentTime, muted: v.muted, duration: v.duration, readyState: v.readyState, ended: v.ended, volume: v.volume }; }"
            )
        except Exception:
            state = {"found": False}

    if state.get("found") is None:
        state["found"] = bool(state)

    STATE.browser_state.update_media(page, state)
    snapshot = STATE.browser_state.snapshot(page)
    return {
        "ok": True,
        "status": "completed",
        "operation": "browser_media_state",
        "verified": True,
        "result": {"media_state": state, "state": snapshot},
        "media_state": state,
        "state": snapshot,
        "verification": "VERIFIED",
    }

@register("desktopBrowserExtractLinks")
async def browser_extract_links(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    limit = max(1, min(int(args.get("limit", 20)), 100))
    links = await page.locator("a[href]").evaluate_all(
        "(nodes, max) => nodes.map(node => ({title: (node.innerText || node.getAttribute('aria-label') || '').trim(), url: node.href}))"
        ".filter(item => item.url).slice(0, max)",
        limit,
    )
    return {"ok": True, "status": "completed", "operation": "browser_extract_links", "verified": True, "url": page.url, "links": links, "state": STATE.browser_state.snapshot(page)}

@register("desktopBrowserReadPage")
async def browser_read_page(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    text = await page.locator("body").inner_text(timeout=10000)
    return {"result": text[:int(args.get("max_chars", 5000))], "url": page.url, "title": await page.title()}

@register("desktopBrowserScreenshot")
async def browser_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    import base64
    data = await (await _page()).screenshot(type="jpeg", quality=70)
    return {"result": "Captured the current browser page.", "image_base64": base64.b64encode(data).decode("ascii")}


# Wrap the async handlers so FastAPI's sync threadpool path can call them.
# Each @register'd async function above is replaced by a sync wrapper below.
def _sync_wrap(async_fn):
    def wrapper(args: Dict[str, Any]) -> Dict[str, Any]:
        return _run(async_fn(args))

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
    "desktopBrowserMedia", "desktopBrowserState", "desktopBrowserExtractLinks", "desktopBrowserReadPage", "desktopBrowserScreenshot",
    "desktopBrowserMediaState",
]:
    _orig = TOOLS[_name]
    if asyncio.iscoroutinefunction(_orig):
        TOOLS[_name] = _sync_wrap(_orig)


if "desktopBrowserMediaState" in TOOLS:
    browser_media_state = _sync_wrap(browser_media_state)


def shutdown_browser() -> None:
    """Cleanly stop the Playwright browser (called on app shutdown)."""
    if STATE.context is None and STATE.browser is None and STATE.playwright is None:
        return

    try:
        _run(_close_browser_session_async())
    except Exception:
        # The service is already shutting down; clear stale references without
        # touching the persistent browser profile on disk.
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
    "shutdown_browser",
]
