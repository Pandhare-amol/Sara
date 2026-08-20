"""High-level camera suite wrappers for SARA."""

from __future__ import annotations

from typing import Any, Dict

from .registry import register


@register("saraCameraOpen")
def sara_camera_open(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import open_camera

    return {"result": open_camera(args)}


@register("saraCameraTakePhoto")
def sara_camera_take_photo(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import take_photo

    return {"result": take_photo(args)}


@register("saraCameraRecordVideo")
def sara_camera_record_video(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import record_video

    return {"result": record_video(args)}


@register("saraCameraStopRecording")
def sara_camera_stop_recording(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import stop_video_recording

    return {"result": stop_video_recording(args)}


@register("saraCameraScanQr")
def sara_camera_scan_qr(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import scan_qr_code

    return {"result": scan_qr_code(args)}


@register("saraCameraObserve")
def sara_camera_observe(args: Dict[str, Any]) -> Dict[str, Any]:
    from .tools_camera import scan_qr_code, take_photo

    result = take_photo({"name": args.get("name") or "camera-observe"})
    payload: Dict[str, Any] = {
        "result": "Camera observation captured locally.",
        "photo": result,
        "path": result.get("path"),
    }
    if args.get("scan_qr") or args.get("scan_code"):
        try:
            payload["code_scan"] = scan_qr_code(args)
        except Exception as exc:  # noqa: BLE001
            payload["code_scan"] = {"error": str(exc)}
    return {"result": payload}
