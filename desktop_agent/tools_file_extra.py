"""Additional file, folder, archive, and open/preview tools for voice control."""

from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register
from .tools_files import _ensure_safe, _resolve_file, _resolve_folder


@register("createFolder")
def create_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path") or args.get("name")
    if not path:
        raise ToolError("Parameter 'path' or 'name' is required.")
    p = Path(os.path.expandvars(os.path.expanduser(str(path)))).resolve()
    _ensure_safe(p)
    p.mkdir(parents=True, exist_ok=bool(args.get("exist_ok", True)))
    return {"result": f"Created folder: {p}", "path": str(p)}


@register("copyFile")
def copy_file(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path") or args.get("source"), must_exist=True)
    target = Path(os.path.expandvars(os.path.expanduser(str(args.get("destination") or args.get("target"))))).resolve()
    _ensure_safe(source)
    _ensure_safe(target)
    if target.is_dir():
        target = target / source.name
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=bool(args.get("merge", False)))
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return {"result": f"Copied {source} to {target}.", "path": str(target)}


@register("duplicateFile")
def duplicate_file(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path"), must_exist=True)
    _ensure_safe(source)
    suffix = source.suffix
    stem = source.stem
    target = source.with_name(f"{stem} copy{suffix}")
    idx = 2
    while target.exists():
        target = source.with_name(f"{stem} copy {idx}{suffix}")
        idx += 1
    if source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copy2(source, target)
    return {"result": f"Duplicated {source.name} to {target.name}.", "path": str(target)}


@register("compressPath")
def compress_path(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path") or args.get("source"), must_exist=True)
    _ensure_safe(source)
    destination = args.get("destination")
    out = Path(os.path.expandvars(os.path.expanduser(str(destination)))).resolve() if destination else source.with_suffix(".zip")
    _ensure_safe(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if source.is_dir():
            for item in source.rglob("*"):
                if item.is_file():
                    zf.write(item, item.relative_to(source.parent))
        else:
            zf.write(source, source.name)
    return {"result": f"Compressed {source} to {out}.", "path": str(out)}


@register("extractZip")
def extract_zip(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path") or args.get("source"), must_exist=True)
    _ensure_safe(source)
    if source.suffix.lower() != ".zip":
        raise ToolError("Only .zip archives are supported.")
    destination = Path(os.path.expandvars(os.path.expanduser(str(args.get("destination") or source.with_suffix(""))))).resolve()
    _ensure_safe(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as zf:
        zf.extractall(destination)
    return {"result": f"Extracted {source.name} to {destination}.", "path": str(destination)}


@register("openPath")
def open_path(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path") or args.get("name")
    p = _resolve_folder(path) if str(path).lower() in {"desktop", "documents", "downloads", "pictures", "music", "videos", "home"} else _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    if os.name == "nt":
        os.startfile(str(p))  # type: ignore[attr-defined]
    else:
        opener = "open" if os.uname().sysname == "Darwin" else "xdg-open"
        subprocess.Popen([opener, str(p)], close_fds=True)
    return {"result": f"Opened {p}.", "path": str(p)}
