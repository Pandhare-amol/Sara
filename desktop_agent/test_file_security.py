import tempfile
import unittest
import zipfile
from pathlib import Path

from .tools_file_extra import extract_zip
from .registry import ToolError


class FileSecurityTest(unittest.TestCase):
    def test_extract_zip_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            archive = root / "unsafe.zip"
            destination = root / "out"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../../escaped.txt", "blocked")

            with self.assertRaises(ToolError):
                extract_zip({"path": str(archive), "destination": str(destination), "allow_anywhere": True})

            self.assertFalse((root / "escaped.txt").exists())


if __name__ == "__main__":
    unittest.main()