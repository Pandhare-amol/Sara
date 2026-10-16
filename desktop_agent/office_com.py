"""Microsoft Office COM adapter, imported only on Windows desktop operations.

No shell commands, macros, arbitrary COM method names, or OfficeScript are
accepted from the caller. Each save is reopened with a fresh COM instance by
tools_documents before completion is reported. Real Office acceptance testing
requires an opt-in Windows machine with installed Office and an active desktop.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator

from .registry import ToolError

PROG_IDS = {"word": "Word.Application", "excel": "Excel.Application", "powerpoint": "PowerPoint.Application"}


@contextmanager
def _application(kind: str) -> Iterator[Any]:
    try:
        import pythoncom
        from win32com.client import DispatchEx
    except ImportError as error:
        raise ToolError("Microsoft Office automation needs pywin32 and an installed Windows Office application.") from error
    pythoncom.CoInitialize()
    app = None
    try:
        try:
            app = DispatchEx(PROG_IDS[kind])
            # Never run macros/events in a document supplied by a tool call.
            app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
            if kind in {"word", "excel"}:
                app.Visible = False
                app.DisplayAlerts = 0
            if kind == "excel":
                app.EnableEvents = False
        except Exception as error:
            raise ToolError(f"Could not start a macro-disabled Microsoft {kind} session: {error}") from error
        yield app
    finally:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        pythoncom.CoUninitialize()


def _open(app: Any, path: Path, kind: str, *, readonly: bool) -> Any:
    if kind == "word":
        return app.Documents.Open(str(path), ConfirmConversions=False, ReadOnly=readonly,
                                  AddToRecentFiles=False, Visible=False, OpenAndRepair=False)
    if kind == "excel":
        return app.Workbooks.Open(str(path), UpdateLinks=0, ReadOnly=readonly,
                                  AddToMru=False, IgnoreReadOnlyRecommended=True)
    return app.Presentations.Open(str(path), ReadOnly=readonly, Untitled=False, WithWindow=False)


def _close(document: Any) -> None:
    try:
        document.Close(SaveChanges=False)
    except TypeError:
        document.Close()


def _text_cell(sheet: Any, item: Dict[str, Any]) -> None:
    target = sheet.Range(item["cell"])
    value = item["value"]
    if isinstance(value, str):
        # Text format before assignment prevents formula execution, including
        # strings beginning with '=', '+', '-', or '@'.
        target.NumberFormat = "@"
    target.Value2 = value
    if isinstance(value, str) and bool(target.HasFormula):
        raise ToolError("Excel interpreted this text as a formula; no change was saved.")


def _add_slide(presentation: Any, title: str, body: str) -> None:
    slide = presentation.Slides.Add(presentation.Slides.Count + 1, 2)  # ppLayoutText
    slide.Shapes.Title.TextFrame.TextRange.Text = title
    slide.Shapes.Placeholders(2).TextFrame.TextRange.Text = body


def create_document(path: Path, kind: str, expected: Dict[str, Any]) -> None:
    with _application(kind) as app:
        if kind == "word":
            document = app.Documents.Add()
            try:
                document.Content.Text = expected["text"]
                document.SaveAs2(str(path), FileFormat=16)  # wdFormatXMLDocument (.docx)
            finally:
                _close(document)
        elif kind == "excel":
            document = app.Workbooks.Add()
            try:
                sheet = document.Worksheets(1)
                for cell in expected["cells"]:
                    _text_cell(sheet, cell)
                document.SaveAs(str(path), FileFormat=51)  # xlOpenXMLWorkbook (.xlsx)
            finally:
                _close(document)
        else:
            document = app.Presentations.Add(WithWindow=False)
            try:
                for slide in expected["slides"]:
                    _add_slide(document, slide["title"], slide["body"])
                document.SaveAs(str(path), 24)  # ppSaveAsOpenXMLPresentation (.pptx)
            finally:
                _close(document)


def _word_find(document: Any, text: str) -> Any:
    search = document.Content.Duplicate
    if not search.Find.Execute(FindText=text, Forward=True, Wrap=0):
        raise ToolError("The requested text is not present in the Word document.")
    return search


def edit_document(path: Path, kind: str, edit: Dict[str, Any]) -> None:
    with _application(kind) as app:
        document = _open(app, path, kind, readonly=False)
        try:
            action = edit["action"]
            if kind == "word":
                if action == "append_text":
                    document.Content.InsertAfter(edit["text"])
                elif action == "replace_text":
                    _word_find(document, edit["find"]).Text = edit["text"]
                elif action == "set_font_size":
                    _word_find(document, edit["find"]).Font.Size = edit["font_size"]
            elif kind == "excel":
                cell = document.Worksheets(1).Range(edit["cell"])
                if action == "set_cell":
                    _text_cell(document.Worksheets(1), edit)
                elif action == "set_font_size":
                    cell.Font.Size = edit["font_size"]
            elif action == "add_slide":
                _add_slide(document, edit["title"], edit["body"])
            elif action == "set_font_size":
                slide = document.Slides(edit["slide"])
                shape = slide.Shapes.Title if edit["target"] == "title" else slide.Shapes.Placeholders(2)
                shape.TextFrame.TextRange.Font.Size = edit["font_size"]
            document.Save()
        finally:
            _close(document)


def inspect_document(path: Path, kind: str, args: Dict[str, Any]) -> Dict[str, Any]:
    with _application(kind) as app:
        document = _open(app, path, kind, readonly=True)
        try:
            if kind == "word":
                text = str(document.Content.Text).rstrip("\r")
                result: Dict[str, Any] = {"text": text}
                if args.get("find"):
                    result["font_size"] = float(_word_find(document, args["find"]).Font.Size)
                return result
            if kind == "excel":
                cells = args.get("cells") or ([{"cell": args["cell"]}] if args.get("cell") else [])
                sheet = document.Worksheets(1)
                result = {"cells": {item["cell"]: sheet.Range(item["cell"]).Value2 for item in cells}}
                if args.get("cell"):
                    result["font_size"] = float(sheet.Range(args["cell"]).Font.Size)
                return result
            slides = []
            for index in range(1, min(document.Slides.Count, 20) + 1):
                slide = document.Slides(index)
                title = str(slide.Shapes.Title.TextFrame.TextRange.Text)
                body = str(slide.Shapes.Placeholders(2).TextFrame.TextRange.Text)
                slides.append({"title": title, "body": body})
            result = {"slides": slides, "slide_count": document.Slides.Count}
            if args.get("slide"):
                slide = document.Slides(args["slide"])
                shape = slide.Shapes.Title if args.get("target") == "title" else slide.Shapes.Placeholders(2)
                result["font_size"] = float(shape.TextFrame.TextRange.Font.Size)
            return result
        finally:
            _close(document)


def open_document(path: Path, kind: str) -> Dict[str, Any]:
    """Open a separate, visible Office instance. The user owns the window after return."""
    try:
        import pythoncom
        from win32com.client import DispatchEx
    except ImportError as error:
        raise ToolError("Microsoft Office automation needs pywin32 and installed Office.") from error
    pythoncom.CoInitialize()
    app = None
    try:
        app = DispatchEx(PROG_IDS[kind])
        app.AutomationSecurity = 3
        if kind == "excel":
            app.EnableEvents = False
            app.AskToUpdateLinks = False
        app.Visible = True
        document = _open_visible(app, path, kind)
        full_name = str(document.FullName)
        if Path(full_name).resolve() != path.resolve():
            raise ToolError("Office active document does not match the requested file.")
        # A window caption is not proof that the OS foreground was changed, but
        # it identifies a visible Office document window, not a browser tab.
        window_title = str(app.ActiveWindow.Caption) if app.Windows.Count > 0 else ""
        if not window_title:
            raise ToolError("Office did not create a visible document window.")
        return {"full_name": full_name, "window_title": window_title}
    except Exception:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        raise
    finally:
        pythoncom.CoUninitialize()


def _open_visible(app: Any, path: Path, kind: str) -> Any:
    if kind == "word":
        return app.Documents.Open(str(path), ReadOnly=False, AddToRecentFiles=False,
                                  ConfirmConversions=False, Visible=True, OpenAndRepair=False)
    if kind == "excel":
        return app.Workbooks.Open(str(path), UpdateLinks=0, ReadOnly=False,
                                  AddToMru=False, IgnoreReadOnlyRecommended=True)
    return app.Presentations.Open(str(path), ReadOnly=False, Untitled=False, WithWindow=True)
