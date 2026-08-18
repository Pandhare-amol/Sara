from __future__ import annotations

import os
import unittest


@unittest.skipUnless(os.environ.get("SARA_WINDOWS_ACCEPTANCE") == "1", "Windows live acceptance disabled")
class WindowsSemanticAcceptanceTest(unittest.TestCase):
    def test_placeholder(self) -> None:
        self.assertTrue(True)

