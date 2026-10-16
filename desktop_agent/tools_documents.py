"""Bounded local document operations. Plain text works cross-platform; Office uses installed Windows COM.

The model supplies a path and structured edits, never a command or a macro. Every
edit is made to a private copy with a recoverable backup of the original. A
read of the saved file is compared with the request before claiming success.
The Node verifier performs another read after this handler returns.
"""
from __future__ import annotations

import hashlib
import math
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register
from .tools_files import _ensure_safe, _resolve_file

EXTENSIONS = {".txt": "text", ".md": "text", ".docx": "word", ".xlsx": "excel", ".pptx": "powerpoint"}
MAX_TEXT = 200_000
MAX_FILE_BYTES = 40_000_000
CELL = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$")


def _path(args: Dict[str, Any], *, must_exist: bool) -> tuple[Path, str]:
    p = _resolve_file(args.get("path"), must_exist=False)
    _ensure_safe(p)  # normalized, symlinks resolved; never accepts allow_anywhere from a model
    kind = EXTENSIONS.get(p.suffix.lower())
    if kind is None:
        raise ToolError("Supported documents: .txt, .md, .docx, .xlsx and .pptx (no macro-enabled Office files).")
    if must_exist and (not p.is_file() or p.is_symlink()):
        raise ToolError(f"Document does not exist: {p}")
    if p.exists() and p.stat().st_size > MAX_FILE_BYTES:
        raise ToolError("Document is too large for a bounded edit (40 MB maximum).")
    return p, kind


def _office_available(kind: str) -> None:
    if kind != "text" and platform.system() != "Windows":
        raise ToolError("Microsoft Office document actions require Windows and an installed Office application; no change was made.")


def _text(value: Any, field: str, *, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > MAX_TEXT or (required and not value):
        raise ToolError(f"'{field}' must be {'nonempty ' if required else ''}text under {MAX_TEXT} characters.")
    return value


def _cell(value: Any) -> str:
    name = str(value or "").strip().upper()
    match = CELL.fullmatch(name)
    if not match:
        raise ToolError("Cell must be a single Excel address, e.g. B2.")
    column, row = match.groups()
    number = 0
    for char in column:
        number = number * 26 + ord(char) - ord("A") + 1
    if number > 16384 or int(row) > 1048576:
        raise ToolError("Cell is outside the Excel worksheet bounds.")
    return name


def _font_size(value: Any) -> float:
    if isinstance(value, bool):
        raise ToolError("Font size must be a number of points, not a font name.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ToolError("Font size must be a number of points, not a font name.") from None
    if not math.isfinite(number) or not 6 <= number <= 72 or number * 2 != int(number * 2):
        raise ToolError("Font size must be between 6 and 72 points (half-point increments).")
    return number


def _hash(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _validate_create(kind: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if kind in {"text", "word"}:
        return {"text": _text(args.get("text", ""), "text")}
    if kind == "excel":
        cells = args.get("cells") or []
        if not isinstance(cells, list) or len(cells) > 100 or not cells:
            raise ToolError("Excel creation requires 1–100 cell/value entries.")
        checked = []
        for cell in cells:
            if not isinstance(cell, dict):
                raise ToolError("Each spreadsheet entry needs a cell and value.")
            value = cell.get("value")
            if isinstance(value, str):
                value = _text(value, "value")
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e15:
                raise ToolError("Cell value must be bounded text or a finite number.")
            checked.append({"cell": _cell(cell.get("cell")), "value": value})
        if len({entry["cell"] for entry in checked}) != len(checked):
            raise ToolError("Duplicate cell addresses in the same request.")
        return {"cells": checked}
    slides = args.get("slides")
    if slides is None:
        slides = [{"title": args.get("title"), "body": args.get("text", "")}]
    if not isinstance(slides, list) or not 1 <= len(slides) <= 20:
        raise ToolError("PowerPoint creation requires 1–20 slides.")
    if any(not isinstance(slide, dict) for slide in slides):
        raise ToolError("Each slide must have a title and body.")
    return {"slides": [
        {"title": _text(slide.get("title"), "title", required=True)[:300],
         "body": _text(slide.get("body", ""), "body")[:5000]}
        for slide in slides
    ]}


def _validate_edit(kind: str, args: Dict[str, Any]) -> Dict[str, Any]:
    action = str(args.get("action") or "").strip().lower()
    allowed = {
        "text": {"append_text", "replace_text"},
        "word": {"append_text", "replace_text", "set_font_size"},
        "excel": {"set_cell", "set_font_size"},
        "powerpoint": {"add_slide", "set_font_size"},
    }
    if action not in allowed[kind]:
        raise ToolError(f"Unsupported {kind} edit; allowed: {', '.join(sorted(allowed[kind]))}.")
    edit: Dict[str, Any] = {"action": action}
    if action in {"append_text", "replace_text"}:
        edit["text"] = _text(args.get("text"), "text", required=True)
    if action == "replace_text" or kind == "word" and action == "set_font_size":
        edit["find"] = _text(args.get("find"), "find", required=True)
    if action in {"set_cell", "set_font_size"} and kind == "excel":
        edit["cell"] = _cell(args.get("cell"))
    if action == "set_cell":
        value = args.get("value")
        if isinstance(value, str):
            edit["value"] = _text(value, "value")
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e15:
            raise ToolError("Cell value must be bounded text or a finite number.")
        else:
            edit["value"] = value
    if action == "set_font_size":
        edit["font_size"] = _font_size(args.get("font_size"))
    if kind == "powerpoint":
        slide = args.get("slide")
        if action == "add_slide":
            edit["title"] = _text(args.get("title"), "title", required=True)[:300]
            edit["body"] = _text(args.get("text", ""), "text")[:5000]
        else:
            if not isinstance(slide, int) or isinstance(slide, bool) or slide < 1 or slide > 1000:
                raise ToolError("PowerPoint slide must be a 1-based index.")
            edit["slide"] = slide
            target = str(args.get("target") or "body").lower()
            if target not in {"body", "title"}:
                raise ToolError("PowerPoint font target must be 'title' or 'body'.")
            edit["target"] = target
    return edit


def _inspect(p: Path, kind: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if kind == "text":
        text = p.read_text(encoding="utf-8")
        if len(text) > MAX_TEXT:
            raise ToolError("Text document exceeds the inspection limit.")
        return {"text": text}
    from .office_com import inspect_document
    return inspect_document(p, kind, args)


def _same_cell(actual: Any, expected: Any) -> bool:
    if isinstance(expected, (int, float)):
        try:
            return actual is not None and float(actual) == float(expected)
        except (TypeError, ValueError):
            return False
    return str(actual) == str(expected)


def _compare(kind: str, action: str, expected: Dict[str, Any], observed: Dict[str, Any], before: Dict[str, Any] | None = None) -> bool:
    if action == "create":
        if kind in {"text", "word"}:
            return expected["text"] in observed.get("text", "")
        if kind == "excel":
            return all(_same_cell(observed.get("cells", {}).get(item["cell"]), item["value"]) for item in expected["cells"])
        return all(item == found for item, found in zip(expected["slides"], observed.get("slides", []))) and len(expected["slides"]) == len(observed.get("slides", []))
    if action == "append_text":
        return observed.get("text", "").startswith(before.get("text", "") if before else "") and observed.get("text", "").endswith(expected["text"])
    if action == "replace_text":
        prior = before.get("text", "") if before else ""
        return prior.count(expected["find"]) == 1 and observed.get("text", "") == prior.replace(expected["find"], expected["text"], 1)
    if action == "set_cell":
        return _same_cell(observed.get("cells", {}).get(expected["cell"]), expected["value"])
    if action == "add_slide":
        slides = observed.get("slides", [])
        return len(slides) == len(before.get("slides", []) if before else []) + 1 and slides[-1] == {"title": expected["title"], "body": expected["body"]}
    if action == "set_font_size":
        return observed.get("font_size") == expected["font_size"]
    return False


def _result(p: Path, kind: str, action: str, observed: Dict[str, Any], backup: Path | None = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {"ok": True, "verified": True, "verification_method": "reopened_saved_document",
                              "path": str(p), "kind": kind, "action": action, "sha256": _hash(p),
                              "size": p.stat().st_size, "result": f"Verified {action} of {kind} document at {p}."}
    if backup:
        result["backup_path"] = str(backup)
    if action == "inspect":
        result["observation"] = observed
        # Bound response; never include the whole file in routine write results.
        result.update(observed)
    return result


@register("saraDocumentCreate")
def document_create(args: Dict[str, Any]) -> Dict[str, Any]:
    p, kind = _path(args, must_exist=False)
    expected = _validate_create(kind, args)
    _office_available(kind)
    if p.exists():
        raise ToolError(f"Document already exists: {p}. SARA will not overwrite it.")
    p.parent.mkdir(parents=True, exist_ok=True)
    if kind == "text":
        with p.open("x", encoding="utf-8") as output:
            output.write(expected["text"])
            output.flush()
            os.fsync(output.fileno())
    else:
        temp = p.with_name(f".{p.stem}.sara-work-{uuid.uuid4().hex}{p.suffix}")
        try:
            from .office_com import create_document
            create_document(temp, kind, expected)
            if not temp.is_file() or not _compare(kind, "create", expected, _inspect(temp, kind, expected)):
                raise ToolError("Office did not save the requested content; destination was not created.")
            if p.exists():
                raise ToolError("Destination appeared during creation; the existing file was not overwritten.")
            os.rename(temp, p)  # Windows refuses an existing destination; no overwrites
        finally:
            if temp.exists():
                temp.unlink()
    observed = _inspect(p, kind, expected)
    if not _compare(kind, "create", expected, observed):
        raise ToolError("Saved document could not be verified after reopening; do not claim completion.")
    return _result(p, kind, "create", observed)


@register("saraDocumentInspect")
def document_inspect(args: Dict[str, Any]) -> Dict[str, Any]:
    p, kind = _path(args, must_exist=True)
    _office_available(kind)
    observed = _inspect(p, kind, args)
    return _result(p, kind, "inspect", observed)


@register("saraDocumentEdit")
def document_edit(args: Dict[str, Any]) -> Dict[str, Any]:
    p, kind = _path(args, must_exist=False)
    edit = _validate_edit(kind, args)
    _office_available(kind)
    if not p.is_file():
        raise ToolError(f"Document does not exist: {p}")
    original_hash = _hash(p)
    if args.get("expected_sha256") and args["expected_sha256"] != original_hash:
        raise ToolError("Document changed since inspection. Reopen and review it before editing.")
    inspect_args = {**edit, "cells": [{"cell": edit["cell"]}] if "cell" in edit else []}
    if kind == "word" and edit["action"] != "set_font_size":
        inspect_args.pop("find", None)  # replaced text need not remain present
    before = _inspect(p, kind, inspect_args)
    if kind == "powerpoint" and edit["action"] == "add_slide" and before.get("slide_count", 0) >= 20:
        raise ToolError("Cannot add a slide beyond the bounded 20-slide verification limit.")
    if edit["action"] == "replace_text" and before.get("text", "").count(edit["find"]) != 1:
        raise ToolError("The target text must occur exactly once before replacement; no change was made.")
    if edit["action"] == "set_font_size" and kind == "word" and before.get("text", "").count(edit["find"]) != 1:
        raise ToolError("The font-size target must occur exactly once in this Word document.")
    backup = p.with_name(f".{p.stem}.sara-backup-{uuid.uuid4().hex[:10]}{p.suffix}")
    work = p.with_name(f".{p.stem}.sara-work-{uuid.uuid4().hex}{p.suffix}")
    shutil.copy2(p, backup)  # intentional user-visible recovery copy
    try:
        shutil.copy2(p, work)
        if kind == "text":
            old = before["text"]
            updated = old + edit["text"] if edit["action"] == "append_text" else old.replace(edit["find"], edit["text"], 1)
            with work.open("w", encoding="utf-8") as output:
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
        else:
            from .office_com import edit_document
            edit_document(work, kind, edit)
        observed = _inspect(work, kind, inspect_args)
        if not _compare(kind, edit["action"], edit, observed, before):
            raise ToolError("The edited copy did not pass read-back verification; original is unchanged.")
        if _hash(p) != original_hash:
            raise ToolError("Document changed during editing; original was not replaced.")
        os.replace(work, p)
        observed = _inspect(p, kind, inspect_args)
        if not _compare(kind, edit["action"], edit, observed, before):
            raise ToolError(f"Could not verify the saved edit. Recovery copy: {backup}")
        return _result(p, kind, edit["action"], observed, backup)
    finally:
        if work.exists():
            work.unlink()


@register("saraDocumentOpen")
def document_open(args: Dict[str, Any]) -> Dict[str, Any]:
    p, kind = _path(args, must_exist=False)
    _office_available(kind)
    if not p.is_file():
        raise ToolError(f"Document does not exist: {p}")
    if kind == "text":
        if platform.system() != "Windows":
            raise ToolError("Opening a text editor requires an interactive Windows desktop here; file was not opened.")
        from .window_manager import WINDOW_MANAGER
        try:
            subprocess.Popen(["notepad.exe", str(p)], close_fds=True)
        except OSError as error:
            raise ToolError(f"Notepad could not open this text file: {error}") from error
        observed = {}
        for _ in range(12):
            for window in WINDOW_MANAGER.list_windows():
                if (window.get("visible") and str(window.get("process_name", "")).lower() == "notepad.exe"
                        and p.stem.lower() in str(window.get("title", "")).lower()):
                    observed = {"full_name": str(p), "window_title": window["title"]}
                    break
            if observed:
                break
            time.sleep(0.25)
        if not observed:
            raise ToolError("Notepad was launched but a window for this text file was not observed.")
    else:
        from .office_com import open_document
        observed = open_document(p, kind)
    if observed.get("full_name", "").lower() != str(p).lower() or not observed.get("window_title"):
        raise ToolError("Office opened a document but the target window could not be verified.")
    return {"ok": True, "verified": True, "verification_method": "office_active_document_and_window",
            "action": "open", "path": str(p), "kind": kind, **observed,
            "result": f"Opened {p.name} in {'Notepad' if kind == 'text' else 'Microsoft ' + kind.title()} (window observed)."}
