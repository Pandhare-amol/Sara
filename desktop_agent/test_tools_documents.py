"""Document operations: real file effects on this host, Office refusal off Windows."""
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent.registry import ToolError


class DocumentsTest(unittest.TestCase):
    def setUp(self) -> None:
        from desktop_agent import tools_documents
        self.tools = tools_documents
        self.temp = tempfile.TemporaryDirectory(prefix=".sara-documents-", dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    def test_text_create_inspect_append_replace_and_safe_backup(self) -> None:
        file = self.path / "notes.txt"
        created = self.tools.document_create({"path": str(file), "text": "Hello world"})
        self.assertTrue(created["verified"])
        self.assertEqual(file.read_text(encoding="utf8"), "Hello world")
        with self.assertRaises(ToolError):
            self.tools.document_create({"path": str(file), "text": "Lost content"})
        sha = hashlib.sha256(file.read_bytes()).hexdigest()
        edited = self.tools.document_edit({"path": str(file), "action": "replace_text", "find": "world",
                                           "text": "SARA", "expected_sha256": sha})
        self.assertTrue(edited["verified"])
        self.assertEqual(file.read_text(encoding="utf8"), "Hello SARA")
        self.assertEqual(Path(edited["backup_path"]).read_text(encoding="utf8"), "Hello world")
        with self.assertRaises(ToolError):
            self.tools.document_edit({"path": str(file), "action": "append_text", "text": " mistake", "expected_sha256": sha})
        self.assertEqual(file.read_text(encoding="utf8"), "Hello SARA")
        appended = self.tools.document_edit({"path": str(file), "action": "append_text", "text": "!"})
        self.assertTrue(appended["verified"])
        self.assertEqual(self.tools.document_inspect({"path": str(file)})["text"], "Hello SARA!")

    def test_ambiguous_edit_and_unsupported_or_external_paths_fail_closed(self) -> None:
        file = self.path / "repeat.txt"
        file.write_text("one one", encoding="utf8")
        with self.assertRaisesRegex(ToolError, "exactly once"):
            self.tools.document_edit({"path": str(file), "action": "replace_text", "find": "one", "text": "two"})
        self.assertEqual(file.read_text(encoding="utf8"), "one one")
        with self.assertRaises(ToolError):
            self.tools.document_create({"path": str(self.path / "macro.docm"), "text": "no"})
        with patch.object(self.tools, "_ensure_safe", side_effect=ToolError("Unsafe path")):
            with self.assertRaisesRegex(ToolError, "Unsafe path"):
                self.tools.document_create({"path": str(self.path / "bad.txt"), "text": "no"})

    def test_office_requires_installed_windows_office_not_a_fake_success(self) -> None:
        file = self.path / "report.docx"
        with patch.object(self.tools.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(ToolError, "Windows.*Office"):
                self.tools.document_create({"path": str(file), "text": "actual text"})
            with self.assertRaisesRegex(ToolError, "Windows.*Office"):
                self.tools.document_open({"path": str(file)})
        self.assertFalse(file.exists())

    def test_mocked_word_excel_powerpoint_pipeline_checks_saved_content_and_font_size(self) -> None:
        # These mocks exercise routing/read-back only, NOT live Windows Office.
        from desktop_agent import office_com
        word = self.path / "report.docx"
        word.write_bytes(b"PK\\x03\\x04" + b"Heading" * 20)
        font_size = {"value": 11.0}
        with patch.object(self.tools.platform, "system", return_value="Windows"), \
             patch.object(office_com, "inspect_document", side_effect=lambda path, kind, args: {
                 "text": "Heading", "font_size": font_size["value"]
             }), \
             patch.object(office_com, "edit_document", side_effect=lambda path, kind, edit: font_size.update(value=edit["font_size"])) as edit:
            result = self.tools.document_edit({"path": str(word), "action": "set_font_size",
                                               "find": "Heading", "font_size": 14})
        self.assertTrue(result["verified"])
        self.assertEqual(Path(result["backup_path"]).read_bytes(), word.read_bytes())
        edit.assert_called_once()
        self.assertEqual(edit.call_args.args[2]["font_size"], 14)

        spreadsheet = self.path / "budget.xlsx"
        slides = self.path / "briefing.pptx"
        with patch.object(self.tools.platform, "system", return_value="Windows"), \
             patch.object(office_com, "create_document", side_effect=lambda path, kind, _: path.write_bytes(b"PK\\x03\\x04" + b"native mock")), \
             patch.object(office_com, "inspect_document", side_effect=lambda path, kind, args: (
                 {"cells": {"B2": 42.0}} if kind == "excel" else {"slides": [{"title": "Briefing", "body": "Overview"}]}
             )):
            self.assertTrue(self.tools.document_create({"path": str(spreadsheet), "cells": [{"cell": "B2", "value": 42}]})["verified"])
            self.assertTrue(self.tools.document_create({"path": str(slides), "slides": [{"title": "Briefing", "body": "Overview"}]})["verified"])
        self.assertTrue(spreadsheet.exists())
        self.assertTrue(slides.exists())

    def test_excel_cell_and_font_are_validated_before_touching_app(self) -> None:
        for cell in ("A0", "A1048577", "XFE1", "A1:B2", "=HYPERLINK(A1)"):
            with self.subTest(cell=cell), self.assertRaises(ToolError):
                self.tools.document_create({"path": str(self.path / "budget.xlsx"),
                                            "cells": [{"cell": cell, "value": "42"}]})
        with self.assertRaises(ToolError):
            self.tools.document_edit({"path": str(self.path / "budget.xlsx"), "action": "set_font_size",
                                      "cell": "B1", "font_size": "Word"})


if __name__ == "__main__":
    unittest.main()
