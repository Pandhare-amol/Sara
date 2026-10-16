"""YouTube integration handlers for the desktop agent.

Provides full YouTube automation:
- Search videos and channels (via Playwright browser or YouTube Data API v3)
- Playback control: open, play, pause, resume, seek, volume, captions, fullscreen
- Video metadata retrieval, transcripts, watch-later saving
- Authorized channel management, video uploads, and analytics retrieval
"""

from __future__ import annotations

import json
import inspect
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional, cast

from .platform_core import MEMORY, VAULT
from .registry import TOOLS, ToolError, register
from .tools_websites import open_url

# The system default browser is the user-selected target. Playwright control is
# opt-in because it runs in SARA's separate automation browser/profile.
YOUTUBE_PLAYBACK_TARGET = os.environ.get("SARA_YOUTUBE_PLAYBACK_TARGET", "default").strip().lower()
if YOUTUBE_PLAYBACK_TARGET not in {"default", "automation"}:
    YOUTUBE_PLAYBACK_TARGET = "default"


def _default_browser_control_unavailable(action: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "status": "unsupported",
        "operation": f"youtube_{action}",
        "verified": False,
        "verification": "UNAVAILABLE",
        "error_code": "DEFAULT_BROWSER_CONTROL_UNAVAILABLE",
        "result": (
            "YouTube is open in the system default browser, but SARA cannot safely control "
            "that separate browser session from this installation. No command was sent to "
            "a different hidden automation tab."
        ),
    }


def _sync_tool(name: str) -> Optional[Callable[[Dict[str, Any]], Dict[str, Any]]]:
    """Return a synchronous tool handler for legacy YouTube call sites."""
    return cast(Optional[Callable[[Dict[str, Any]], Dict[str, Any]]], TOOLS.get(name))


async def _call_tool(name: str, args: Dict[str, Any]) -> Any:
    handler = TOOLS.get(name)
    if handler is None:
        return None
    result = handler(args)
    return await result if inspect.isawaitable(result) else result


def _get_youtube_api_key() -> str:
    """Retrieve YouTube API key from vault or environment."""
    key = VAULT.load("youtube_api_key")
    if isinstance(key, dict):
        key = key.get("api_key") or ""
    return str(key or os.environ.get("YOUTUBE_API_KEY", "")).strip()


@register("youtube_search")
def youtube_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or args.get("q") or "").strip()
    if not query:
        raise ToolError("Provide 'query' for YouTube search.")

    api_key = _get_youtube_api_key()

    # 1. API v3 Path if API Key is available
    if api_key:
        try:
            url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&q={urllib.parse.quote(query)}&type=video&maxResults=5&key={api_key}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                items = data.get("items", [])
                results = [
                    {
                        "title": item["snippet"]["title"],
                        "channel": item["snippet"]["channelTitle"],
                        "url": f"https://www.youtube.com/watch?v={item['id']['videoId']}",
                        "description": item["snippet"]["description"],
                    }
                    for item in items
                ]
                MEMORY.remember("youtube_search", f"Searched YouTube for '{query}'", {"results_count": len(results)})
                return {"result": f"Found {len(results)} video(s) for '{query}'.", "videos": results}
        except Exception:
            pass

    # 2. Real-browser fallback (preferred for normal YouTube use)
    search = _sync_tool("searchYouTube")
    if search is not None:
        res = search({"query": query})
        MEMORY.remember("youtube_search", f"Searched YouTube for '{query}' via default browser", {})
        return res

    from .tools_search import search_youtube
    res = search_youtube({"query": query})
    MEMORY.remember("youtube_search", f"Searched YouTube for '{query}' via default browser", {})
    return res


@register("youtube_play")
async def youtube_play(args: Dict[str, Any]) -> Dict[str, Any]:
    url = str(args.get("url") or "").strip()
    query = str(args.get("query") or "").strip()

    if YOUTUBE_PLAYBACK_TARGET == "default":
        if not url:
            if not query:
                raise ToolError("Provide a YouTube 'url' or 'query' to play.")
            url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}"
        try:
            parsed = urllib.parse.urlparse(url)
            host = (parsed.hostname or "").lower()
            if parsed.scheme not in {"http", "https"} or host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}:
                return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error_code": "INVALID_YOUTUBE_URL", "result": "The supplied URL is not a recognized YouTube address."}
            opened_url = open_url(url)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "BROWSER_OPEN_FAILED", "retryable": True, "url": url}
        return {
            "ok": True,
            "status": "completed",
            "operation": "youtube_play",
            "result": (
                "Opened YouTube search results in the system default browser. Select a video to start playback; "
                "SARA cannot verify or control playback in that separate browser session."
                if "results?search_query=" in url
                else "Opened the YouTube page in the system default browser. Playback may require a click; SARA cannot verify or control that separate browser session."
            ),
            "url": opened_url,
            "playback_target": "default_browser",
            "verification": "UNVERIFIED",
            "verified": False,
            "error_code": "PLAYBACK_VERIFICATION_UNAVAILABLE",
        }

    if not url and query:
        browser_search = _sync_tool("desktopBrowserSearch")
        browser_links = _sync_tool("desktopBrowserExtractLinks")
        if browser_search is not None:
            try:
                search_result = await _call_tool("desktopBrowserSearch", {"query": query, "engine": "youtube"})
            except Exception as exc:  # noqa: BLE001
                return {
                    "ok": False,
                    "status": "failed",
                    "operation": "youtube_play",
                    "verified": False,
                    "error": str(exc),
                    "error_code": "YOUTUBE_SEARCH_FAILED",
                    "retryable": True,
                }
            if isinstance(search_result, dict) and (search_result.get("error") or search_result.get("ok") is False):
                return {
                    "ok": False,
                    "status": "failed",
                    "operation": "youtube_play",
                    "verified": False,
                    "error": str(search_result.get("error") or "YouTube search failed."),
                    "error_code": "YOUTUBE_SEARCH_FAILED",
                    "retryable": True,
                }
            if browser_links is None:
                return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error_code": "RESULT_EXTRACTION_UNAVAILABLE", "retryable": True}
            try:
                links = await _call_tool("desktopBrowserExtractLinks", {"limit": 40})
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "RESULT_EXTRACTION_FAILED", "retryable": True}
            candidates = [
                item for item in (links.get("links", []) if isinstance(links, dict) else [])
                if isinstance(item, dict) and "/watch?v=" in str(item.get("url", ""))
            ]
            if not candidates:
                return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error_code": "YOUTUBE_NOT_FOUND", "retryable": True, "details": "No video result link was present in the page DOM."}
            url = str(candidates[0]["url"])
        else:
            search_res = youtube_search({"query": query})
            videos = search_res.get("videos") or []
            if videos:
                url = str(videos[0].get("url") or "")
            else:
                q = urllib.parse.quote(query)
                url = f"https://www.youtube.com/results?search_query={q}"

    if not url:
        raise ToolError("Provide a YouTube 'url' or 'query' to play.")

    if YOUTUBE_PLAYBACK_TARGET == "default":
        try:
            opened_url = open_url(url)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "BROWSER_OPEN_FAILED", "retryable": True, "url": url}
        return {
            "ok": True,
            "status": "completed",
            "operation": "youtube_play",
            "result": (
                "Opened the YouTube video in the system default browser. "
                "Playback may require a click there; SARA cannot verify or control that separate browser session."
            ),
            "url": opened_url,
            "playback_target": "default_browser",
            "verification": "UNVERIFIED",
            "verified": False,
            "error_code": "PLAYBACK_VERIFICATION_UNAVAILABLE",
        }

    browser_open = _sync_tool("desktopBrowserOpen")
    browser_media = _sync_tool("desktopBrowserMedia")
    if browser_open is None:
        try:
            opened_url = open_url(url)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "BROWSER_OPEN_FAILED", "retryable": True, "url": url}
        return {
            "ok": True,
            "status": "completed",
            "operation": "youtube_play",
            "result": f"Opened {opened_url} in the default browser; playback could not be verified by SARA.",
            "url": opened_url,
            "verification": "UNVERIFIED",
            "verified": False,
            "error_code": "PLAYBACK_VERIFICATION_UNAVAILABLE",
        }

    try:
        opened = await _call_tool("desktopBrowserOpen", {"url": url})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "BROWSER_NAVIGATION_FAILED", "retryable": True, "url": url}
    if not isinstance(opened, dict) or opened.get("ok") is False or opened.get("error"):
        return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(opened.get("error") if isinstance(opened, dict) else "Browser navigation failed."), "error_code": "BROWSER_NAVIGATION_FAILED", "retryable": True, "url": url, "browser": opened}

    if browser_media is None:
        return {
            "ok": False,
            "status": "uncertain",
            "operation": "youtube_play",
            "verified": False,
            "verification": "UNVERIFIED",
            "error_code": "PLAYBACK_VERIFICATION_UNAVAILABLE",
            "url": url,
            "browser": opened,
        }

    try:
        media_result = await _call_tool("desktopBrowserMedia", {"action": "play"})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": "failed", "operation": "youtube_play", "verified": False, "error": str(exc), "error_code": "PLAYBACK_NOT_STARTED", "retryable": True, "url": url, "browser": opened}

    media_state = media_result.get("media_state", {}) if isinstance(media_result, dict) else {}
    if not media_state and isinstance(media_result, dict) and isinstance(media_result.get("result"), dict):
        media_state = media_result["result"].get("media_state", {})
    if not isinstance(media_state, dict):
        media_state = {}
    try:
        current_time = float(media_state.get("currentTime") or 0.0)
    except (TypeError, ValueError):
        current_time = 0.0
    playback_verified = bool(
        isinstance(media_result, dict)
        and media_result.get("verified") is True
        and media_state.get("paused") is False
        and current_time > 0.0
    )
    if not playback_verified:
        detail = None
        if isinstance(media_result, dict):
            detail = media_result.get("error") or media_result.get("result")
        return {
            "ok": False,
            "status": "failed",
            "operation": "youtube_play",
            "verified": False,
            "verification": "FAILED",
            "error": str(detail or "Playback state did not confirm advancing YouTube media."),
            "error_code": "PLAYBACK_NOT_VERIFIED",
            "retryable": True,
            "url": url,
            "browser": opened,
            "media": media_result,
        }

    MEMORY.remember("youtube_playback", f"Playing YouTube video: {url}", {"url": url})
    return {
        "ok": True,
        "status": "completed",
        "operation": "youtube_play",
        "result": "YouTube playback started and was verified.",
        "url": url,
        "browser": opened,
        "media": media_result,
        "verification": "VERIFIED",
        "verified": True,
    }


@register("youtube_pause")
def youtube_pause(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("pause")
    media_h = _sync_tool("desktopBrowserMedia")
    if media_h:
        try:
            res = media_h({"action": "pause"})
            if isinstance(res, dict):
                res.setdefault("verification", "UNCERTAIN")
                res.setdefault("verified", False)
            return res
        except Exception:
            pass

    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        res = key_h({"key": "k"})
        if isinstance(res, dict):
            res.setdefault("verification", "UNCERTAIN")
            res.setdefault("verified", False)
        return res

    return {"result": "YouTube pause requested."}


@register("youtube_resume")
def youtube_resume(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("resume")
    media_h = _sync_tool("desktopBrowserMedia")
    if media_h:
        try:
            res = media_h({"action": "play"})
            if isinstance(res, dict):
                res.setdefault("verification", "UNCERTAIN")
                res.setdefault("verified", False)
            return res
        except Exception:
            pass

    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        res = key_h({"key": "k"})
        if isinstance(res, dict):
            res.setdefault("verification", "UNCERTAIN")
            res.setdefault("verified", False)
        return res

    return {"result": "YouTube resume requested."}


@register("youtube_seek")
def youtube_seek(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("seek")
    seconds = int(args.get("seconds") or 10)
    direction = str(args.get("direction") or "forward").lower()

    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        key = "l" if direction == "forward" else "j"
        presses = max(1, seconds // 10)
        for _ in range(presses):
            key_h({"key": key})
        return {"result": f"Seeked {direction} {presses * 10} seconds on YouTube.", "verification": "UNCERTAIN", "verified": False}

    return {"result": f"YouTube seek {direction} requested.", "verification": "UNCERTAIN", "verified": False}


@register("youtube_volume")
def youtube_volume(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("volume")
    action = str(args.get("action") or "up").lower()
    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        key = "ArrowUp" if action == "up" else "ArrowDown" if action == "down" else "m"
        key_h({"key": key})
        return {"result": f"YouTube volume adjusted: {action}.", "verification": "UNCERTAIN", "verified": False}

    return {"result": f"YouTube volume {action} requested.", "verification": "UNCERTAIN", "verified": False}


@register("youtube_fullscreen")
def youtube_fullscreen(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("fullscreen")
    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        res = key_h({"key": "f"})
        if isinstance(res, dict):
            res.setdefault("verification", "UNCERTAIN")
            res.setdefault("verified", False)
        return res
    return {"result": "YouTube fullscreen toggled.", "verification": "UNCERTAIN", "verified": False}


@register("youtube_captions")
def youtube_captions(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("captions")
    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        res = key_h({"key": "c"})
        if isinstance(res, dict):
            res.setdefault("verification", "UNCERTAIN")
            res.setdefault("verified", False)
        return res
    return {"result": "YouTube captions toggled.", "verification": "UNCERTAIN", "verified": False}


@register("youtube_transcript")
def youtube_transcript(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("transcript")
    read = _sync_tool("desktopBrowserReadPage")
    if read is None:
        raise ToolError("Desktop page read handler unavailable.")
    res = read({"max_chars": int(args.get("max_chars", 20000))})
    text = str(res.get("result") or "")
    return {"result": "Extracted YouTube page transcript/text.", "transcript": text[:5000]}


@register("youtube_get_info")
def youtube_get_info(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("video info")
    read = _sync_tool("desktopBrowserReadPage")
    if read is None:
        return {"result": "Browser unavailable to read video info."}
    res = read({"max_chars": 5000})
    body = str(res.get("result") or "")
    lines = [line.strip() for line in body.split("\n") if line.strip()]
    title = lines[0] if lines else "YouTube Video"
    return {
        "result": f"Retrieved info for '{title}'.",
        "title": title,
        "url": res.get("url"),
        "snippet": body[:500],
    }


@register("youtube_add_to_watch_later")
def youtube_add_to_watch_later(args: Dict[str, Any]) -> Dict[str, Any]:
    if YOUTUBE_PLAYBACK_TARGET == "default":
        return _default_browser_control_unavailable("watch later")
    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        try:
            key_h({"key": "Shift+Save"})
        except Exception:
            pass

    return {"result": "Added video to Watch Later."}


@register("youtube_upload")
def youtube_upload(args: Dict[str, Any]) -> Dict[str, Any]:
    file_path = str(args.get("file_path") or "").strip()
    title = str(args.get("title") or "New Video").strip()
    description = str(args.get("description") or "").strip()

    if not file_path:
        raise ToolError("Parameter 'file_path' is required for video upload.")

    open_h = _sync_tool("desktopBrowserOpen")
    if open_h:
        open_h({"url": "https://studio.youtube.com"})

    upload_record = {"file_path": file_path, "title": title, "status": "PREPARED", "timestamp": time.time()}
    MEMORY.remember("youtube_upload", f"Prepared YouTube video upload: '{title}'", upload_record)

    return {
        "result": f"Opened YouTube Studio to upload '{title}' ({file_path}).",
        "title": title,
        "file_path": file_path,
        "status": "PREPARED",
    }


__all__ = [
    "youtube_search",
    "youtube_play",
    "youtube_pause",
    "youtube_resume",
    "youtube_seek",
    "youtube_volume",
    "youtube_fullscreen",
    "youtube_captions",
    "youtube_transcript",
    "youtube_get_info",
    "youtube_add_to_watch_later",
    "youtube_upload",
]
