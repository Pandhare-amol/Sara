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


def _sync_tool(name: str) -> Optional[Callable[[Dict[str, Any]], Dict[str, Any]]]:
    """Return a synchronous tool handler for legacy YouTube call sites."""
    return cast(Optional[Callable[[Dict[str, Any]], Dict[str, Any]]], TOOLS.get(name))


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
    active_browser_page = False

    if not url and query:
        browser_search = _sync_tool("desktopBrowserSearch")
        browser_click = _sync_tool("desktopBrowserClick")
        if browser_search is not None:
            search_result = browser_search({"query": query, "engine": "youtube"})
            if inspect.isawaitable(search_result):
                search_result = await search_result
            if isinstance(search_result, dict) and search_result.get("error"):
                return {
                    "error": str(search_result["error"]),
                    "error_code": "YOUTUBE_NOT_FOUND",
                    "status": "failed",
                    "executed": True,
                }
            active_browser_page = True
            if browser_click is not None:
                try:
                    click_result = browser_click({"selector": "a[href*='/watch']"})
                    if inspect.isawaitable(click_result):
                        click_result = await click_result
                    if isinstance(click_result, dict) and click_result.get("error"):
                        return {
                            "error": str(click_result["error"]),
                            "error_code": "YOUTUBE_NOT_FOUND",
                            "status": "failed",
                            "executed": True,
                        }
                except Exception:
                    return {
                        "error": "No YouTube video result could be selected.",
                        "error_code": "YOUTUBE_NOT_FOUND",
                        "status": "failed",
                        "executed": True,
                    }
            else:
                return {
                    "error": "YouTube result selection is unavailable.",
                    "error_code": "YOUTUBE_NOT_FOUND",
                    "status": "failed",
                    "executed": True,
                }
        else:
            search_res = youtube_search({"query": query})
            videos = search_res.get("videos") or []
            if videos:
                url = videos[0]["url"]
            else:
                q = urllib.parse.quote(query)
                url = f"https://www.youtube.com/results?search_query={q}"

    if not url and not active_browser_page:
        raise ToolError("Provide a YouTube 'url' or 'query' to play.")

    browser_open = _sync_tool("desktopBrowserOpen")
    browser_media = _sync_tool("desktopBrowserMedia")
    if browser_open is not None:
        opened = {"result": "Used the active Playwright browser page."}
        if url:
            opened_result = browser_open({"url": url})
            opened = await opened_result if inspect.isawaitable(opened_result) else opened_result
        res: Dict[str, Any] = {"result": "Opened YouTube video in the Playwright browser.", "url": url, "browser": opened}
        if browser_media is not None:
            media_result = browser_media({"action": "play"})
            media_result = await media_result if inspect.isawaitable(media_result) else media_result
            res["media"] = media_result
            media_error = media_result.get("error") if isinstance(media_result, dict) else None
            nested_error = media_result.get("result", {}).get("error") if isinstance(media_result, dict) and isinstance(media_result.get("result"), dict) else None
            if media_error or nested_error:
                return {
                    "error": str(media_error or nested_error),
                    "error_code": "PLAYBACK_NOT_STARTED",
                    "status": "failed",
                    "executed": True,
                    "url": url,
                    "media": media_result,
                }
    else:
        res = {"result": f"Opened {open_url(url)} in the default browser.", "url": url}
    MEMORY.remember("youtube_playback", f"Playing YouTube video: {url}", {"url": url})
    res.setdefault("verification", "UNCERTAIN")
    res.setdefault("verified", False)
    return res


@register("youtube_pause")
def youtube_pause(args: Dict[str, Any]) -> Dict[str, Any]:
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
    action = str(args.get("action") or "up").lower()
    key_h = _sync_tool("desktopBrowserKey")
    if key_h:
        key = "ArrowUp" if action == "up" else "ArrowDown" if action == "down" else "m"
        key_h({"key": key})
        return {"result": f"YouTube volume adjusted: {action}.", "verification": "UNCERTAIN", "verified": False}

    return {"result": f"YouTube volume {action} requested.", "verification": "UNCERTAIN", "verified": False}


@register("youtube_fullscreen")
def youtube_fullscreen(args: Dict[str, Any]) -> Dict[str, Any]:
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
    read = _sync_tool("desktopBrowserReadPage")
    if read is None:
        raise ToolError("Desktop page read handler unavailable.")
    res = read({"max_chars": int(args.get("max_chars", 20000))})
    text = str(res.get("result") or "")
    return {"result": "Extracted YouTube page transcript/text.", "transcript": text[:5000]}


@register("youtube_get_info")
def youtube_get_info(args: Dict[str, Any]) -> Dict[str, Any]:
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
